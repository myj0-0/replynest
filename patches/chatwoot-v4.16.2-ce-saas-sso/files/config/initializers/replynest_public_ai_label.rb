# frozen_string_literal: true

# Visitor presentation only. Stored Message/AgentBot, staff events, webhook payloads
# and history exclusions keep their genuine automatic-reception provenance.
module ReplyNestVisitorAiLabel
  def replynest_visitor_sender
    data = sender&.push_event_data
    return data unless replynest_automatic_widget_reply?

    data.merge(name: content_attributes['replynest_show_ai_label'] == true ? '答巢自动接待 · AI生成' : '客服')
  end

  def replynest_automatic_widget_reply?
    !private? && outgoing? && sender.is_a?(AgentBot) &&
      content_attributes['replynest_transport'] == 'automatic_web_chat'
  end

  def replynest_visitor_event_data
    push_event_data.merge(sender: replynest_visitor_sender)
  end
end

module ReplyNestVisitorAiLabelEvents
  def message_created(event)
    message = event.data[:message]
    return super unless message.replynest_automatic_widget_reply?

    replynest_label_broadcast(event, MESSAGE_CREATED)
  end

  def message_updated(event)
    message = event.data[:message]
    return super unless message.replynest_automatic_widget_reply?

    replynest_label_broadcast(event, MESSAGE_UPDATED, previous_changes: event.data[:previous_changes])
  end

  private

  def replynest_label_broadcast(event, event_name, extra = {})
    message, account = extract_message_and_account(event)
    conversation = message.conversation
    # Separate audiences using the native token selectors, including verified
    # contact inboxes. Never send a private/staff event to a new audience.
    staff = user_tokens(account, conversation.inbox.members)
    visitors = contact_tokens(conversation.contact_inbox, message) - staff
    broadcast(account, staff, event_name, message.push_event_data.merge(extra))
    broadcast(account, visitors, event_name, message.replynest_visitor_event_data.merge(extra))
  end
end

Rails.application.config.to_prepare do
  ReplyNestVisitorAiLabelEvents.include(Events::Types)
  Message.prepend(ReplyNestVisitorAiLabel) unless Message < ReplyNestVisitorAiLabel
  ActionCableListener.prepend(ReplyNestVisitorAiLabelEvents) unless ActionCableListener < ReplyNestVisitorAiLabelEvents
end
