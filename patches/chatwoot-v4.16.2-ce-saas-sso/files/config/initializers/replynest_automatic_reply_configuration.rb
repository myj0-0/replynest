# frozen_string_literal: true
# Independent default-off execution gate and secret; never reuse SSO/assignment keys.
Rails.application.routes.append do
  post '/internal/saas_sso/workbench_read/control', to: 'internal/replynest_workbench_read#control'
  post '/internal/saas_sso/reception_history/page', to: 'internal/replynest_reception_history#page'
  post '/internal/saas_sso/customer_insights_history/page', to: 'internal/replynest_customer_insights_history#page'
  post '/internal/saas_sso/customer_insights_history/permission', to: 'internal/replynest_customer_insights_history#permission'
  post '/internal/saas_sso/customer_automation/control', to: 'internal/replynest_customer_automation#control'
  post '/internal/saas_sso/automatic_replies/actor', to: 'internal/replynest_automatic_actors#actor'
  post '/internal/saas_sso/automatic_replies/snapshot', to: 'internal/replynest_automatic_replies#snapshot'
  post '/internal/saas_sso/automatic_replies/submit', to: 'internal/replynest_automatic_replies#submit'
  post '/internal/saas_sso/automatic_wechat/snapshot', to: 'internal/replynest_automatic_wechat#snapshot'
  post '/internal/saas_sso/automatic_wechat/authorize', to: 'internal/replynest_automatic_wechat#authorize'
  post '/internal/saas_sso/automatic_wechat/history', to: 'internal/replynest_wechat_history#project'
  post '/internal/saas_sso/verified_wechat/ingress', to: 'internal/replynest_verified_wechat#ingress'
end
Rails.application.config.filter_parameters += %i[content question authorization_at fence contact_identifier source_event_id source_occurred_at provider_accepted_at open_id source_id external_message_id]
Rails.application.config.filter_parameters += %i[contact_ids cursor after event_ids grant_id]
Rails.application.config.filter_parameters += %i[native_actor_email]
# HTTP filtering does not cover ActiveJob's argument inspection. Message broadcast
# arguments contain customer content, private notes and visitor stream identifiers.
# Keep lifecycle/class/job-id logs, but never render serialized arguments in them.
# Does not change queue payloads or the actual browser/customer delivery body.
Rails.application.config.active_job.log_arguments = false
Rails.application.config.after_initialize do
  if ENV['REPLYNEST_WORKBENCH_READ_ENABLED'] == 'true'
    Internal::ReplynestAutomaticRepliesController.transport_secret
    Internal::ReplynestWorkbenchReadController.verify_storage!
  end
  Internal::ReplynestAutomaticRepliesController.transport_secret if ENV['REPLYNEST_CUSTOMER_INSIGHTS_HISTORY_ENABLED'] == 'true'
  if ENV['REPLYNEST_AUTOMATIC_ACTOR_MANAGEMENT_ENABLED'] == 'true' || ENV['REPLYNEST_ATOMIC_WEB_REPLY_ENABLED'] == 'true' || ENV['REPLYNEST_ATOMIC_WECHAT_REPLY_ENABLED'] == 'true' || ENV['REPLYNEST_VERIFIED_WECHAT_INGRESS_ENABLED'] == 'true' || ENV['REPLYNEST_WECHAT_HISTORY_ENABLED'] == 'true' || ENV['REPLYNEST_RECEPTION_HISTORY_READ_ENABLED'] == 'true'
    Internal::ReplynestAutomaticRepliesController.transport_secret
  end
end
