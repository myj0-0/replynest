# frozen_string_literal: true
module Internal
  # Team-shared exact receipts. A lower-ID insert can commit after a higher-ID
  # read: neither a message ID nor a time watermark can represent visibility.
  class ReplynestWorkbenchReadController < ReplynestAutomaticRepliesController
    class Setup < ActiveRecord::Base
      self.table_name = 'replynest_workbench_read_setup'
    end
    def self.verify_storage!
      db = ActiveRecord::Base.connection
      raise 'workbench_read_not_ready' unless db.select_value("SELECT EXISTS(SELECT 1 FROM public.schema_migrations WHERE version='20261011000000')") && Setup.find_by(id: 1, state: 'ready')
      acl = db.select_one(<<~SQL)
        SELECT has_table_privilege(current_user,'public.replynest_workbench_read_receipts','SELECT') can_read,
          has_table_privilege(current_user,'public.replynest_workbench_read_receipts','INSERT') can_insert,
          has_table_privilege(current_user,'public.replynest_workbench_read_receipts','UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') dangerous,
          has_any_column_privilege(current_user,'public.replynest_workbench_read_receipts','UPDATE,REFERENCES') dangerous_columns,
          has_table_privilege(current_user,'public.replynest_workbench_read_setup','SELECT') setup_read,
          has_table_privilege(current_user,'public.replynest_workbench_read_setup','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') setup_write,
          has_any_column_privilege(current_user,'public.replynest_workbench_read_setup','INSERT,UPDATE,REFERENCES') setup_column_write,
          has_schema_privilege(current_user,'public','CREATE') schema_create
      SQL
      raise 'workbench_read_acl_invalid' unless acl == {'can_read'=>true,'can_insert'=>true,'dangerous'=>false,'dangerous_columns'=>false,
        'setup_read'=>true,'setup_write'=>false,'setup_column_write'=>false,'schema_create'=>false}
    end
    def control
      self.class.verify_storage!
      result = nil
      guarded_transaction do
        raise ActiveRecord::RecordNotFound unless Account.lock('FOR SHARE').find_by(id: @payload['account_id'], status: 'active')
        raise ActiveRecord::RecordNotFound unless AccountUser.lock('FOR SHARE').find_by(account_id: @payload['account_id'], user_id: @payload['native_actor_id'])
        rows = Conversation.where(account_id: @payload['account_id'], display_id: @payload['conversation_ids']).order(:id).lock('FOR SHARE').to_a
        raise ActiveRecord::RecordNotFound unless rows.length == @payload['conversation_ids'].length
        counts = rows.map do |c|
          # Fixed enum literals; bounded metadata-only reads over the native
          # conversation index. Private notes/outbound/activities never count.
          scope = Message.unscoped.where(account_id: c.account_id, conversation_id: c.id, inbox_id: c.inbox_id,
            message_type: 0, private: false, sender_type: 'Contact', sender_id: c.contact_id)
          scope = scope.where(<<~SQL)
            CASE WHEN content_attributes IS NULL THEN true
             WHEN jsonb_typeof(content_attributes::jsonb)='object' THEN NOT (content_attributes::jsonb ? 'deleted')
             WHEN jsonb_typeof(content_attributes::jsonb)='string' AND (content_attributes::jsonb #>> '{}') IS JSON OBJECT WITH UNIQUE KEYS
              THEN NOT ((content_attributes::jsonb #>> '{}')::jsonb ? 'deleted')
             ELSE false END
          SQL
          if @payload['operation'] == 'mark'
            ids = scope.where(id: @payload['message_ids']).lock('FOR SHARE').pluck(:id).map(&:to_s)
            raise ActiveRecord::RecordNotFound unless ids.sort == @payload['message_ids'].sort
            # Exact displayed IDs, not earlier invisible or late-committing rows.
            db = ActiveRecord::Base.connection
            values = ids.map { |id| "(#{c.account_id},#{c.id},#{db.quote(id)},'visible')" }.join(',')
            db.execute("INSERT INTO public.replynest_workbench_read_receipts(account_id,conversation_id,message_id,source) VALUES #{values} ON CONFLICT DO NOTHING")
          end
          unread = scope.where(<<~SQL)
            NOT EXISTS(SELECT 1 FROM public.replynest_workbench_read_receipts rr
             WHERE rr.account_id=messages.account_id AND rr.conversation_id=messages.conversation_id AND rr.message_id=messages.id OFFSET 0)
          SQL
          # Keep an exact PK probe for every candidate. Without the subquery
          # boundary, fresh migration statistics can flatten this into a nested
          # anti join that repeatedly scans ALL reads of this conversation and
          # leaves message_id as a join filter (quadratic in old read count).
          # OFFSET 0 changes no receipt semantics or query/lock timeout limits.
          ids = unread.reorder(id: :desc).limit(1001).pluck(:id)
          { conversation_id: c.display_id.to_s, unread_count: [ids.length,1000].min, capped: ids.length > 1000 }
        end
        result = { account_id: @payload['account_id'], operation: @payload['operation'],
          request_sha256: Digest::SHA256.hexdigest(request.raw_post), counts: counts }
      end
      render json: result
    rescue ActiveRecord::RecordNotFound
      render json: { error: 'identity_unavailable' }, status: :not_found
    end
    private
    def transport_enabled?
      ENV['REPLYNEST_WORKBENCH_READ_ENABLED'] == 'true'
    end
    def validate_payload!
      db = ActiveRecord::Base.connection
      raise ArgumentError unless db.select_value("SELECT #{db.quote(request.raw_post)} IS JSON OBJECT WITH UNIQUE KEYS")
      @payload = JSON.parse(request.raw_post)
      fields = %w[account_id native_actor_id operation conversation_ids]
      fields += %w[message_ids] if @payload.is_a?(Hash) && @payload['operation'] == 'mark'
      id = lambda { |v| v.is_a?(String) && v.match?(/\A[1-9]\d{0,18}\z/) && v.to_i <= 9_223_372_036_854_775_807 }
      bounded = lambda { |v| v.is_a?(Array) && v.length.between?(1,100) && v.uniq.length==v.length && v.all? { |x| id.call(x) } }
      raise ArgumentError unless @payload.is_a?(Hash) && @payload.keys.sort == fields.sort &&
        %w[stats mark].include?(@payload['operation']) && id.call(@payload['account_id']) && id.call(@payload['native_actor_id']) &&
        bounded.call(@payload['conversation_ids'])
      raise ArgumentError if @payload['operation'] == 'mark' && (@payload['conversation_ids'].length != 1 || !bounded.call(@payload['message_ids']))
    rescue JSON::ParserError, ArgumentError, TypeError
      render json: { error: 'invalid_payload' }, status: :unprocessable_entity
    end
  end
end
