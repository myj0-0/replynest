# frozen_string_literal: true
class ReplynestWechatHistoryReceipt < ApplicationRecord
  # A durable, server-only native receipt, never a client-provided JSON flag.
  def self.projected_message?(message)
    return false unless message.id && message.account_id && message.inbox_id && message.conversation_id
    # Old/default-off images can load this compatibility hook before the new
    # explicit migration. SchemaCache caches this lookup; no startup DDL occurs.
    return false unless table_exists?
    exists?(message_id: message.id, account_id: message.account_id, inbox_id: message.inbox_id, conversation_id: message.conversation_id)
  end
end
