# frozen_string_literal: true

require 'openssl'

module Internal
  class SaasSsoController < ActionController::API
    CLOCK_SKEW_SECONDS = 60
    NONCE_TTL_SECONDS = 120

    before_action :verify_adapter_signature!

    def create
      render_error(:gone, 'legacy_workspace_retired')
    end

    def provision
      account = Account.find_by(id: Integer(params[:account_id], exception: false))
      email = params[:email].to_s.strip.downcase
      name = params[:name].to_s.strip.first(200)
      role = params[:role].to_s
      return render_error(:unprocessable_entity, 'invalid_request') unless account&.active? && email.present? && %w[administrator agent].include?(role)

      user = User.from_email(email)
      ActiveRecord::Base.transaction do
        user ||= User.new(email: email, name: name.presence || email.split('@').first,
                          password: "1!aA#{SecureRandom.alphanumeric(32)}")
        user.name = name if name.present?
        user.custom_attributes = (user.custom_attributes || {}).merge('saas_managed' => true)
        user.skip_confirmation!
        user.save!
        membership = AccountUser.find_or_initialize_by(account_id: account.id, user_id: user.id)
        membership.role = role
        membership.save!
      end
      render json: { user_id: user.id, email: user.email, account_id: account.id, role: role }
    end

    def deprovision
      account_id = Integer(params[:account_id], exception: false)
      email = params[:email].to_s.strip.downcase
      return render_error(:unprocessable_entity, 'invalid_request') if account_id.blank? || email.blank?

      user = User.from_email(email)
      AccountUser.find_by(account_id: account_id, user_id: user&.id)&.destroy!
      user_id = user&.id
      if user.present? && user.account_users.reload.none? && user.custom_attributes&.fetch('saas_managed', false)
        user.destroy!
      end
      render json: { removed: true, user_id: user_id, account_id: account_id }
    end

    # Idempotent workspace bootstrap for ReplyNest self-service registration.
    # workspace_key is generated before this call and survives application retries.
    def provision_workspace
      workspace_key = params[:workspace_key].to_s.strip
      company_name = params[:company_name].to_s.strip.first(200)
      email = params[:email].to_s.strip.downcase
      name = params[:name].to_s.strip.first(200)
      return render_error(:unprocessable_entity, 'invalid_request') unless workspace_key.match?(/\Arn-[a-f0-9-]{36}\z/) && company_name.present? && email.match?(/\A[^\s@]+@[^\s@]+\.[^\s@]+\z/)

      # This identity comes only from the HMAC-authenticated gateway. It owns
      # the server API token; never make newly registered users global admins.
      service_user_id = Integer(params[:gateway_service_user_id], exception: false)
      service_user = User.find_by(id: service_user_id)
      return render_error(:unprocessable_entity, 'gateway_service_user_invalid') unless service_user&.active_for_authentication?

      account = Account.where("custom_attributes ->> 'replynest_workspace_key' = ?", workspace_key).first
      user = User.from_email(email)
      ActiveRecord::Base.transaction do
        account ||= Account.create!(
          name: company_name,
          custom_attributes: { 'replynest_workspace_key' => workspace_key, 'saas_managed' => true }
        )
        account.disable_features!('captain_tasks') if account.feature_enabled?('captain_tasks')
        user ||= User.new(email: email, name: name.presence || email.split('@').first,
                          password: "1!aA#{SecureRandom.alphanumeric(32)}")
        user.name = name if name.present?
        user.custom_attributes = (user.custom_attributes || {}).merge('saas_managed' => true)
        user.skip_confirmation!
        user.save!
        membership = AccountUser.find_or_initialize_by(account_id: account.id, user_id: user.id)
        membership.role = 'administrator'
        membership.save!
        service_membership = AccountUser.find_or_initialize_by(account_id: account.id, user_id: service_user.id)
        service_membership.role = 'administrator'
        service_membership.save!
      end
      render json: { account_id: account.id, user_id: user.id, email: user.email, workspace_key: workspace_key, gateway_service_user_id: service_user.id }
    end

    private

    def eligible?(user, membership)
      user&.active_for_authentication? && membership.present? && membership.account.active?
    end

    def verify_adapter_signature!
      secret = ENV.fetch('SAAS_SSO_SHARED_SECRET', '')
      timestamp = request.headers['X-SaaS-Timestamp'].to_s
      nonce = request.headers['X-SaaS-Nonce'].to_s
      received = request.headers['X-SaaS-Signature'].to_s
      return render_error(:service_unavailable, 'sso_disabled') if secret.bytesize < 32
      return render_error(:unauthorized, 'invalid_signature') unless valid_signature?(secret, timestamp, nonce, received)

      nonce_key = "SAAS_SSO_NONCE::#{nonce}"
      claimed = ::Redis::Alfred.set(nonce_key, '1', nx: true, ex: NONCE_TTL_SECONDS)
      render_error(:conflict, 'replayed_request') unless claimed
    end

    def valid_signature?(secret, timestamp, nonce, received)
      return false unless timestamp.match?(/\A\d{10,13}\z/) && nonce.match?(/\A[a-f0-9]{32}\z/i)
      return false unless received.match?(/\A[a-f0-9]{64}\z/i)

      milliseconds = timestamp.length == 13 ? timestamp.to_i : timestamp.to_i * 1000
      return false if (Time.current.to_f * 1000 - milliseconds).abs > CLOCK_SKEW_SECONDS * 1000

      expected = OpenSSL::HMAC.hexdigest('SHA256', secret, "#{timestamp}.#{nonce}.#{request.raw_post}")
      ActiveSupport::SecurityUtils.secure_compare(expected, received.downcase)
    end

    def render_error(status, code)
      render json: { error: code }, status: status
    end
  end
end
