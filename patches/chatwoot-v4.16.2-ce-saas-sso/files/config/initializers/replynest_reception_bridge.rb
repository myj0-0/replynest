module ReplynestReceptionCapture
  extend ActiveSupport::Concern
  included do
    after_create :record_replynest_reception_event
  end
  def record_replynest_reception_event
    ReplynestReceptionOutbox.capture(self)
  end
end

Rails.application.config.to_prepare do
  Message.include(ReplynestReceptionCapture) unless Message < ReplynestReceptionCapture
end
