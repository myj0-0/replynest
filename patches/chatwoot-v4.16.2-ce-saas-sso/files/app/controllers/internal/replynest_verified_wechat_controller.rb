# frozen_string_literal: true
module Internal
  # Signed server-only ingress, not an automatic outgoing operation. Contact,
  # conversation, incoming message and dedup receipt share a native transaction.
  class ReplynestVerifiedWechatController < ReplynestAutomaticRepliesController
    KEYS = %w[command_id account_id inbox_id connection_id app_id open_id source_event_id external_message_id source_occurred_at content].freeze
    class IngressReceipt < ActiveRecord::Base
      self.table_name = 'replynest_wechat_ingress_receipts'
      belongs_to :account
      belongs_to :inbox
      belongs_to :contact
      belongs_to :conversation
      belongs_to :message
    end
    def ingress
      result = { state: 'rejected', command_id: @payload['command_id'] }
      digest = Digest::SHA256.hexdigest(JSON.generate(@payload.slice(*(KEYS - ['command_id']))))
      guarded_transaction do
        db = ActiveRecord::Base.connection
        db.execute("SELECT pg_advisory_xact_lock(hashtext(#{db.quote("wechat-ingress:#{@payload['account_id']}:#{@payload['connection_id']}:#{@payload['open_id']}" )}))")
        db.execute("SELECT pg_advisory_xact_lock(hashtext(#{db.quote("wechat-ingress-command:#{@payload['command_id']}" )}))")
        account = Account.lock('FOR SHARE').find_by(id: @payload['account_id'], status: 'active')
        inbox = account && Inbox.lock('FOR SHARE').find_by(id: @payload['inbox_id'], account_id: account.id, channel_type: 'Channel::Api')
        channel = inbox && Channel::Api.lock('FOR SHARE').find_by(id: inbox.channel_id, account_id: account.id)
        if channel
          old = IngressReceipt.where(id: @payload['command_id']).or(IngressReceipt.where(account_id: account.id,
            inbox_id: inbox.id, connection_id: @payload['connection_id'], external_event_id: @payload['source_event_id'])).or(
            IngressReceipt.where(account_id: account.id, inbox_id: inbox.id, connection_id: @payload['connection_id'], external_message_id: @payload['external_message_id'])).limit(2).to_a
          if old.any?
            r = old.first
            result = old.one? && r.request_digest == digest && r.account_id == account.id && r.inbox_id == inbox.id ?
              receipt_result(r) : { state: 'binding_conflict', command_id: @payload['command_id'] }
          else
            identifier = "#{@payload['connection_id']}:#{@payload['open_id']}"
            contact = Contact.lock.find_by(account_id: account.id, identifier: identifier)
            contact ||= Contact.create!(account: account, name: '微信访客', identifier: identifier,
              custom_attributes: { source_channel: 'wechat_official_account', replynest_wechat_connection: @payload['connection_id'], replynest_wechat_app: @payload['app_id'] })
            attrs = contact.custom_attributes
            if attrs['source_channel'] == 'wechat_official_account' && !attrs.key?('replynest_shared_contact') &&
               [nil, @payload['connection_id']].include?(attrs['replynest_wechat_connection']) && [nil, @payload['app_id']].include?(attrs['replynest_wechat_app'])
              link = ContactInbox.lock.find_by(contact_id: contact.id, inbox_id: inbox.id)
              link ||= ContactInbox.create!(contact: contact, inbox: inbox, source_id: SecureRandom.uuid)
              c = Conversation.where(account_id: account.id, inbox_id: inbox.id, contact_id: contact.id, contact_inbox_id: link.id).order(id: :desc).limit(1).lock.first
              # display_id is assigned by a database trigger, not returned by
              # ActiveRecord INSERT. Reload before building the first receipt.
              c ||= Conversation.create!(account: account, inbox: inbox, contact: contact, contact_inbox: link, status: :open,
                custom_attributes: { source_channel: 'wechat_official_account' }).reload
              if c.custom_attributes['source_channel'] == 'wechat_official_account' && !c.custom_attributes.key?('replynest_shared_contact')
                m = Messages::MessageBuilder.new(contact, c, { content: @payload['content'], message_type: 'incoming', content_type: 'text', private: false,
                  content_attributes: { replynest_external_event_id: @payload['source_event_id'], replynest_external_message_id: @payload['external_message_id'],
                    replynest_source_occurred_at: @payload['source_occurred_at'], replynest_wechat_connection: @payload['connection_id'] } }).perform
                r = IngressReceipt.create!(id: @payload['command_id'], account: account, inbox: inbox, connection_id: @payload['connection_id'],
                  external_event_id: @payload['source_event_id'], external_message_id: @payload['external_message_id'], request_digest: digest,
                  source_occurred_at: @occurred_at, contact: contact, conversation: c, message: m)
                result = receipt_result(r)
              end
            end
          end
        end
      end
      render json: result
    end
    private
    def receipt_result(r)
      m = r.message
      c = r.conversation
      contact = r.contact
      return { state: 'binding_conflict', command_id: @payload['command_id'] } unless m && c && contact &&
        m.account_id == r.account_id && m.inbox_id == r.inbox_id && m.conversation_id == c.id && c.contact_id == contact.id &&
        c.inbox_id == r.inbox_id && c.account_id == r.account_id && contact.account_id == r.account_id && c.contact_inbox
      { state: 'accepted', command_id: @payload['command_id'], account_id: r.account_id.to_s, inbox_id: r.inbox_id.to_s,
        contact_id: r.contact_id.to_s, conversation_id: c.display_id.to_s, message_id: r.message_id.to_s,
        source_id: c.contact_inbox.source_id, source_event_id: r.external_event_id,
        content_sha256: Digest::SHA256.hexdigest(m.content.to_s), binding_sha256: r.request_digest }
    end
    def transport_enabled?
      ENV['REPLYNEST_VERIFIED_WECHAT_INGRESS_ENABLED'] == 'true'
    end
    def validate_payload!
      @payload = JSON.parse(request.raw_post)
      raise ArgumentError unless @payload.is_a?(Hash) && @payload.keys.sort == KEYS.sort && @payload.values.all? { |v| v.is_a?(String) && v.valid_encoding? && !v.include?("\0") }
      raise ArgumentError unless %w[account_id inbox_id].all? { |k| @payload[k].match?(/\A[1-9]\d{0,18}\z/) && @payload[k].to_i <= 9_223_372_036_854_775_807 } &&
        %w[command_id connection_id].all? { |k| @payload[k].match?(/\A[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\z/) } &&
        @payload['app_id'].match?(/\Awx[a-f0-9]{16}\z/) && @payload['open_id'].match?(/\A[a-zA-Z0-9_-]{1,128}\z/) &&
        @payload['source_event_id'].bytesize.between?(1,200) && @payload['external_message_id'].bytesize.between?(1,128) &&
        !@payload['content'].blank? && @payload['content'].length <= 4000 && @payload['content'].bytesize <= 16000 &&
        @payload['source_occurred_at'].match?(/\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\z/)
      @occurred_at = Time.iso8601(@payload['source_occurred_at'])
      raise ArgumentError unless @occurred_at.utc.iso8601(3) == @payload['source_occurred_at'] && @occurred_at <= 30.seconds.from_now
    rescue JSON::ParserError, ArgumentError, TypeError
      render json: { error: 'invalid_payload' }, status: :unprocessable_entity
    end
  end
end
