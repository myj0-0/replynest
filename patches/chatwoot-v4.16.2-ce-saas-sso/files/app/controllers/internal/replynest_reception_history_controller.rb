# frozen_string_literal: true
module Internal
  # Read-only, separately gated history RPC. The gateway must check the exact
  # business history-purpose grant before AND after this signed native request.
  # Transport signatures are not tenant/user consent and never authorize a model.
  class ReplynestReceptionHistoryController < ReplynestAutomaticRepliesController
    MAX_SCAN = 200
    def page
      result = nil
      guarded_transaction do
        db = ActiveRecord::Base.connection
        raise ActiveRecord::RecordNotFound unless Account.exists?(id: @payload['account_id'], status: 'active')
        # Page metadata only first, under a hard scan budget. Never offset/COUNT
        # or load all conversations; the cursor advances even if rows are omitted.
        scope = Message.unscoped.where(account_id: @payload['account_id'], private: false, message_type: [0, 1], content_type: 0)
          .where('created_at >= ? AND created_at <= ?', @as_of - 30.days, @as_of)
        if @payload['purpose'] == 'style'
          scope = scope.where(message_type: 1, sender_type: 'User')
        end
        unless @payload['contact_ids'].empty?
          scope = scope.where(conversation_id: Conversation.where(account_id: @payload['account_id'], contact_id: @payload['contact_ids']).select(:id))
        end
        scope = history_start(scope)
        if @cursor
          scope = scope.where("(created_at,id) #{history_order == :asc ? '>' : '<'} (?::timestamptz,?::bigint)", @cursor.fetch('created_at'), @cursor.fetch('message_id'))
        end
        candidates = scope.reorder(created_at: history_order, id: history_order).limit(MAX_SCAN + 1).pluck(:id, :created_at)
        selected = candidates.first(MAX_SCAN)
        rows = []
        unless selected.empty?
          # Fixed v4.16.2 enum literals. All joins re-check account/inbox/contact
          # ownership, public state and human authorship at extraction time.
          ids = selected.map { |id, _| Integer(id) }.join(',')
          account = db.quote(@payload['account_id'])
          purpose = @payload['purpose'] == 'style' ? "AND m.message_type=1 AND m.sender_type='User'" : ''
          contacts = @payload['contact_ids'].empty? ? '' : "AND c.contact_id IN(#{@payload['contact_ids'].map { |id| db.quote(id) }.join(',')})"
          rows = db.select_all(<<~SQL).to_a
            SELECT m.id::text AS message_id,c.display_id::text AS conversation_id,
             m.account_id::text AS account_id,c.contact_id::text AS contact_id,m.inbox_id::text AS inbox_id,
             to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
             CASE m.message_type WHEN 0 THEN 'incoming' ELSE 'outgoing' END AS direction,
             CASE m.message_type WHEN 0 THEN 'customer' ELSE 'human' END AS author_kind,m.content AS text
            FROM messages m JOIN conversations c ON c.id=m.conversation_id AND c.account_id=m.account_id AND c.inbox_id=m.inbox_id
             JOIN contacts ct ON ct.id=c.contact_id AND ct.account_id=m.account_id
             JOIN inboxes i ON i.id=m.inbox_id AND i.account_id=m.account_id
             JOIN contact_inboxes ci ON ci.id=c.contact_inbox_id AND ci.contact_id=c.contact_id AND ci.inbox_id=m.inbox_id
             CROSS JOIN LATERAL (SELECT CASE
              WHEN m.content_attributes IS NULL THEN '{}'::jsonb
              WHEN jsonb_typeof(m.content_attributes::jsonb)='object' THEN m.content_attributes::jsonb
              WHEN jsonb_typeof(m.content_attributes::jsonb)='string' AND
               (m.content_attributes::jsonb #>> '{}') IS JSON OBJECT WITH UNIQUE KEYS
               THEN (m.content_attributes::jsonb #>> '{}')::jsonb
              ELSE NULL END AS attrs) safe
            WHERE m.account_id=#{account} AND m.id IN(#{ids}) AND m.private=false AND m.content_type=0
             AND m.message_type IN(0,1) AND m.status IN(0,1,2) AND i.channel_type IN('Channel::Api','Channel::WebWidget')
             AND m.created_at>=#{db.quote(@as_of - 30.days)} AND m.created_at<=#{db.quote(@as_of)}
             AND m.content IS NOT NULL AND char_length(m.content) BETWEEN 1 AND 2000 AND octet_length(m.content)<=8000
             AND safe.attrs IS NOT NULL AND NOT (safe.attrs ?| ARRAY['deleted','replynest_command_id','replynest_transport','ai_generated','is_ai_generated','replynest_ai_draft'])
             AND NOT EXISTS(SELECT 1 FROM attachments a WHERE a.message_id=m.id)
             AND ((m.message_type=0 AND m.sender_type='Contact' AND m.sender_id=c.contact_id)
              OR (m.message_type=1 AND m.sender_type='User' AND EXISTS(SELECT 1 FROM account_users au WHERE au.account_id=m.account_id AND au.user_id=m.sender_id)))
             #{purpose} #{contacts}
            ORDER BY m.created_at #{history_order == :asc ? 'ASC' : 'DESC'},m.id #{history_order == :asc ? 'ASC' : 'DESC'}
          SQL
          rows.reject! { |row| row['text'].blank? || !row['text'].valid_encoding? || row['text'].include?("\0") }
        end
        last = selected.last
        raise ActiveRecord::RecordNotFound unless Account.exists?(id: @payload['account_id'], status: 'active')
        next_cursor = candidates.length > MAX_SCAN ? { created_at: last[1].utc.iso8601(6), message_id: last[0].to_s } : nil
        result = { state: 'ready', request_sha256: Digest::SHA256.hexdigest(request.raw_post),
          account_id: @payload['account_id'], purpose: @payload['purpose'], grant_id: @payload['grant_id'],
          as_of: @payload['as_of'], scanned: selected.length, next_cursor: next_cursor, rows: rows }
        if history_order == :asc
          result[:scan_cursor] = last ? { created_at: last[1].utc.iso8601(6), message_id: last[0].to_s } : nil
          # A missing or future message is NOT acknowledged. These metadata-only
          # receipts allow filtered/media events to finish without a model call.
          result[:event_seen_ids] = Message.unscoped.where(account_id: @payload['account_id'], id: @payload.fetch('event_ids'))
            .where('created_at <= ?', @as_of).where(conversation_id: Conversation.where(account_id: @payload['account_id'], contact_id: @payload['contact_ids']).select(:id))
            # Under READ COMMITTED a text event may appear AFTER the candidate
            # query, even with an old created_at. Never acknowledge that unseen
            # text. Only scanned candidates or definitively out-of-scope types
            # /expired history can finish here; the next batch rescues late text.
            .where('id = ANY (?::bigint[]) OR private = true OR message_type NOT IN (0,1) OR content_type != 0 OR created_at < ?',
              '{' + selected.map { |id, _| id.to_s }.join(',') + '}', @as_of - 30.days)
            .limit(100).pluck(:id).map(&:to_s)
        end
      end
      render json: result
    end

    private
    def transport_enabled?
      ENV['REPLYNEST_RECEPTION_HISTORY_READ_ENABLED'] == 'true'
    end
    def history_purposes
      %w[context style knowledgeDraft]
    end
    def history_order
      :desc
    end
    def history_start(scope)
      scope
    end
    def payload_keys
      %w[account_id as_of contact_ids cursor grant_id purpose]
    end
    def validate_additional_payload!
      nil
    end
    def validate_payload!
      @payload = JSON.parse(request.raw_post)
      id = lambda { |v| v.is_a?(String) && v.match?(/\A[1-9]\d{0,18}\z/) && v.to_i<=9_223_372_036_854_775_807 }
      time = lambda do |v|
        raise ArgumentError unless v.is_a?(String) && v.match?(/\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\z/)
        parsed = Time.iso8601(v)
        raise ArgumentError unless parsed.utc.iso8601(6)==v
        parsed
      end
      raise ArgumentError unless @payload.is_a?(Hash) && @payload.keys.sort==payload_keys.sort &&
        id.call(@payload['account_id']) && history_purposes.include?(@payload['purpose']) &&
        @payload['grant_id'].is_a?(String) && @payload['grant_id'].match?(/\A[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\z/) &&
        @payload['contact_ids'].is_a?(Array) && @payload['contact_ids'].length<=8 && @payload['contact_ids'].uniq.length==@payload['contact_ids'].length &&
        @payload['contact_ids'].all? { |v| id.call(v) } && (!%w[context customerInsights].include?(@payload['purpose']) || !@payload['contact_ids'].empty?)
      @as_of = time.call(@payload['as_of'])
      raise ArgumentError unless @as_of <= Time.current+5.seconds && @as_of >= Time.current-5.minutes
      @cursor = @payload['cursor']
      if @cursor
        raise ArgumentError unless @cursor.is_a?(Hash) && @cursor.keys.sort==%w[created_at message_id] && id.call(@cursor['message_id'])
        at = time.call(@cursor['created_at'])
        raise ArgumentError unless at>=@as_of-30.days && at<=@as_of
      end
      validate_additional_payload!
    rescue JSON::ParserError, ArgumentError, TypeError
      render json: { error: 'invalid_payload' }, status: :unprocessable_entity
    end
  end
end
