class CreateReplynestReceptionOutbox < ActiveRecord::Migration[7.1]
  def change
    create_table :replynest_reception_outboxes do |t|
      t.bigint :message_id, null: false
      t.jsonb :payload, null: false
      t.string :state, null: false, default: 'pending'
      t.integer :attempts, null: false, default: 0
      t.datetime :available_at, null: false, default: -> { 'CURRENT_TIMESTAMP' }
      t.datetime :locked_at
      t.string :worker_token
      t.string :reason
      t.timestamps
    end
    add_index :replynest_reception_outboxes, :message_id, unique: true
    add_index :replynest_reception_outboxes, [:available_at, :id], where: "state='pending'", name: 'rn_reception_due'
    add_index :replynest_reception_outboxes, :locked_at, where: "state='processing'", name: 'rn_reception_locked'
    add_check_constraint :replynest_reception_outboxes, "state IN ('pending','processing','delivered','failed')", name: 'rn_reception_state'
  end
end
