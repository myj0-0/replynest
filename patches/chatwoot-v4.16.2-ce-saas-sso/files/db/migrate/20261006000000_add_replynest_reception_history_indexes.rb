# frozen_string_literal: true
class AddReplynestReceptionHistoryIndexes < ActiveRecord::Migration[7.1]
  def up
    add_index :messages, [:account_id, :created_at, :id], order: {created_at: :desc, id: :desc},
      where: 'private=false AND message_type IN(0,1) AND content_type=0', name: 'rn_reception_history_page'
    add_index :conversations, [:account_id, :contact_id, :id], name: 'rn_reception_history_customer'
  end
  def down
    remove_index :messages, name: 'rn_reception_history_page'
    remove_index :conversations, name: 'rn_reception_history_customer'
  end
end
