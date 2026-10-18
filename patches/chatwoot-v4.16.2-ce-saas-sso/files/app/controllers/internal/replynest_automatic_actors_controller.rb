# frozen_string_literal: true
module Internal
  # Signed server-to-server infrastructure preparation, NOT a send consent.
  # Never invoked by a model, public widget or the message-processing transaction.
  class ReplynestAutomaticActorsController < ReplynestAutomaticRepliesController
    def actor
      result = { state: 'invalid', account_id: @payload['account_id'] }
      guarded_transaction do
        account = Account.lock(@payload['operation'] == 'prepare' ? 'FOR UPDATE' : 'FOR SHARE')
                         .find_by(id: @payload['account_id'], status: 'active')
        if account
          actor = Actor.lock('FOR SHARE').find_by(account_id: account.id)
          if actor.nil? && @payload['operation'] == 'prepare'
            # Account row serialization makes initialization idempotent, including
            # concurrent requests from separate gateway processes. No assignment,
            # user membership, outbound callback or message is created here.
            bot = AgentBot.create!(account_id: account.id, name: '答巢自动接待', outgoing_url: nil)
            actor = Actor.create!(account_id: account.id, agent_bot_id: bot.id, enabled: true)
          end
          result[:state] = actor_state(actor, account.id)
        end
      end
      render json: result
    end

    private

    def actor_state(actor, account_id)
      return 'missing' unless actor
      # An operator stop is persistent. Tenant grants must never revive it.
      return 'disabled' unless actor.enabled
      bot = AgentBot.lock('FOR SHARE').find_by(id: actor.agent_bot_id, account_id: account_id, outgoing_url: nil)
      bot ? 'ready' : 'invalid'
    end

    def transport_enabled?
      ENV['REPLYNEST_AUTOMATIC_ACTOR_MANAGEMENT_ENABLED'] == 'true' ||
        ENV['REPLYNEST_ATOMIC_WEB_REPLY_ENABLED'] == 'true' || ENV['REPLYNEST_ATOMIC_WECHAT_REPLY_ENABLED'] == 'true'
    end

    def validate_payload!
      @payload = JSON.parse(request.raw_post)
      valid = @payload.is_a?(Hash) && @payload.keys.sort == %w[account_id operation] &&
              @payload['account_id'].is_a?(String) && @payload['account_id'].match?(/\A[1-9]\d{0,18}\z/) &&
              @payload['account_id'].to_i <= 9_223_372_036_854_775_807 && %w[inspect prepare].include?(@payload['operation'])
      raise ArgumentError unless valid
    rescue JSON::ParserError, ArgumentError, TypeError
      render json: { error: 'invalid_payload' }, status: :unprocessable_entity
    end
  end
end
