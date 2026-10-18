# frozen_string_literal: true
class CreateReplynestCustomerAutomationPauses < ActiveRecord::Migration[7.1]
  def up
    create_table :replynest_customer_automation_pauses do |t|
      t.bigint :account_id, null: false
      t.uuid :customer_id, null: false
      t.bigint :revision, null: false, default: 0
      t.datetime :paused_until, precision: 6
      t.datetime :updated_at, null: false, precision: 6
    end
    add_foreign_key :replynest_customer_automation_pauses, :accounts
    add_index :replynest_customer_automation_pauses, [:account_id, :customer_id], unique: true, name: 'rn_customer_pause_owner'
    create_table :replynest_customer_automation_pause_events, id: :uuid do |t|
      t.bigint :account_id, null: false
      t.uuid :customer_id, null: false
      t.uuid :actor_id, null: false
      t.string :request_id, null: false, limit: 200
      t.string :operation, null: false, limit: 10
      t.bigint :revision, null: false
      t.datetime :paused_until, precision: 6
      t.datetime :created_at, null: false, precision: 6
    end
    add_index :replynest_customer_automation_pause_events, [:account_id, :customer_id, :created_at], name: 'rn_customer_pause_audit'
    execute <<~SQL
      ALTER TABLE replynest_customer_automation_pauses ADD CONSTRAINT rn_customer_pause_revision CHECK(revision>=0);
      ALTER TABLE replynest_customer_automation_pause_events ADD CONSTRAINT rn_customer_pause_operation CHECK(operation IN('pause','resume'));
      CREATE TRIGGER rn_customer_pause_append_only BEFORE UPDATE OR DELETE ON replynest_customer_automation_pause_events
        FOR EACH ROW EXECUTE FUNCTION replynest_automatic_append_only();
      CREATE TRIGGER rn_customer_pause_no_truncate BEFORE TRUNCATE ON replynest_customer_automation_pause_events
        FOR EACH STATEMENT EXECUTE FUNCTION replynest_automatic_append_only();
    SQL
  end
  def down
    raise ActiveRecord::IrreversibleMigration, 'customer pause audit must be preserved'
  end
end
