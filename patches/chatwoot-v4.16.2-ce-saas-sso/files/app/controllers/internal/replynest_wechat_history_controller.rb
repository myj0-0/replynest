# frozen_string_literal: true
module Internal
  # Signed acknowledgement projection only. Never calls WeChat, renews a permit,
  # or re-evaluates current automation consent for an already-issued response.
  class ReplynestWechatHistoryController < ReplynestAutomaticWechatController
    def project
      command = @payload.fetch('command_id')
      digest = Digest::SHA256.hexdigest(request.raw_post)
      result = { state: 'rejected', command_id: command }
      guarded_transaction do
        db = ActiveRecord::Base.connection
        db.execute("SELECT pg_advisory_xact_lock(hashtext(#{db.quote(command)}))")
        prior = ReplynestWechatHistoryReceipt.find_by(id: command)
        if prior
          result = if prior.account_id.to_s != @payload['account_id'] || prior.request_digest != digest
                     { state: 'command_conflict', command_id: command }
                   else
                     m = Message.find_by(id: prior.message_id, account_id: prior.account_id, inbox_id: prior.inbox_id,
                                         conversation_id: prior.conversation_id, message_type: :outgoing, private: false)
                     m && !m.content_attributes['deleted'] && Digest::SHA256.hexdigest(m.content.to_s) == prior.content_sha256 ?
                       history_echo(prior) : { state: 'history_missing', command_id: command }
                   end
        else
          permission = Receipt.lock('FOR SHARE').find_by(id: command, account_id: @payload['account_id'], source_message_id: @payload['message_id'])
          c = scoped_conversation
          c&.with_lock do
            m = original_message(c)
            p = permission&.result
            binding = Digest::SHA256.hexdigest(JSON.generate(@payload.slice(*WECHAT_TARGET_KEYS)))
            valid = m && p && p['state'] == 'transport_authorized' && p['provider'] == @payload['provider'] &&
              p['content_sha256'] == Digest::SHA256.hexdigest(@payload['content']) && p['binding_sha256'] == binding &&
              @accepted_at >= permission.created_at - 30.seconds && @accepted_at >= @source_occurred_at
            if valid
              bot = AgentBot.find_by(id: permission.transport_agent_bot_id, account_id: c.account_id)
              msg = c.messages.build(account_id: c.account_id, inbox_id: c.inbox_id, sender: bot, message_type: :outgoing,
                content_type: :text, private: false, status: :sent, content: @payload['content'], created_at: @accepted_at,
                content_attributes: { replynest_command_id: command, replynest_transport: 'automatic_wechat_history',
                  replynest_provider_state: 'accepted', replynest_provider: @payload['provider'] })
              msg.save!
              receipt = ReplynestWechatHistoryReceipt.create!(id: command, account_id: c.account_id, inbox_id: c.inbox_id,
                conversation_id: c.id, contact_id: c.contact_id, source_message_id: m.id, message_id: msg.id,
                provider: @payload['provider'], content_sha256: p['content_sha256'], request_digest: digest, provider_accepted_at: @accepted_at)
              # Delayed history must not lower recent activity or clear a newer
              # customer's waiting state. No conversation callbacks are emitted.
              c.update_columns(last_activity_at: [c.last_activity_at, @accepted_at].compact.max, updated_at: Time.current)
              result = history_echo(receipt)
            end
          end
        end
      end
      render json: result
    end

    private

    def history_echo(r)
      { state: 'recorded', command_id: r.id, account_id: r.account_id.to_s,
        conversation_id: @payload['conversation_id'], inbox_id: r.inbox_id.to_s, contact_id: r.contact_id.to_s,
        source_message_id: r.source_message_id.to_s, message_id: r.message_id.to_s, provider: r.provider,
        content_sha256: r.content_sha256, provider_accepted_at: r.provider_accepted_at.utc.iso8601(6) }
    end

    def original_message(c)
      return unless c.account_id.to_s == @payload['account_id'] && c.inbox_id.to_s == @payload['inbox_id'] && c.contact_id.to_s == @payload['contact_id']
      inbox = Inbox.lock('FOR SHARE').find_by(id: c.inbox_id, account_id: c.account_id, channel_type: 'Channel::Api')
      contact = Contact.lock('FOR SHARE').find_by(id: c.contact_id, account_id: c.account_id, identifier: @payload['contact_identifier'])
      link = ContactInbox.lock('FOR SHARE').find_by(id: c.contact_inbox_id, contact_id: c.contact_id, inbox_id: c.inbox_id)
      return unless inbox && contact && link && Account.exists?(id: c.account_id) &&
        Channel::Api.exists?(id: inbox.channel_id, account_id: c.account_id)
      m = c.messages.find_by(id: @payload['message_id'], account_id: c.account_id, inbox_id: c.inbox_id, sender_type: 'Contact',
                            sender_id: c.contact_id, message_type: :incoming, private: false, content_type: :text)
      key = @payload['provider'] == 'shared_wechat' ? 'replynest_shared_event_id' : 'replynest_external_event_id'
      return unless m && !m.content_attributes['deleted'] && m.content_attributes[key] == @payload['source_event_id']
      unless @payload['provider'] == 'shared_wechat'
        trusted = ReplynestVerifiedWechatController::IngressReceipt.find_by(account_id: c.account_id, inbox_id: c.inbox_id,
          contact_id: c.contact_id, conversation_id: c.id, message_id: m.id, external_event_id: @payload['source_event_id'])
        return unless trusted && trusted.source_occurred_at == @source_occurred_at && contact.identifier.start_with?("#{trusted.connection_id}:")
      end
      m
    end

    def transport_enabled?
      ENV['REPLYNEST_WECHAT_HISTORY_ENABLED'] == 'true'
    end

    def validate_payload!
      @payload = JSON.parse(request.raw_post)
      history_keys = @payload.is_a?(Hash) && @payload.key?('customer_id') ? WECHAT_TARGET_KEYS : WECHAT_TARGET_KEYS - ['customer_id']
      valid = @payload.is_a?(Hash) && @payload.keys.sort == (history_keys + %w[command_id content provider_accepted_at]).sort &&
        (!@payload.key?('customer_id') || (@payload['customer_id'].is_a?(String) && @payload['customer_id'].match?(/\A[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\z/))) &&
        TARGET_KEYS.reject { |k| %w[authorization_at customer_id].include?(k) }.all? { |k| @payload[k].is_a?(String) && @payload[k].match?(/\A[1-9]\d{0,18}\z/) && @payload[k].to_i <= 9_223_372_036_854_775_807 } &&
        %w[wechat_official_account shared_wechat].include?(@payload['provider']) &&
        %w[authorization_at source_occurred_at provider_accepted_at contact_identifier source_event_id content command_id].all? { |k| @payload[k].is_a?(String) && @payload[k].valid_encoding? && !@payload[k].include?("\0") }
      raise ArgumentError unless valid && @payload['command_id'].match?(/\A[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\z/) &&
        !@payload['content'].blank? && @payload['content'].bytesize <= 1800 &&
        @payload['contact_identifier'].bytesize.between?(1, 200) && @payload['source_event_id'].bytesize.between?(1, 200)
      pattern = @payload['provider'] == 'shared_wechat' ? /\Arn_shared_[a-f0-9]{64}\z/ : /\A[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}:[a-zA-Z0-9_-]{1,128}\z/
      raise ArgumentError unless @payload['contact_identifier'].match?(pattern)
      times = %w[authorization_at source_occurred_at provider_accepted_at].map do |key|
        raise ArgumentError unless @payload[key].match?(/\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z\z/)
        Time.iso8601(@payload[key])
      end
      @authorized_at, @source_occurred_at, @accepted_at = times
      raise ArgumentError unless times.all? { |time| time <= Time.current + 30.seconds } && @accepted_at >= @source_occurred_at
    rescue JSON::ParserError, ArgumentError, TypeError
      render json: { error: 'invalid_payload' }, status: :unprocessable_entity
    end
  end
end
