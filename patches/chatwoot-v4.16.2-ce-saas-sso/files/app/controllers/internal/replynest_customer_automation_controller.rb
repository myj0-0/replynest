# frozen_string_literal: true
module Internal
  # Gateway resolves the tenant/customer and freshly checks the seat permission.
  # Same signature/nonce guard as automatic transport, not a public Chatwoot API.
  class ReplynestCustomerAutomationController < ReplynestAutomaticRepliesController
    class Event < ActiveRecord::Base
      self.table_name = 'replynest_customer_automation_pause_events'
    end
    def control
      result = nil
      guarded_transaction do
        account = Account.lock('FOR SHARE').find_by(id: @payload['account_id'], status: 'active')
        raise ActiveRecord::RecordNotFound unless account
        # The gateway's fresh role determines the signed scope. The native seat
        # and current conversation assignment are checked under row locks here,
        # not trusted from the earlier HTTP conversation snapshot.
        if @payload['operation'] != 'read'
          c = Conversation.lock('FOR UPDATE').find_by(account_id: account.id, display_id: @payload['conversation_id'], contact_id: @payload['contact_id'])
          member = AccountUser.lock('FOR SHARE').find_by(account_id: account.id, user_id: @payload['native_actor_id'])
          contact = Contact.lock('FOR SHARE').find_by(account_id: account.id, id: @payload['contact_id'])
          unless c && member && contact && (@payload['permission_scope'] == 'manager' || c.assignee_id.to_s == @payload['native_actor_id'])
            return render json: { error: 'pause_forbidden' }, status: :forbidden
          end
        end
        pause = customer_pause(account.id, @payload['customer_id'], 'FOR UPDATE')
        if @payload['operation'] != 'read'
          if pause.revision.to_s != @payload['revision']
            return render json: { error: 'pause_conflict' }, status: :conflict
          end
          until_time = @payload['operation'] == 'pause' ? @payload['minutes'].minutes.from_now : Time.current
          pause.update!(paused_until: until_time, revision: pause.revision + 1, updated_at: Time.current)
          Event.create!(account_id: account.id, customer_id: pause.customer_id, actor_id: @payload['actor_id'],
            request_id: @payload['request_id'], operation: @payload['operation'], revision: pause.revision,
            paused_until: until_time, created_at: Time.current)
        end
        result = { account_id: account.id.to_s, customer_id: pause.customer_id, revision: pause.revision.to_s,
          paused_until: pause.paused_until&.utc&.iso8601(6), paused: pause.paused_until.present? && pause.paused_until > Time.current }
      end
      render json: result
    end
    private
    def transport_enabled?
      ENV['REPLYNEST_ATOMIC_WEB_REPLY_ENABLED'] == 'true' || ENV['REPLYNEST_ATOMIC_WECHAT_REPLY_ENABLED'] == 'true'
    end
    def validate_payload!
      @payload = JSON.parse(request.raw_post)
      fields = %w[account_id customer_id operation]
      fields += %w[minutes revision actor_id request_id conversation_id contact_id native_actor_id permission_scope] unless @payload.is_a?(Hash) && @payload['operation'] == 'read'
      uuid = /\A[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\z/
      raise ArgumentError unless @payload.is_a?(Hash) && @payload.keys.sort == fields.sort &&
        @payload['account_id'].is_a?(String) && @payload['account_id'].match?(/\A[1-9]\d{0,18}\z/) &&
        @payload['account_id'].to_i <= 9_223_372_036_854_775_807 && @payload['customer_id'].is_a?(String) &&
        uuid.match?(@payload['customer_id']) && %w[read pause resume].include?(@payload['operation'])
      unless @payload['operation'] == 'read'
        raise ArgumentError unless (@payload['operation'] == 'pause' ? @payload['minutes'] == 10 : @payload['minutes'] == 0) &&
          @payload['revision'].is_a?(String) && @payload['revision'].match?(/\A\d{1,19}\z/) &&
          @payload['actor_id'].is_a?(String) && uuid.match?(@payload['actor_id']) &&
          %w[conversation_id contact_id native_actor_id].all? { |key| @payload[key].is_a?(String) && @payload[key].match?(/\A[1-9]\d{0,18}\z/) && @payload[key].to_i <= 9_223_372_036_854_775_807 } &&
          %w[manager assigned].include?(@payload['permission_scope']) &&
          @payload['request_id'].is_a?(String) && @payload['request_id'].bytesize.between?(1, 200) && !@payload['request_id'].include?("\0")
      end
    rescue JSON::ParserError, ArgumentError, TypeError
      render json: { error: 'invalid_payload' }, status: :unprocessable_entity
    end
  end
end
