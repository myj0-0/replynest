# frozen_string_literal: true

# CRM SaaS patch: expose one internal, HMAC-authenticated token exchange endpoint.
# The endpoint reuses Chatwoot's existing five-minute, one-time SSO token flow.
Rails.application.config.filter_parameters += %i[email sso_auth_token]

Rails.application.routes.append do
  post '/internal/saas_sso/assignments/snapshot', to: 'internal/replynest_assignments#snapshot'
  post '/internal/saas_sso/assignments/assign', to: 'internal/replynest_assignments#assign'
  post '/internal/saas_sso/assignments/receipt', to: 'internal/replynest_assignments#receipt'
  post '/internal/saas_sso/exchange', to: 'internal/saas_sso#create'
  post '/internal/saas_sso/members/provision', to: 'internal/saas_sso#provision'
  post '/internal/saas_sso/members/deprovision', to: 'internal/saas_sso#deprovision'
  post '/internal/saas_sso/workspaces/provision', to: 'internal/saas_sso#provision_workspace'
end
