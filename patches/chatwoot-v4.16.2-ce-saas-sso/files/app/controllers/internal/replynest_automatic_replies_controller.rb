# frozen_string_literal: true
require 'openssl'
require 'digest'
require 'active_support/security_utils'

module Internal
  # Transport guard only. Tenant consent, AI points and approved evidence remain
  # gateway responsibilities; this route must never be exposed by the public proxy.
  class ReplynestAutomaticRepliesController < ActionController::API
    TARGET_KEYS = %w[account_id conversation_id inbox_id contact_id message_id authorization_at customer_id].freeze
    FENCE_KEYS = %w[revision conversation_updated_at message_updated_at question_sha256 customer_pause_revision].freeze
    class CustomerPause < ActiveRecord::Base
      self.table_name = 'replynest_customer_automation_pauses'
    end
    class Receipt < ActiveRecord::Base
      self.table_name = 'replynest_automatic_receipts'
    end
    class Actor < ActiveRecord::Base
      self.table_name = 'replynest_automatic_actors'
      self.primary_key = 'account_id'
    end
    before_action :verify_signature!
    before_action :validate_payload!
    rescue_from ActiveRecord::ActiveRecordError do
      # An error can also occur in an after_commit callback. Never claim definite
      # non-submission from an exception alone; callers must not retry automatically.
      render json: { error: 'native_state_uncertain' }, status: :service_unavailable
    end

    def self.transport_secret
      path = ENV.fetch('REPLYNEST_AUTOMATIC_REPLY_SECRET_FILE', '').strip
      value = if path.empty?
                ENV.fetch('REPLYNEST_AUTOMATIC_REPLY_SECRET', '').strip
              else
                raise 'invalid' unless path.start_with?('/') && File.file?(path) && File.size(path) <= 65_536
                File.binread(path).sub(/\r?\n\z/, '')
              end
      raise 'invalid' unless value.bytesize.between?(32, 65_536) && !value.include?("\0")
      value
    rescue StandardError
      raise 'automatic_reply_not_configured'
    end

    def snapshot
      result = { state: 'rejected' }
      guarded_transaction do
        c = scoped_conversation
        if c
          c.with_lock do
            m = eligible_message(c)
            result = target_echo(c, m).merge(state: 'ready', question: m.content.strip, fence: fence_for(c, m)) if m && configured_actor(c.account_id)
          end
        end
      end
      render json: result
    end

    def submit
      command = @payload.fetch('command_id')
      digest = Digest::SHA256.hexdigest(request.raw_post)
      result = nil
      guarded_transaction do
        # Idempotency key is independent of nonce. Lost HTTP acknowledgement can
        # be reconciled without creating a second message or duplicate callbacks.
        db = ActiveRecord::Base.connection
        db.execute("SELECT pg_advisory_xact_lock(hashtext(#{db.quote(command)}))")
        existing = Receipt.find_by(id: command)
        if existing
          result = existing.account_id.to_s == @payload['account_id'] && existing.request_digest == digest ?
            existing.result : { state: 'command_conflict', command_id: command }
        else
          result = { state: 'rejected', command_id: command }
          c = scoped_conversation
          if c
            c.with_lock do
              m = eligible_message(c)
              if m && fence_for(c, m) == @payload['fence']
                already_submitted = Receipt.where(account_id: c.account_id, source_message_id: m.id)
                  .where("result->>'state' = 'accepted'").exists?
                bot = configured_actor(c.account_id) unless already_submitted
                if bot
                  msg = Messages::MessageBuilder.new(bot, c, {
                    content: @payload['content'], message_type: 'outgoing', content_type: 'text', private: false,
                    content_attributes: { replynest_command_id: command, replynest_transport: 'automatic_web_chat',
                                          replynest_show_ai_label: @payload.fetch('show_ai_label', false) }
                  }).perform
                  result = target_echo(c, m).merge(state: 'accepted', command_id: command, message_id: msg.id.to_s,
                                                  content_sha256: Digest::SHA256.hexdigest(msg.content.to_s))
                end
              else
                result[:state] = 'state_changed'
              end
            end
          end
          Receipt.create!(id: command, account_id: @payload['account_id'], source_message_id: @payload['message_id'],
                          request_digest: digest, result: result)
        end
      end
      render json: result
    end

    private

    def guarded_transaction
      ActiveRecord::Base.transaction do
        db = ActiveRecord::Base.connection
        db.execute("SET LOCAL lock_timeout = '500ms'")
        db.execute("SET LOCAL statement_timeout = '1500ms'")
        raise 'unsupported_isolation' unless db.select_value('SHOW transaction_isolation') == 'read committed'
        yield
      end
    end

    def scoped_conversation
      Conversation.find_by(account_id: @payload['account_id'], display_id: @payload['conversation_id'])
    end

    def configured_actor(account_id)
      actor = Actor.lock('FOR SHARE').find_by(account_id: account_id, enabled: true)
      actor && AgentBot.lock('FOR SHARE').find_by(id: actor.agent_bot_id, account_id: account_id, outgoing_url: nil)
    end

    def eligible_message(c)
      account = Account.lock('FOR SHARE').find_by(id: c.account_id, status: 'active')
      inbox = Inbox.lock('FOR SHARE').find_by(id: c.inbox_id, account_id: c.account_id, channel_type: 'Channel::WebWidget')
      channel = inbox && Channel::WebWidget.lock('FOR SHARE').find_by(id: inbox.channel_id, account_id: c.account_id)
      contact = Contact.lock('FOR SHARE').find_by(id: c.contact_id, account_id: c.account_id)
      binding = ContactInbox.lock('FOR SHARE').find_by(id: c.contact_inbox_id, inbox_id: c.inbox_id, contact_id: c.contact_id)
      return unless account && inbox && channel && contact && binding &&
                    c.account_id.to_s == @payload['account_id'] && c.display_id.to_s == @payload['conversation_id'] &&
                    c.inbox_id.to_s == @payload['inbox_id'] && c.contact_id.to_s == @payload['contact_id'] &&
                    %w[open pending].include?(c.status) && c.assignee_agent_bot_id.nil? &&
                    c.can_reply? && !c.custom_attributes.key?('replynest_shared_contact') &&
                    c.custom_attributes['source_channel'] != 'shared_wechat'
      # ORDER BY id alone cannot detect a delayed insert with an earlier sequence
      # allocation; the revision also invalidates every committed message mutation.
      # Fixed v4.16.2 enum literals let PostgreSQL use the partial tail index even
      # with a generic prepared plan; no user/model text enters this SQL predicate.
      recent = c.messages.where('private=false AND message_type IN (0,1,3)').reorder(id: :desc).limit(20).to_a
      m = recent.find { |message| !email_collection_hint?(message, account) }
      return unless m && m.id.to_s == @payload['message_id'] && m.incoming? && m.text? &&
                    m.account_id == c.account_id && m.inbox_id == c.inbox_id &&
                    m.sender_type == 'Contact' && m.sender_id == c.contact_id &&
                    !m.content.blank? && m.content.length <= 4000 && !m.content_attributes['deleted'] &&
                    !m.attachments.exists? && m.created_at >= @authorized_at &&
                    m.created_at >= 10.minutes.ago && m.created_at <= 30.seconds.from_now
      m if customer_automation_available?(c, m)
    end

    # All conversations of one gateway customer in one account share this guard.
    # Insert a sentinel before locking: an absent row must not leave a pause/send race.
    # Native public replies still invalidate the message fence, regardless of assignment.
    def customer_pause(account_id, customer_id, lock = 'FOR SHARE')
      db = ActiveRecord::Base.connection
      db.execute("INSERT INTO replynest_customer_automation_pauses(account_id,customer_id,revision,updated_at) VALUES(#{db.quote(account_id)},#{db.quote(customer_id)},0,clock_timestamp()) ON CONFLICT(account_id,customer_id) DO NOTHING")
      CustomerPause.lock(lock).find_by!(account_id: account_id, customer_id: customer_id)
    end

    def customer_automation_available?(c, m)
      pause = customer_pause(c.account_id, @payload['customer_id'])
      @customer_pause_revision = pause.revision.to_s
      # Expiry restores reception for NEW questions only, not unanswered paused messages.
      pause.paused_until.nil? || (pause.paused_until <= Time.current && m.created_at >= pause.paused_until)
    end

    def email_collection_hint?(m, account)
      # Only the two native email-collection prompts, never arbitrary greetings,
      # template messages or any public agent/bot reply. Changes still bump revision.
      return false unless m.template? && m.sender_id.nil? && m.sender_type.nil? && m.content_attributes.empty?
      key = if m.text?
              'conversations.templates.ways_to_reach_you_message_body'
            elsif m.input_email?
              'conversations.templates.email_input_box_message_body'
            end
      key && I18n.available_locales.any? { |locale| m.content == I18n.t(key, locale: locale, account_name: account.name) }
    end

    def fence_for(c, m)
      { 'revision' => c.replynest_message_revision.to_s, 'conversation_updated_at' => c.updated_at.utc.iso8601(6),
        'message_updated_at' => m.updated_at.utc.iso8601(6), 'question_sha256' => Digest::SHA256.hexdigest(m.content.strip),
        'customer_pause_revision' => @customer_pause_revision }
    end

    def target_echo(c, m)
      { account_id: c.account_id.to_s, conversation_id: c.display_id.to_s, inbox_id: c.inbox_id.to_s,
        contact_id: c.contact_id.to_s, source_message_id: m.id.to_s }
    end

    def validate_payload!
      @payload = JSON.parse(request.raw_post)
      keys = action_name == 'submit' ? TARGET_KEYS + %w[command_id content fence] : TARGET_KEYS
      keys += ['show_ai_label'] if action_name == 'submit' && @payload.is_a?(Hash) && @payload.key?('show_ai_label')
      valid = @payload.is_a?(Hash) && @payload.keys.sort == keys.sort &&
              TARGET_KEYS.reject { |k| %w[authorization_at customer_id].include?(k) }.all? { |k| @payload[k].is_a?(String) && @payload[k].match?(/\A[1-9]\d{0,18}\z/) } &&
              @payload['authorization_at'].is_a?(String) && @payload['customer_id'].is_a?(String) &&
              @payload['customer_id'].match?(/\A[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\z/)
      raise ArgumentError unless valid
      @authorized_at = Time.iso8601(@payload['authorization_at'])
      raise ArgumentError unless @authorized_at <= Time.current + 30.seconds
      if action_name == 'submit'
        f = @payload['fence']
        valid = [true, false].include?(@payload.fetch('show_ai_label', false)) &&
                @payload['command_id'].is_a?(String) && @payload['command_id'].match?(/\A[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\z/) &&
                @payload['content'].is_a?(String) && !@payload['content'].blank? && @payload['content'].length <= 4000 &&
                f.is_a?(Hash) && f.keys.sort == FENCE_KEYS.sort && f.values.all? { |v| v.is_a?(String) } &&
                f['revision'].match?(/\A\d{1,19}\z/) && f['customer_pause_revision'].match?(/\A\d{1,19}\z/) && f['question_sha256'].match?(/\A[a-f0-9]{64}\z/) &&
                f['conversation_updated_at'].bytesize <= 40 && f['message_updated_at'].bytesize <= 40
        raise ArgumentError unless valid
      end
    rescue JSON::ParserError, ArgumentError, TypeError
      render json: { error: 'invalid_payload' }, status: :unprocessable_entity
    end

    def verify_signature!
      return render json: { error: 'disabled' }, status: :service_unavailable unless transport_enabled?
      begin
        secret = self.class.transport_secret
      rescue StandardError
        return render json: { error: 'disabled' }, status: :service_unavailable
      end
      ts = request.headers['X-Automatic-Timestamp'].to_s
      nonce = request.headers['X-Automatic-Nonce'].to_s
      signature = request.headers['X-Automatic-Signature'].to_s
      valid = request.raw_post.bytesize <= 32_768 && ts.match?(/\A\d{13}\z/) && nonce.match?(/\A[a-f0-9]{32}\z/) &&
              signature.match?(/\A[a-f0-9]{64}\z/) && (Time.current.to_f * 1000 - ts.to_i).abs <= 60_000
      expected = OpenSSL::HMAC.hexdigest('SHA256', secret, "#{request.path}\n#{ts}\n#{nonce}\n#{request.raw_post}")
      return render json: { error: 'unauthorized' }, status: :unauthorized unless valid && ActiveSupport::SecurityUtils.secure_compare(expected, signature)
      return render json: { error: 'replay' }, status: :conflict unless ::Redis::Alfred.set("REPLYNEST_AUTO_NONCE::#{nonce}", '1', nx: true, ex: 120)
    end

    def transport_enabled?
      ENV['REPLYNEST_ATOMIC_WEB_REPLY_ENABLED'] == 'true'
    end
  end
end
