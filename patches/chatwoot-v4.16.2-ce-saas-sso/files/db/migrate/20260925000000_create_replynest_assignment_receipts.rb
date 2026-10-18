class CreateReplynestAssignmentReceipts < ActiveRecord::Migration[7.1]
  def change
    create_table :replynest_assignment_receipts, id: :uuid do |t|
      t.string :request_digest, null: false
      t.bigint :account_id, null: false
      t.jsonb :result, null: false
      t.timestamps
    end
  end
end
