# frozen_string_literal: true
require 'openssl'
require 'digest'
require 'active_support/security_utils'

module Internal
  class ReplynestAssignmentsController < ActionController::API
    class Receipt < ActiveRecord::Base
      self.table_name = 'replynest_assignment_receipts'
    end
    before_action :verify_signature!

    def self.assignment_secret
      path = ENV.fetch('REPLYNEST_ASSIGNMENT_SECRET_FILE', '').strip
      if path.empty?
        value = ENV.fetch('REPLYNEST_ASSIGNMENT_SECRET', '').strip
      else
        raise 'invalid secret' unless path.start_with?('/') && File.file?(path) && File.size(path) <= 65_536
        value = File.binread(path).sub(/\r?\n\z/, '')
      end
      raise 'invalid secret' unless value.bytesize.between?(32, 65_536) && !value.include?("\0")
      value
    rescue StandardError
      # Do not expose the secret or host file path in responses/logs.
      raise 'atomic_assignment_not_configured'
    end

    def snapshot
      conversation = scoped_conversation
      return render json: { error: 'not_found' }, status: :not_found unless conversation
      conversation.with_lock { render json: { snapshot: snapshot_for(conversation) } }
    end

    def receipt
      row = Receipt.find_by(id: params[:command_id], account_id: params[:account_id])
      return render json: { error: 'receipt_not_found' }, status: :not_found unless row
      render json: row.result
    end

    def assign
      command = params[:command_id].to_s
      return render json: { error: 'invalid_command' }, status: :unprocessable_entity unless command.match?(/\A[0-9a-f-]{36}\z/i)
      digest = Digest::SHA256.hexdigest(request.raw_post)
      result = nil
      ActiveRecord::Base.transaction do
        # Serialize duplicate commands even when the conversation has changed since commit.
        ActiveRecord::Base.connection.execute("SELECT pg_advisory_xact_lock(hashtext(#{ActiveRecord::Base.connection.quote(command)}))")
        existing = Receipt.find_by(id: command)
        if existing
          result = existing.request_digest == digest && existing.account_id.to_s == params[:account_id].to_s ? existing.result : { 'state' => 'command_conflict', 'command_id' => command }
        else
          conversation = scoped_conversation
          result = { 'state' => 'rejected', 'command_id' => command }
          if conversation
            conversation.with_lock do
              expected = params[:snapshot]&.to_unsafe_h
              target = conversation.account.account_users.lock.find_by(user_id: params[:target_user_id])
              user = target && User.lock.find_by(id: target.user_id)
              if expected != snapshot_for(conversation)
                result['state'] = 'state_changed'
              elsif !target || !user&.active_for_authentication? || !conversation.account.active? || !%w[open pending].include?(conversation.status) || conversation.assignee_agent_bot_id.present?
                result['state'] = 'rejected'
              else
                Conversations::AssignmentService.new(conversation: conversation, assignee_id: user.id, assignee_type: 'User').perform
                result['state'] = 'applied'
              end
            end
          end
          Receipt.create!(id: command, request_digest: digest, account_id: params[:account_id], result: result)
        end
      end
      render json: result
    end

    private

    def scoped_conversation
      Account.find_by(id: params[:account_id], status: 'active')&.conversations&.find_by(display_id: params[:conversation_id])
    end

    def snapshot_for(c)
      { 'account_id' => c.account_id.to_s, 'conversation_id' => c.display_id.to_s,
        'assignee_id' => c.assignee_id&.to_s, 'bot_id' => c.assignee_agent_bot_id&.to_s,
        'status' => c.status, 'updated_at' => c.updated_at.utc.iso8601(6) }
    end

    def verify_signature!
      return render json: { error: 'disabled' }, status: :service_unavailable unless ENV['REPLYNEST_ATOMIC_ASSIGNMENT_ENABLED'] == 'true'
      begin
        secret = self.class.assignment_secret
      rescue StandardError
        return render json: { error: 'disabled' }, status: :service_unavailable
      end
      ts = request.headers['X-Assignment-Timestamp'].to_s
      nonce = request.headers['X-Assignment-Nonce'].to_s
      signature = request.headers['X-Assignment-Signature'].to_s
      valid = request.raw_post.bytesize <= 8000 && ts.match?(/\A\d{13}\z/) && nonce.match?(/\A[a-f0-9]{32}\z/) && signature.match?(/\A[a-f0-9]{64}\z/) && (Time.current.to_f * 1000 - ts.to_i).abs <= 60_000
      expected = OpenSSL::HMAC.hexdigest('SHA256', secret, "#{request.path}\n#{ts}\n#{nonce}\n#{request.raw_post}")
      return render json: { error: 'unauthorized' }, status: :unauthorized unless valid && ActiveSupport::SecurityUtils.secure_compare(expected, signature)
      return render json: { error: 'replay' }, status: :conflict unless ::Redis::Alfred.set("REPLYNEST_ASSIGN_NONCE::#{nonce}", '1', nx: true, ex: 120)
    end
  end
end
