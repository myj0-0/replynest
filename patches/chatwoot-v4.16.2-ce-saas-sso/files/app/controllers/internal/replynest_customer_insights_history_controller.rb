# frozen_string_literal: true
module Internal
  # Dedicated default-off read purpose. Shares only the bounded read-only SQL
  # extractor, NOT the old context/style/knowledge-draft business consent.
  class ReplynestCustomerInsightsHistoryController < ReplynestReceptionHistoryController
    # Metadata-only current native membership/assignment. No messages, writes,
    # grant creation or model permission; business membership is checked too.
    def permission
      result=nil
      guarded_transaction do
        p=@payload
        raise ActiveRecord::RecordNotFound unless Account.exists?(id:p['account_id'],status:'active') &&
          AccountUser.exists?(account_id:p['account_id'],user_id:p['native_actor_id']) &&
          User.where(id:p['native_actor_id']).where('lower(email)=?',p['native_actor_email']).exists?
        c=Conversation.find_by(account_id:p['account_id'],display_id:p['conversation_id'],contact_id:p['contact_id'])
        raise ActiveRecord::RecordNotFound unless c && Contact.exists?(id:c.contact_id,account_id:c.account_id) &&
          Inbox.exists?(id:c.inbox_id,account_id:c.account_id,channel_type:['Channel::Api','Channel::WebWidget']) &&
          ContactInbox.exists?(id:c.contact_inbox_id,inbox_id:c.inbox_id,contact_id:c.contact_id)
        result={account_id:p['account_id'],conversation_id:p['conversation_id'],contact_id:p['contact_id'],
          native_actor_id:p['native_actor_id'],assigned:c.assignee_id.to_s==p['native_actor_id'],
          request_sha256:Digest::SHA256.hexdigest(request.raw_post)}
      end
      render json:result
    rescue ActiveRecord::RecordNotFound
      render json:{error:'identity_unavailable'},status: :not_found
    end
    private
    def validate_payload!
      return super unless action_name=='permission'
      raw=request.raw_post
      db=ActiveRecord::Base.connection
      raise ArgumentError unless db.select_value("SELECT #{db.quote(raw)} IS JSON OBJECT WITH UNIQUE KEYS")
      @payload=JSON.parse(raw)
      id=lambda { |v| v.is_a?(String) && v.match?(/\A[1-9]\d{0,18}\z/) && v.to_i<=9_223_372_036_854_775_807 }
      raise ArgumentError unless @payload.keys.sort==%w[account_id contact_id conversation_id native_actor_email native_actor_id purpose] &&
        %w[account_id conversation_id contact_id native_actor_id].all? { |k|id.call(@payload[k]) } && @payload['purpose']=='customerInsights' &&
        @payload['native_actor_email'].is_a?(String) && @payload['native_actor_email'].bytesize<=320 &&
        @payload['native_actor_email'].match?(/\A[^\s@]+@[^\s@]+\.[^\s@]+\z/) && @payload['native_actor_email']==@payload['native_actor_email'].downcase
    rescue JSON::ParserError,ArgumentError,TypeError
      render json:{error:'invalid_payload'},status: :unprocessable_entity
    end
    def transport_enabled?
      ENV['REPLYNEST_CUSTOMER_INSIGHTS_HISTORY_ENABLED'] == 'true'
    end
    def history_purposes
      %w[customerInsights]
    end
    def history_order
      :asc
    end
    def payload_keys
      super + %w[after event_ids]
    end
    def validate_additional_payload!
      ids = @payload['event_ids']
      raise ArgumentError unless ids.is_a?(Array) && ids.length<=100 && ids.uniq.length==ids.length &&
        ids.all? { |v| v.is_a?(String) && v.match?(/\A[1-9]\d{0,18}\z/) && v.to_i<=9_223_372_036_854_775_807 }
      @after = @payload['after']
      if @after
        raise ArgumentError unless @after.is_a?(Hash) && @after.keys.sort==%w[created_at message_id] &&
          @after['message_id'].is_a?(String) && @after['message_id'].match?(/\A[1-9]\d{0,18}\z/) && @after['message_id'].to_i<=9_223_372_036_854_775_807 &&
          @after['created_at'].is_a?(String) && @after['created_at'].match?(/\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\z/)
        at = Time.iso8601(@after['created_at'])
        raise ArgumentError unless at.utc.iso8601(6)==@after['created_at'] && at<=@as_of
      end
    end
    def history_start(scope)
      return scope unless @after
      # Chatwoot v4.16 may still use int4 message IDs. Cast the comparison
      # boundary, not the indexed column: a max-bigint checkpoint must remain
      # legal without coercing it into int4 or disabling the keyset index.
      scope.where('(created_at,id) > (?::timestamptz,?::bigint) OR id = ANY (?::bigint[])',
        @after.fetch('created_at'), @after.fetch('message_id'), '{' + @payload.fetch('event_ids').join(',') + '}')
    end
  end
end
