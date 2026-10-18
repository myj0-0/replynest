# frozen_string_literal: true
# Opt-in until the non-owner role and helper grants have passed release gates.
Rails.application.config.to_prepare do
  mode = ENV.fetch('REPLYNEST_DB_RUNTIME_SPLIT_ENABLED', 'false')
  raise 'invalid database runtime mode' unless %w[true false].include?(mode)
  next unless mode == 'true'

  Account.class_eval do
    private

    # Account destruction runs in its normal transaction. The helper refuses
    # cleanup while an account still exists and can only address its two names.
    def remove_account_sequences
      bind = ActiveRecord::Relation::QueryAttribute.new('account_id', id, ActiveRecord::Type::Integer.new(limit: 8))
      self.class.connection.exec_query('SELECT public.replynest_remove_account_sequences($1::bigint)',
                                      'Protected account sequence cleanup', [bind])
    end
  end
end
