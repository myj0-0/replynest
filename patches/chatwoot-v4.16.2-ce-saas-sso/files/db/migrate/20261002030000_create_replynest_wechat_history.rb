# frozen_string_literal: true
class CreateReplynestWechatHistory < ActiveRecord::Migration[7.1]
  def up
    # Numeric actor identity survives disable/removal. No FK keeps private data
    # alive; history is an acknowledgement record, not another send permission.
    add_column :replynest_automatic_receipts, :transport_agent_bot_id, :bigint
    create_table :replynest_wechat_history_receipts, id: :uuid do |t|
      t.bigint :account_id, null: false
      t.bigint :inbox_id, null: false
      t.bigint :conversation_id, null: false
      t.bigint :contact_id, null: false
      t.bigint :source_message_id, null: false
      t.bigint :message_id, null: false
      t.string :provider, null: false, limit: 40
      t.string :content_sha256, null: false, limit: 64
      t.string :request_digest, null: false, limit: 64
      t.datetime :provider_accepted_at, null: false, precision: 6
      t.timestamps null: false, precision: 6
    end
    add_index :replynest_wechat_history_receipts, :message_id, unique: true
    add_index :replynest_wechat_history_receipts, [:account_id, :source_message_id], unique: true, name: 'rn_wechat_history_source_once'
    execute <<~SQL
      ALTER TABLE replynest_wechat_history_receipts ADD CONSTRAINT rn_wechat_history_provider
        CHECK(provider IN ('wechat_official_account','shared_wechat'));
      CREATE TRIGGER rn_wechat_history_append_only BEFORE UPDATE OR DELETE ON replynest_wechat_history_receipts
        FOR EACH ROW EXECUTE FUNCTION replynest_automatic_append_only();
      CREATE TRIGGER rn_wechat_history_no_truncate BEFORE TRUNCATE ON replynest_wechat_history_receipts
        FOR EACH STATEMENT EXECUTE FUNCTION replynest_automatic_append_only();
    SQL
  end
  def down
    raise ActiveRecord::IrreversibleMigration, 'acknowledged history must not become replayable'
  end
end
