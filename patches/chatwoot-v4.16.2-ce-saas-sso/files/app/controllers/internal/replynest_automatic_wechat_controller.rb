# frozen_string_literal: true

module Internal
  # No public outgoing message and no provider call here. This is the native
  # human-takeover linearization point, not a distributed/provider transaction.
  # After this permission commits, subsequent human activity cannot recall a
  # provider request already in flight. Gateway locks/checks its separate consent.
  class ReplynestAutomaticWechatController < ReplynestAutomaticRepliesController
    WECHAT_TARGET_KEYS = TARGET_KEYS + %w[provider contact_identifier source_event_id source_occurred_at]

    def snapshot
      result = { state: 'rejected' }
      guarded_transaction do
        c = scoped_conversation
        c&.with_lock do
          m = eligible_message(c)
          result = target_echo(c, m).merge(state: 'ready', question: m.content.strip, fence: fence_for(c, m)) if m && configured_actor(c.account_id)
        end
      end
      render json: result
    end

    def authorize
      command = @payload.fetch('command_id')
      digest = Digest::SHA256.hexdigest(request.raw_post)
      result = nil
      guarded_transaction do
        db = ActiveRecord::Base.connection
        db.execute("SELECT pg_advisory_xact_lock(hashtext(#{db.quote(command)}))")
        existing = Receipt.find_by(id: command)
        if existing
          result = existing.account_id.to_s == @payload['account_id'] && existing.request_digest == digest ?
            existing.result : { state: 'command_conflict', command_id: command }
        else
          result = { state: 'rejected', command_id: command }
          transport_actor_id = nil
          c = scoped_conversation
          c&.with_lock do
            m = eligible_message(c)
            if m && fence_for(c, m) == @payload['fence']
              used = Receipt.where(account_id: c.account_id, source_message_id: m.id)
                .where("result->>'state' IN ('accepted','transport_authorized')").exists?
              bot = configured_actor(c.account_id) unless used
              if bot
                transport_actor_id = bot.id
                result = target_echo(c, m).merge(state: 'transport_authorized', command_id: command,
                  provider: @payload['provider'], content_sha256: Digest::SHA256.hexdigest(@payload['content']),
                  binding_sha256: Digest::SHA256.hexdigest(JSON.generate(@payload.slice(*WECHAT_TARGET_KEYS))),
                  expires_at: 5.seconds.from_now.utc.iso8601(6))
              end
            else
              result[:state] = 'state_changed'
            end
          end
          Receipt.create!(id: command, account_id: @payload['account_id'], source_message_id: @payload['message_id'],
                          request_digest: digest, result: result, transport_agent_bot_id: transport_actor_id)
        end
      end
      render json: result
    end

    private

    def transport_enabled?
      ENV['REPLYNEST_ATOMIC_WECHAT_REPLY_ENABLED'] == 'true'
    end

    def eligible_message(c)
      account = Account.lock('FOR SHARE').find_by(id: c.account_id, status: 'active')
      inbox = Inbox.lock('FOR SHARE').find_by(id: c.inbox_id, account_id: c.account_id, channel_type: 'Channel::Api')
      channel = inbox && Channel::Api.lock('FOR SHARE').find_by(id: inbox.channel_id, account_id: c.account_id)
      contact = Contact.lock('FOR SHARE').find_by(id: c.contact_id, account_id: c.account_id)
      binding = ContactInbox.lock('FOR SHARE').find_by(id: c.contact_inbox_id, inbox_id: c.inbox_id, contact_id: c.contact_id)
      return unless account && inbox && channel && contact && binding && contact.identifier == @payload['contact_identifier'] &&
                    c.account_id.to_s == @payload['account_id'] && c.display_id.to_s == @payload['conversation_id'] &&
                    c.inbox_id.to_s == @payload['inbox_id'] && c.contact_id.to_s == @payload['contact_id'] &&
                    %w[open pending].include?(c.status) && c.assignee_agent_bot_id.nil? &&
                    c.can_reply? &&
                    c.custom_attributes['source_channel'] == @payload['provider'] &&
                    contact.custom_attributes['source_channel'] == @payload['provider']
      shared = @payload['provider'] == 'shared_wechat'
      return if shared ? c.custom_attributes['replynest_shared_contact'] != contact.identifier : c.custom_attributes.key?('replynest_shared_contact')
      recent = c.messages.where('private=false AND message_type IN (0,1,3)').reorder(id: :desc).limit(20).to_a
      # API inboxes have no trusted widget collection prompts to skip.
      m = recent.first
      key = shared ? 'replynest_shared_event_id' : 'replynest_external_event_id'
      unless shared
        trusted = Internal::ReplynestVerifiedWechatController::IngressReceipt.find_by(account_id: c.account_id, inbox_id: c.inbox_id,
          contact_id: c.contact_id, conversation_id: c.id, message_id: @payload['message_id'], external_event_id: @payload['source_event_id'])
        return unless trusted && trusted.source_occurred_at == @source_occurred_at &&
          contact.identifier.start_with?("#{trusted.connection_id}:")
      end
      return unless m && m.id.to_s == @payload['message_id'] && m.incoming? && m.text? &&
                    m.account_id == c.account_id && m.inbox_id == c.inbox_id &&
                    m.sender_type == 'Contact' && m.sender_id == c.contact_id &&
                    !m.content.blank? && m.content.length <= 4000 && !m.content_attributes['deleted'] &&
                    m.content_attributes[key] == @payload['source_event_id'] && !m.attachments.exists? &&
                    m.created_at >= @authorized_at && m.created_at >= 10.minutes.ago && m.created_at <= Time.current &&
                    @source_occurred_at >= @authorized_at && @source_occurred_at >= 10.minutes.ago && @source_occurred_at <= Time.current
      m if customer_automation_available?(c, m)
    end

    def validate_payload!
      @payload = JSON.parse(request.raw_post)
      keys = action_name == 'authorize' ? WECHAT_TARGET_KEYS + %w[command_id content fence] : WECHAT_TARGET_KEYS
      valid = @payload.is_a?(Hash) && @payload.keys.sort == keys.sort &&
              TARGET_KEYS.reject { |k| %w[authorization_at customer_id].include?(k) }.all? do |k|
                @payload[k].is_a?(String) && @payload[k].match?(/\A[1-9]\d{0,18}\z/) && @payload[k].to_i <= 9_223_372_036_854_775_807
              end
      raise ArgumentError unless valid && @payload['customer_id'].is_a?(String) &&
        @payload['customer_id'].match?(/\A[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\z/) && %w[wechat_official_account shared_wechat].include?(@payload['provider']) &&
        %w[contact_identifier source_event_id authorization_at source_occurred_at].all? { |k| @payload[k].is_a?(String) && @payload[k].bytesize.between?(1, 200) && !@payload[k].include?("\0") }
      raise ArgumentError unless @payload['provider'] == 'shared_wechat' ? @payload['contact_identifier'].match?(/\Arn_shared_[a-f0-9]{64}\z/) : @payload['contact_identifier'].match?(/\A[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}:[a-zA-Z0-9_-]{1,128}\z/)
      @authorized_at = Time.iso8601(@payload['authorization_at'])
      @source_occurred_at = Time.iso8601(@payload['source_occurred_at'])
      raise ArgumentError unless @authorized_at <= Time.current && @source_occurred_at <= Time.current
      if action_name == 'authorize'
        f = @payload['fence']
        valid = @payload['command_id'].is_a?(String) && @payload['command_id'].match?(/\A[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\z/) &&
          @payload['content'].is_a?(String) && @payload['content'].valid_encoding? && !@payload['content'].blank? &&
          @payload['content'].bytesize <= 1800 && !@payload['content'].include?("\0") &&
          f.is_a?(Hash) && f.keys.sort == FENCE_KEYS.sort && f.values.all? { |v| v.is_a?(String) } &&
          f['revision'].match?(/\A\d{1,19}\z/) && f['revision'].to_i <= 9_223_372_036_854_775_807 &&
          f['customer_pause_revision'].match?(/\A\d{1,19}\z/) && f['customer_pause_revision'].to_i <= 9_223_372_036_854_775_807 &&
          f['question_sha256'].match?(/\A[a-f0-9]{64}\z/) &&
          f['conversation_updated_at'].bytesize <= 40 && f['message_updated_at'].bytesize <= 40
        raise ArgumentError unless valid
      end
    rescue JSON::ParserError, ArgumentError, TypeError
      render json: { error: 'invalid_payload' }, status: :unprocessable_entity
    end
  end
end
