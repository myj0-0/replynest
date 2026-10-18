export const automationRuleSchema = `
CREATE TABLE IF NOT EXISTS tenant_automation_rules (
 tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id), rule_id UUID NOT NULL DEFAULT gen_random_uuid(),
 name TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, active_revision INTEGER,
 enabled BOOLEAN NOT NULL DEFAULT false, approved_by UUID REFERENCES platform_users(platform_user_id),
 next_run_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(tenant_id,rule_id)
);
CREATE TABLE IF NOT EXISTS tenant_automation_rule_versions (
 tenant_id TEXT NOT NULL, rule_id UUID NOT NULL, revision INTEGER NOT NULL,
 definition JSONB NOT NULL, created_by UUID NOT NULL REFERENCES platform_users(platform_user_id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(tenant_id,rule_id,revision), FOREIGN KEY(tenant_id,rule_id) REFERENCES tenant_automation_rules(tenant_id,rule_id)
);
CREATE TABLE IF NOT EXISTS tenant_automation_plan_runs (
 tenant_id TEXT NOT NULL, rule_id UUID NOT NULL, run_id UUID NOT NULL DEFAULT gen_random_uuid(),
 revision INTEGER NOT NULL, scheduled_at TIMESTAMPTZ NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','running','completed','partial','cancelled','failed','interrupted','missed')),
 source TEXT NOT NULL CHECK(source IN ('manual','schedule')), result JSONB NOT NULL DEFAULT '{}',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
 PRIMARY KEY(tenant_id,run_id), UNIQUE(tenant_id,rule_id,scheduled_at),
 FOREIGN KEY(tenant_id,rule_id,revision) REFERENCES tenant_automation_rule_versions(tenant_id,rule_id,revision)
);
CREATE INDEX IF NOT EXISTS tenant_automation_rules_due ON tenant_automation_rules(next_run_at) WHERE enabled;
CREATE INDEX IF NOT EXISTS tenant_automation_plan_runs_list ON tenant_automation_plan_runs(tenant_id,rule_id,created_at DESC);
CREATE INDEX IF NOT EXISTS tenant_automation_plan_pending ON tenant_automation_plan_runs(tenant_id,created_at,run_id) WHERE state='pending';
CREATE TABLE IF NOT EXISTS tenant_automation_plan_fairness (
 tenant_id TEXT PRIMARY KEY REFERENCES tenants(tenant_id), last_claimed_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE tenant_automation_plan_runs ADD COLUMN IF NOT EXISTS lease_token UUID;
ALTER TABLE tenant_automation_plan_runs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE tenant_automation_plan_runs ADD COLUMN IF NOT EXISTS claim_attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS tenant_automation_plan_running ON tenant_automation_plan_runs(lease_expires_at,tenant_id) WHERE state='running';
CREATE TABLE IF NOT EXISTS tenant_assignment_commands (
 tenant_id TEXT NOT NULL, command_id UUID NOT NULL DEFAULT gen_random_uuid(), run_id UUID NOT NULL,
 conversation_id UUID NOT NULL, target_member_id UUID NOT NULL REFERENCES platform_users(platform_user_id), approved_by UUID NOT NULL REFERENCES platform_users(platform_user_id),
 request JSONB NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','applied','state_changed','rejected','command_conflict','uncertain','cancelled')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(tenant_id,command_id), UNIQUE(tenant_id,run_id,conversation_id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES tenant_automation_plan_runs(tenant_id,run_id)
);
ALTER TABLE tenant_automation_rules ADD COLUMN IF NOT EXISTS schedule_grant_id UUID;
ALTER TABLE tenant_automation_plan_runs ADD COLUMN IF NOT EXISTS schedule_grant_id UUID;
ALTER TABLE tenant_automation_plan_runs ADD COLUMN IF NOT EXISTS schedule_execution_state TEXT CHECK(schedule_execution_state IN ('queued','skipped'));
ALTER TABLE tenant_automation_plan_runs ADD COLUMN IF NOT EXISTS schedule_execution_code TEXT;
ALTER TABLE tenant_assignment_commands ADD COLUMN IF NOT EXISTS schedule_grant_id UUID;
CREATE INDEX IF NOT EXISTS tenant_automation_schedule_dispatch ON tenant_automation_plan_runs(completed_at) WHERE source='schedule' AND schedule_grant_id IS NOT NULL AND schedule_execution_state IS NULL;
`;
