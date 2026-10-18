# frozen_string_literal: true
class CreateReplynestVerifiedWechatIngress < ActiveRecord::Migration[7.1]
  def up
    create_table :replynest_wechat_ingress_receipts, id: :uuid do |t|
      # Numeric bindings survive privacy deletion; they must not hold contacts or
      # messages alive. The endpoint verifies all bindings, including on replay.
      t.references :account, null: false
      t.references :inbox, null: false
      t.uuid :connection_id, null: false
      t.string :external_event_id, null: false, limit: 200
      t.string :external_message_id, null: false, limit: 128
      t.string :request_digest, null: false, limit: 64
      t.datetime :source_occurred_at, null: false, precision: 6
      t.references :contact, null: false
      t.references :conversation, null: false
      t.references :message, null: false, index: { unique: true }
      t.timestamps precision: 6, null: false
    end
    add_index :replynest_wechat_ingress_receipts, [:account_id, :inbox_id, :connection_id, :external_event_id], unique: true, name: 'rn_wechat_ingress_event_once'
    add_index :replynest_wechat_ingress_receipts, [:account_id, :inbox_id, :connection_id, :external_message_id], unique: true, name: 'rn_wechat_ingress_message_once'
    execute <<~SQL
      CREATE TRIGGER rn_wechat_ingress_append_only BEFORE UPDATE OR DELETE ON replynest_wechat_ingress_receipts
        FOR EACH ROW EXECUTE FUNCTION replynest_automatic_append_only();
      CREATE TRIGGER rn_wechat_ingress_no_truncate BEFORE TRUNCATE ON replynest_wechat_ingress_receipts
        FOR EACH STATEMENT EXECUTE FUNCTION replynest_automatic_append_only();
    SQL
  end
  def down
    raise ActiveRecord::IrreversibleMigration, 'verified ingress history must not be made replayable'
  end
end
