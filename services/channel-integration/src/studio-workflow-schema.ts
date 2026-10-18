import type {DatabaseComponent} from './database-runtime.js';

// Additive owner-only migration. Keep the shared business fingerprint stable,
// so knowledge/status consumers and the old gateway remain rollback-compatible.
export const studioWorkflowSchema=`
CREATE TABLE IF NOT EXISTS studio_http_bindings (
 tenant_id TEXT NOT NULL,extension_id UUID NOT NULL,version INTEGER NOT NULL,action_key TEXT NOT NULL,
 endpoint TEXT NOT NULL,token_ciphertext TEXT,enabled BOOLEAN NOT NULL DEFAULT true,
 binding_id UUID NOT NULL DEFAULT gen_random_uuid(),approved_by UUID NOT NULL REFERENCES platform_users(platform_user_id),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(tenant_id,extension_id,version,action_key),
 FOREIGN KEY(tenant_id,extension_id,version) REFERENCES tenant_extension_versions(tenant_id,extension_id,version)
);
CREATE TABLE IF NOT EXISTS studio_action_runs (
 tenant_id TEXT NOT NULL,record_id UUID NOT NULL,action_key TEXT NOT NULL,
 run_id UUID NOT NULL DEFAULT gen_random_uuid(),status TEXT NOT NULL CHECK(status IN('sending','succeeded','uncertain')),
 actor_id UUID NOT NULL REFERENCES platform_users(platform_user_id),campaign_id UUID,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),completed_at TIMESTAMPTZ,
 PRIMARY KEY(tenant_id,record_id,action_key),FOREIGN KEY(tenant_id,record_id) REFERENCES tenant_extension_records(tenant_id,record_id)
);
CREATE INDEX IF NOT EXISTS studio_action_runs_budget ON studio_action_runs(tenant_id,created_at DESC);
ALTER TABLE tenant_automation_rules ADD COLUMN IF NOT EXISTS execution_authorized_at TIMESTAMPTZ;
ALTER TABLE tenant_automation_plan_runs ADD COLUMN IF NOT EXISTS event_message_id TEXT;
ALTER TABLE tenant_automation_plan_runs ADD COLUMN IF NOT EXISTS event_conversation_id UUID;
ALTER TABLE tenant_automation_plan_runs ADD COLUMN IF NOT EXISTS event_inbox_id TEXT;
ALTER TABLE tenant_automation_plan_runs DROP CONSTRAINT IF EXISTS tenant_automation_plan_runs_source_check;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='tenant_automation_plan_runs'::regclass AND conname='tenant_automation_plan_runs_source_v2_check') THEN
  ALTER TABLE tenant_automation_plan_runs ADD CONSTRAINT tenant_automation_plan_runs_source_v2_check CHECK(source IN ('manual','schedule','event'));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='tenant_automation_plan_runs'::regclass AND conname='tenant_automation_event_source_check') THEN
  ALTER TABLE tenant_automation_plan_runs ADD CONSTRAINT tenant_automation_event_source_check CHECK(
   (source='event' AND event_message_id IS NOT NULL AND event_message_id ~ '^[1-9][0-9]{0,18}$' AND event_inbox_id IS NOT NULL AND event_inbox_id ~ '^[1-9][0-9]{0,18}$' AND event_conversation_id IS NOT NULL AND schedule_grant_id IS NOT NULL)
   OR (source<>'event' AND event_message_id IS NULL AND event_conversation_id IS NULL AND event_inbox_id IS NULL));
 END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS tenant_automation_message_dedupe ON tenant_automation_plan_runs(tenant_id,rule_id,event_message_id) WHERE source='event';
CREATE INDEX IF NOT EXISTS tenant_automation_event_dispatch ON tenant_automation_plan_runs(completed_at) WHERE source='event' AND schedule_execution_state IS NULL;
`;
export function studioWorkflowComponent():DatabaseComponent{
 return {name:'studio_workflows',sql:studioWorkflowSchema,migrate:async()=>{throw Error('studio_owner_migration_required');}};
}
