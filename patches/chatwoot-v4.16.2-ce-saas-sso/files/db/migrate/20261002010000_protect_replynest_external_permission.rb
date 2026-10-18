# frozen_string_literal: true

class ProtectReplynestExternalPermission < ActiveRecord::Migration[7.1]
  def up
    # Both public native submissions and external-provider permissions consume the
    # same source once, even if an inbox is subsequently converted to another type.
    add_index :replynest_automatic_receipts, [:account_id, :source_message_id], unique: true,
      where: "result->>'state' IN ('accepted','transport_authorized')", name: 'rn_automatic_all_transport_once'
  end

  def down
    raise ActiveRecord::IrreversibleMigration, 'external permission history must not be made replayable'
  end
end
