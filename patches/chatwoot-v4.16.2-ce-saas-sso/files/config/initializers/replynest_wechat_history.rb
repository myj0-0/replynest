# frozen_string_literal: true
module ReplynestWechatHistoryMessage
  private

  def execute_after_create_commit_callbacks
    return super unless ReplynestWechatHistoryReceipt.projected_message?(self)
    # No normal dispatcher, webhook, bot/automation listeners, template hook,
    # reopening, wait-time clearing or provider/email job for a historic echo.
    dispatch_replynest_history_ui(:message_created)
  end

  def dispatch_update_event
    return super unless ReplynestWechatHistoryReceipt.projected_message?(self)
    dispatch_replynest_history_ui(:message_updated) unless previous_changes.blank?
  end

  def send_reply
    return if ReplynestWechatHistoryReceipt.projected_message?(self)
    super
  end

  def dispatch_create_events
    return super unless ReplynestWechatHistoryReceipt.projected_message?(self)
    dispatch_replynest_history_ui(:message_created)
  end

  def dispatch_replynest_history_ui(kind)
    event = Struct.new(:data).new({ message: self, previous_changes: previous_changes })
    ActionCableListener.instance.public_send(kind, event)
  end
end

module ReplynestWechatHistorySendJob
  def perform(message_id)
    message = Message.find_by(id: message_id)
    return if message && ReplynestWechatHistoryReceipt.projected_message?(message)
    super
  end
end

Rails.application.config.to_prepare do
  Message.prepend(ReplynestWechatHistoryMessage) unless Message < ReplynestWechatHistoryMessage
  SendReplyJob.prepend(ReplynestWechatHistorySendJob) unless SendReplyJob < ReplynestWechatHistorySendJob
end
