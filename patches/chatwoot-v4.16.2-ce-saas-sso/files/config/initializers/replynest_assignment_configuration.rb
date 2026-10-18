# Fail startup only when explicitly enabling this execution adapter.
Rails.application.config.after_initialize do
  if ENV['REPLYNEST_ATOMIC_ASSIGNMENT_ENABLED'] == 'true'
    Internal::ReplynestAssignmentsController.assignment_secret
  end
end
