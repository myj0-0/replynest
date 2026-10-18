# frozen_string_literal: true

# ReplyNest owns the tenant-facing release lifecycle. Exposing the upstream
# Chatwoot release banner to tenant agents is misleading, so keep the upstream
# version polling intact for operators but omit the value from the account API.
module ReplyNestProductUi
  def show
    @latest_chatwoot_version = nil
    render 'api/v1/accounts/show', format: :json
  end
end

Rails.application.config.to_prepare do
  controller = Api::V1::AccountsController
  controller.prepend(ReplyNestProductUi) unless controller < ReplyNestProductUi
end
