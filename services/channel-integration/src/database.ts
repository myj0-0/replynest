import {BoundedPool} from './bounded-pool.js';
import {receptionSchema} from './reception-store.js';
import {massCampaignSchema} from './mass-campaign-store.js';
import {campaignMonitorSchema} from './campaign-monitor-core.js';
import {knowledgeListSchema} from './knowledge-list.js';
import { createHash } from "node:crypto";
import { requiredEnv } from "./shared.js";
import { planCheckoutSchema } from "./plan-checkout-schema.js";
import { paymentRefundSchema } from "./payment-refund-schema.js";
import { walletSchema } from "./wallet-schema.js";
import { templateMarketSchema } from './template-market-schema.js';
import { aiPointsSchema } from './ai-points-schema.js';
import { growthPolicySchema } from './growth-policy-schema.js';
import {subscriptionMailSchema} from './subscription-mail-schema.js';
import {aiLowMailSchema} from './ai-low-mail-schema.js';
import {aiUsageSummarySchema} from './ai-usage-summary.js';
import { planPricingSchema } from "./plan-pricing-schema.js";
import { extensionSchema } from "./extension-schema.js";
import { automationRuleSchema } from "./automation-rule-schema.js";
import { openPlatformSchema } from "./open-platform-schema.js";
import {quotaScanSchema} from './quota-scan.js';

export const pool = new BoundedPool({
  host: requiredEnv("POSTGRES_HOST"),
  port: 5432,
  database: requiredEnv("POSTGRES_DATABASE"),
  user: requiredEnv("POSTGRES_USERNAME"),
  password: requiredEnv("POSTGRES_PASSWORD"),
  max: 10
});

/** Fully expanded DDL is also fingerprinted by the explicit owner migration. */
export function businessSchemaSql(): string {
  return `
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE IF NOT EXISTS tenants (
      tenant_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'test')),
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      chatwoot_account_id BIGINT UNIQUE,
      signup_source TEXT,
      referral_code_entered TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (status <> 'active' OR chatwoot_account_id IS NOT NULL)
    );
    ${quotaScanSchema}
    CREATE TABLE IF NOT EXISTS platform_users (
      platform_user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (email=LOWER(email))
    );
    ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS password_hash TEXT;
    ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
    ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
    ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
    ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS phone_e164 TEXT;
    ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;
    CREATE UNIQUE INDEX IF NOT EXISTS platform_users_verified_phone_idx
      ON platform_users(phone_e164) WHERE phone_verified_at IS NOT NULL;
    CREATE TABLE IF NOT EXISTS tenant_memberships (
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      platform_user_id UUID NOT NULL REFERENCES platform_users(platform_user_id),
      role TEXT NOT NULL CHECK (role IN ('tenant_admin','supervisor','agent')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
      chatwoot_user_id BIGINT NOT NULL,
      chatwoot_user_email TEXT NOT NULL,
      chatwoot_account_id BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id,platform_user_id),
      UNIQUE (tenant_id,chatwoot_user_id),
      UNIQUE (tenant_id,chatwoot_user_email)
    );
    ALTER TABLE tenant_memberships ADD COLUMN IF NOT EXISTS chatwoot_sync_status TEXT NOT NULL DEFAULT 'synced';
    ALTER TABLE tenant_memberships ADD COLUMN IF NOT EXISTS chatwoot_sync_error TEXT;
    ALTER TABLE tenant_memberships ADD COLUMN IF NOT EXISTS chatwoot_synced_at TIMESTAMPTZ;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tenant_memberships_chatwoot_sync_status_check') THEN
        ALTER TABLE tenant_memberships ADD CONSTRAINT tenant_memberships_chatwoot_sync_status_check
          CHECK (chatwoot_sync_status IN ('pending','synced','failed'));
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS member_invitations (
      invitation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      email TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('tenant_admin','supervisor','agent')),
      token_hash TEXT NOT NULL UNIQUE,
      invited_by UUID NOT NULL REFERENCES platform_users(platform_user_id),
      expires_at TIMESTAMPTZ NOT NULL,
      accepted_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (email=LOWER(email))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS member_invitations_active_email_idx
      ON member_invitations(tenant_id,email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      reset_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      platform_user_id UUID NOT NULL REFERENCES platform_users(platform_user_id),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx
      ON password_reset_tokens(platform_user_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS phone_verification_challenges (
      challenge_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      phone_e164 TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('registration','phone_change','account_recovery')),
      code_hash TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('mock','aliyun')),
      provider_message_id TEXT,
      send_status TEXT NOT NULL CHECK (send_status IN ('pending','accepted','failed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
      expires_at TIMESTAMPTZ NOT NULL,
      verified_at TIMESTAMPTZ,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS phone_verification_active_phone_idx
      ON phone_verification_challenges(phone_e164,purpose,created_at DESC)
      WHERE verified_at IS NULL AND consumed_at IS NULL;
    ALTER TABLE phone_verification_challenges ADD COLUMN IF NOT EXISTS provider_code TEXT;
    ALTER TABLE phone_verification_challenges ADD COLUMN IF NOT EXISTS failure_category TEXT;
    ALTER TABLE phone_verification_challenges ADD COLUMN IF NOT EXISTS failure_retryable BOOLEAN;
    ALTER TABLE phone_verification_challenges ADD COLUMN IF NOT EXISTS estimated_cost_minor INTEGER NOT NULL DEFAULT 0 CHECK(estimated_cost_minor>=0);
    ALTER TABLE phone_verification_challenges ADD COLUMN IF NOT EXISTS delivery_updated_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS phone_verification_delivery_created_idx
      ON phone_verification_challenges(purpose,created_at DESC,send_status);
    CREATE TABLE IF NOT EXISTS registration_attempts (
      registration_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      idempotency_key TEXT NOT NULL UNIQUE CHECK(char_length(idempotency_key) BETWEEN 16 AND 128),
      request_fingerprint TEXT NOT NULL,
      resume_token_hash TEXT NOT NULL UNIQUE,
      email_token_hash TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL CHECK(email=LOWER(email)),
      display_name TEXT NOT NULL,
      company_name TEXT NOT NULL,
      phone_e164 TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      referral_code TEXT,
      proposed_tenant_id TEXT NOT NULL UNIQUE,
      phone_challenge_id UUID REFERENCES phone_verification_challenges(challenge_id),
      status TEXT NOT NULL DEFAULT 'awaiting_verification'
        CHECK(status IN ('awaiting_verification','ready','provisioning','completed','failed','expired')),
      email_expires_at TIMESTAMPTZ NOT NULL,
      email_verified_at TIMESTAMPTZ,
      phone_verified_at TIMESTAMPTZ,
      chatwoot_account_id BIGINT,
      chatwoot_user_id BIGINT,
      platform_user_id UUID,
      tenant_id TEXT,
      failure_code TEXT,
      completed_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK((status='completed')=(completed_at IS NOT NULL)),
      CHECK(status<>'completed' OR (chatwoot_account_id IS NOT NULL AND chatwoot_user_id IS NOT NULL AND platform_user_id IS NOT NULL AND tenant_id IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS registration_active_email_idx ON registration_attempts(email)
      WHERE status IN ('awaiting_verification','ready','provisioning');
    CREATE UNIQUE INDEX IF NOT EXISTS registration_active_phone_idx ON registration_attempts(phone_e164)
      WHERE status IN ('awaiting_verification','ready','provisioning');
    ALTER TABLE registration_attempts ADD COLUMN IF NOT EXISTS terms_version TEXT;
    ALTER TABLE registration_attempts ADD COLUMN IF NOT EXISTS privacy_version TEXT;
    ALTER TABLE registration_attempts ADD COLUMN IF NOT EXISTS legal_consented_at TIMESTAMPTZ;
    ALTER TABLE registration_attempts ADD COLUMN IF NOT EXISTS personal_data_state TEXT NOT NULL DEFAULT 'active';
    ALTER TABLE registration_attempts ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='registration_attempts_personal_data_state_check') THEN
        ALTER TABLE registration_attempts ADD CONSTRAINT registration_attempts_personal_data_state_check
          CHECK(personal_data_state IN ('active','anonymized'));
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS registration_events (
      registration_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      registration_id UUID NOT NULL REFERENCES registration_attempts(registration_id),
      event_type TEXT NOT NULL,
      facts JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(facts)='object'),
      request_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS registration_events_attempt_idx ON registration_events(registration_id,created_at);
    CREATE OR REPLACE FUNCTION prevent_registration_event_mutation() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'registration events are append-only'; END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS registration_events_append_only ON registration_events;
    CREATE TRIGGER registration_events_append_only BEFORE UPDATE OR DELETE ON registration_events
      FOR EACH ROW EXECUTE FUNCTION prevent_registration_event_mutation();
    CREATE TABLE IF NOT EXISTS registration_security_events (
      security_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id UUID NOT NULL,
      signal_kind TEXT NOT NULL CHECK(signal_kind IN ('ip','device','email','phone','global')),
      signal_hash TEXT NOT NULL CHECK(char_length(signal_hash)=64),
      outcome TEXT NOT NULL CHECK(outcome IN ('allowed','denied')),
      reason_code TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(request_id,signal_kind)
    );
    CREATE INDEX IF NOT EXISTS registration_security_signal_window_idx
      ON registration_security_events(signal_kind,signal_hash,created_at DESC);
    CREATE INDEX IF NOT EXISTS registration_security_request_idx ON registration_security_events(request_id);
    CREATE TABLE IF NOT EXISTS registration_verification_budgets (
      budget_date DATE NOT NULL,
      channel TEXT NOT NULL CHECK(channel IN ('sms')),
      reserved_count INTEGER NOT NULL DEFAULT 0 CHECK(reserved_count>=0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(budget_date,channel)
    );
    CREATE OR REPLACE FUNCTION prevent_registration_security_event_mutation() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'registration security events are append-only'; END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS registration_security_events_append_only ON registration_security_events;
    CREATE TRIGGER registration_security_events_append_only BEFORE UPDATE OR DELETE ON registration_security_events
      FOR EACH ROW EXECUTE FUNCTION prevent_registration_security_event_mutation();
    ALTER TABLE registration_attempts ALTER COLUMN password_hash DROP NOT NULL;
    UPDATE registration_attempts SET password_hash=NULL WHERE status='completed' AND password_hash IS NOT NULL;
    CREATE TABLE IF NOT EXISTS console_sessions (
      session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      token_hash TEXT NOT NULL UNIQUE,
      platform_user_id UUID NOT NULL REFERENCES platform_users(platform_user_id),
      selected_tenant_id TEXT REFERENCES tenants(tenant_id),
      user_session_version INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      revoke_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS console_sessions_user_active_idx
      ON console_sessions(platform_user_id,expires_at) WHERE revoked_at IS NULL;
    ALTER TABLE console_sessions ADD COLUMN IF NOT EXISTS session_scope TEXT NOT NULL DEFAULT 'console';
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='console_sessions_scope_check') THEN
        ALTER TABLE console_sessions ADD CONSTRAINT console_sessions_scope_check
          CHECK(session_scope IN ('console','copilot_embed'));
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS platform_admin_accounts (
      admin_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL UNIQUE CHECK (email=LOWER(email)),
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner','admin','support','auditor')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
      session_version INTEGER NOT NULL DEFAULT 1,
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS platform_admin_sessions (
      session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      token_hash TEXT NOT NULL UNIQUE,
      admin_id UUID NOT NULL REFERENCES platform_admin_accounts(admin_id),
      admin_session_version INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      revoke_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS platform_admin_sessions_active_idx
      ON platform_admin_sessions(admin_id,expires_at) WHERE revoked_at IS NULL;
    ALTER TABLE platform_admin_accounts ADD COLUMN IF NOT EXISTS mfa_secret_ciphertext TEXT;
    ALTER TABLE platform_admin_accounts ADD COLUMN IF NOT EXISTS mfa_pending_ciphertext TEXT;
    ALTER TABLE platform_admin_accounts ADD COLUMN IF NOT EXISTS mfa_pending_expires_at TIMESTAMPTZ;
    ALTER TABLE platform_admin_accounts ADD COLUMN IF NOT EXISTS mfa_enabled_at TIMESTAMPTZ;
    ALTER TABLE platform_admin_accounts ADD COLUMN IF NOT EXISTS recovery_code_hashes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
    CREATE TABLE IF NOT EXISTS platform_impersonations (
      impersonation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_id UUID NOT NULL REFERENCES platform_admin_accounts(admin_id),
      target_platform_user_id UUID NOT NULL REFERENCES platform_users(platform_user_id),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 500),
      ticket_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      console_session_id UUID REFERENCES console_sessions(session_id),
      ended_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE console_sessions ADD COLUMN IF NOT EXISTS impersonation_id UUID REFERENCES platform_impersonations(impersonation_id);
    ALTER TABLE console_sessions ADD COLUMN IF NOT EXISTS impersonated_by_admin_id UUID REFERENCES platform_admin_accounts(admin_id);
    CREATE TABLE IF NOT EXISTS platform_admin_audit_logs (
      audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_admin_id UUID NOT NULL REFERENCES platform_admin_accounts(admin_id),
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      tenant_id TEXT REFERENCES tenants(tenant_id),
      target_platform_user_id UUID REFERENCES platform_users(platform_user_id),
      reason TEXT,
      before_data JSONB,
      after_data JSONB,
      request_id UUID NOT NULL,
      impersonation_id UUID REFERENCES platform_impersonations(impersonation_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS platform_admin_audit_created_idx ON platform_admin_audit_logs(created_at DESC);
    CREATE OR REPLACE FUNCTION prevent_platform_admin_audit_mutation() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'platform_admin_audit_logs are append-only'; END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS platform_admin_audit_append_only ON platform_admin_audit_logs;
    CREATE TRIGGER platform_admin_audit_append_only BEFORE UPDATE OR DELETE ON platform_admin_audit_logs
      FOR EACH ROW EXECUTE FUNCTION prevent_platform_admin_audit_mutation();
    CREATE TABLE IF NOT EXISTS registration_runtime_controls (
      control_key TEXT PRIMARY KEY CHECK(control_key='self_service_registration'),
      emergency_paused BOOLEAN NOT NULL DEFAULT FALSE,
      reason TEXT,
      updated_by UUID REFERENCES platform_admin_accounts(admin_id),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE registration_runtime_controls ADD COLUMN IF NOT EXISTS sms_daily_budget INTEGER CHECK(sms_daily_budget BETWEEN 1 AND 1000000);
    INSERT INTO registration_runtime_controls(control_key,emergency_paused)
      VALUES('self_service_registration',FALSE) ON CONFLICT(control_key) DO NOTHING;
    CREATE TABLE IF NOT EXISTS registration_control_events (
      control_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      action TEXT NOT NULL CHECK(action IN ('paused','resumed')),
      before_paused BOOLEAN NOT NULL,
      after_paused BOOLEAN NOT NULL,
      reason TEXT NOT NULL CHECK(char_length(reason) BETWEEN 10 AND 500),
      actor_admin_id UUID NOT NULL REFERENCES platform_admin_accounts(admin_id),
      actor_role TEXT NOT NULL,
      request_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK(before_paused<>after_paused)
    );
    CREATE INDEX IF NOT EXISTS registration_control_events_created_idx ON registration_control_events(created_at DESC);
    CREATE OR REPLACE FUNCTION prevent_registration_control_event_mutation() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'registration control events are append-only'; END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS registration_control_events_append_only ON registration_control_events;
    CREATE TRIGGER registration_control_events_append_only BEFORE UPDATE OR DELETE ON registration_control_events
      FOR EACH ROW EXECUTE FUNCTION prevent_registration_control_event_mutation();
    CREATE TABLE IF NOT EXISTS registration_pilot_batches (
      pilot_batch_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_code TEXT NOT NULL UNIQUE CHECK(batch_code ~ '^PILOT-[A-Z0-9-]{6,40}$'),
      name TEXT NOT NULL CHECK(char_length(name) BETWEEN 3 AND 100),
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ready','active','paused','completed','cancelled')),
      max_registrations INTEGER NOT NULL CHECK(max_registrations BETWEEN 1 AND 100),
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      on_call_name TEXT NOT NULL CHECK(char_length(on_call_name) BETWEEN 2 AND 100),
      on_call_contact TEXT NOT NULL CHECK(char_length(on_call_contact) BETWEEN 3 AND 200),
      created_by UUID NOT NULL REFERENCES platform_admin_accounts(admin_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK(ends_at>starts_at)
    );
    CREATE INDEX IF NOT EXISTS registration_pilot_batches_status_idx ON registration_pilot_batches(status,starts_at,ends_at);
    CREATE TABLE IF NOT EXISTS registration_pilot_invites (
      pilot_invite_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      pilot_batch_id UUID NOT NULL REFERENCES registration_pilot_batches(pilot_batch_id),
      invite_code_hash TEXT NOT NULL UNIQUE CHECK(char_length(invite_code_hash)=64),
      display_hint TEXT NOT NULL CHECK(char_length(display_hint) BETWEEN 5 AND 20),
      recipient_ref TEXT NOT NULL CHECK(char_length(recipient_ref) BETWEEN 2 AND 120),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked','consumed')),
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_by UUID NOT NULL REFERENCES platform_admin_accounts(admin_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK((status='consumed')=(consumed_at IS NOT NULL)),
      CHECK((status='revoked')=(revoked_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS registration_pilot_invites_batch_idx ON registration_pilot_invites(pilot_batch_id,status,created_at);
    ALTER TABLE registration_attempts ADD COLUMN IF NOT EXISTS pilot_invite_id UUID REFERENCES registration_pilot_invites(pilot_invite_id);
    CREATE UNIQUE INDEX IF NOT EXISTS registration_attempts_active_pilot_invite_idx ON registration_attempts(pilot_invite_id)
      WHERE pilot_invite_id IS NOT NULL AND status IN ('awaiting_verification','ready','provisioning','completed');
    CREATE TABLE IF NOT EXISTS registration_pilot_checks (
      pilot_batch_id UUID NOT NULL REFERENCES registration_pilot_batches(pilot_batch_id),
      check_key TEXT NOT NULL CHECK(check_key IN ('on_call_confirmed','backup_verified','support_channel_confirmed','pilot_scope_confirmed','rollback_rehearsed')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','passed')),
      evidence TEXT CHECK(evidence IS NULL OR char_length(evidence) BETWEEN 10 AND 500),
      checked_by UUID REFERENCES platform_admin_accounts(admin_id),
      checked_at TIMESTAMPTZ,
      PRIMARY KEY(pilot_batch_id,check_key),
      CHECK((status='passed')=(checked_at IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS registration_pilot_events (
      pilot_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      pilot_batch_id UUID NOT NULL REFERENCES registration_pilot_batches(pilot_batch_id),
      pilot_invite_id UUID REFERENCES registration_pilot_invites(pilot_invite_id),
      event_type TEXT NOT NULL,
      actor_admin_id UUID NOT NULL REFERENCES platform_admin_accounts(admin_id),
      facts JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(facts)='object'),
      request_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS registration_pilot_events_batch_idx ON registration_pilot_events(pilot_batch_id,created_at DESC);
    CREATE OR REPLACE FUNCTION prevent_registration_pilot_event_mutation() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'registration pilot events are append-only'; END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS registration_pilot_events_append_only ON registration_pilot_events;
    CREATE TRIGGER registration_pilot_events_append_only BEFORE UPDATE OR DELETE ON registration_pilot_events
      FOR EACH ROW EXECUTE FUNCTION prevent_registration_pilot_event_mutation();
    CREATE TABLE IF NOT EXISTS privacy_requests (
      privacy_request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      platform_user_id UUID NOT NULL REFERENCES platform_users(platform_user_id),
      request_type TEXT NOT NULL CHECK(request_type IN ('access','copy','correction','deletion','withdraw_consent','account_closure')),
      status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','identity_verification','in_review','fulfilled','partially_fulfilled','rejected','cancelled')),
      details TEXT NOT NULL DEFAULT '' CHECK(char_length(details)<=2000),
      due_at TIMESTAMPTZ NOT NULL,
      assigned_admin_id UUID REFERENCES platform_admin_accounts(admin_id),
      resolution_summary TEXT CHECK(resolution_summary IS NULL OR char_length(resolution_summary)<=2000),
      legal_hold_reason TEXT CHECK(legal_hold_reason IS NULL OR char_length(legal_hold_reason)<=1000),
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK((status IN ('fulfilled','partially_fulfilled','rejected','cancelled'))=(completed_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS privacy_requests_user_idx ON privacy_requests(platform_user_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS privacy_requests_operations_idx ON privacy_requests(status,due_at,created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS privacy_requests_active_type_idx ON privacy_requests(tenant_id,platform_user_id,request_type)
      WHERE status IN ('submitted','identity_verification','in_review');
    CREATE TABLE IF NOT EXISTS privacy_request_events (
      privacy_request_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      privacy_request_id UUID NOT NULL REFERENCES privacy_requests(privacy_request_id),
      event_type TEXT NOT NULL CHECK(event_type IN ('submitted','identity_verification_requested','review_started','fulfilled','partially_fulfilled','rejected','cancelled')),
      actor_type TEXT NOT NULL CHECK(actor_type IN ('platform_user','platform_admin','system')),
      actor_id TEXT NOT NULL,
      reason TEXT,
      facts JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(facts)='object'),
      request_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS privacy_request_events_request_idx ON privacy_request_events(privacy_request_id,created_at);
    CREATE OR REPLACE FUNCTION prevent_privacy_request_event_mutation() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'privacy request events are append-only'; END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS privacy_request_events_append_only ON privacy_request_events;
    CREATE TRIGGER privacy_request_events_append_only BEFORE UPDATE OR DELETE ON privacy_request_events
      FOR EACH ROW EXECUTE FUNCTION prevent_privacy_request_event_mutation();
    CREATE TABLE IF NOT EXISTS customers (
      customer_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS customers_tenant_updated_idx ON customers (tenant_id, updated_at DESC, customer_id);
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS support_note TEXT NOT NULL DEFAULT '';
    CREATE TABLE IF NOT EXISTS tenant_api_keys (
      key_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      key_hash TEXT NOT NULL UNIQUE,
      key_hint TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('tenant_admin', 'supervisor', 'agent')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
      platform_user_id UUID REFERENCES platform_users(platform_user_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ
    );
    ALTER TABLE tenant_api_keys ADD COLUMN IF NOT EXISTS platform_user_id UUID REFERENCES platform_users(platform_user_id);
    CREATE TABLE IF NOT EXISTS tenant_ai_settings (
      tenant_id TEXT PRIMARY KEY REFERENCES tenants(tenant_id),
      llm_provider TEXT NOT NULL DEFAULT 'deterministic' CHECK (llm_provider IN ('deterministic','deepseek')),
      llm_model TEXT NOT NULL DEFAULT 'deterministic-phase4-sample',
      llm_credential_ref TEXT,
      embedding_provider TEXT NOT NULL DEFAULT 'none' CHECK (embedding_provider IN ('none','gemini')),
      embedding_model TEXT,
      embedding_dimensions INTEGER CHECK (embedding_dimensions=768),
      embedding_credential_ref TEXT,
      updated_by TEXT NOT NULL DEFAULT 'system',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (embedding_provider <> 'gemini' OR (embedding_model IS NOT NULL AND embedding_dimensions IS NOT NULL)),
      CHECK (embedding_provider <> 'none' OR (embedding_model IS NULL AND embedding_dimensions IS NULL))
    );
    ALTER TABLE tenant_ai_settings ADD COLUMN IF NOT EXISTS automatic_sending_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE tenant_ai_settings ADD COLUMN IF NOT EXISTS ai_auto_reply_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE tenant_ai_settings ADD COLUMN IF NOT EXISTS ai_auto_send_confidence_threshold_percent SMALLINT NOT NULL DEFAULT 90;
    ALTER TABLE tenant_ai_settings DROP CONSTRAINT IF EXISTS tenant_ai_settings_auto_send_threshold_check;
    ALTER TABLE tenant_ai_settings ADD CONSTRAINT tenant_ai_settings_auto_send_threshold_check
      CHECK (ai_auto_send_confidence_threshold_percent BETWEEN 50 AND 100);
    ALTER TABLE tenant_ai_settings ADD COLUMN IF NOT EXISTS automation_updated_by UUID REFERENCES platform_users(platform_user_id);
    ALTER TABLE tenant_ai_settings ADD COLUMN IF NOT EXISTS automation_updated_at TIMESTAMPTZ;
    ${receptionSchema}
    CREATE TABLE IF NOT EXISTS audit_logs (
      audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      reason TEXT,
      before_data JSONB,
      after_data JSONB,
      request_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS audit_logs_tenant_created_idx ON audit_logs (tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS admin_audit_global_created_idx ON audit_logs (created_at DESC);
    CREATE INDEX IF NOT EXISTS admin_tenants_name_id_idx ON tenants (name, tenant_id);
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE INDEX IF NOT EXISTS admin_tenants_name_search_idx ON tenants USING gin (name gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS admin_tenants_id_search_idx ON tenants USING gin (tenant_id gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS admin_users_email_search_idx ON platform_users USING gin (email gin_trgm_ops) WHERE status='active';
    CREATE INDEX IF NOT EXISTS admin_users_phone_search_idx ON platform_users USING gin ((regexp_replace(COALESCE(phone_e164,''),'[^0-9]','','g')) gin_trgm_ops) WHERE status='active';
    CREATE OR REPLACE FUNCTION prevent_audit_log_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'audit_logs are append-only';
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS audit_logs_append_only ON audit_logs;
    CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();
    CREATE TABLE IF NOT EXISTS idempotency_requests (
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      idempotency_key TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      response_status INTEGER NOT NULL,
      response_body JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS conversation_message_commands (
      command_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      conversation_replynest_id UUID NOT NULL,
      platform_user_id UUID NOT NULL REFERENCES platform_users(platform_user_id),
      idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
      request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
      state TEXT NOT NULL DEFAULT 'processing' CHECK (state IN ('processing','accepted','failed','uncertain')),
      upstream_message_id TEXT,
      response_status INTEGER,
      response_body JSONB,
      error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id,idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS conversation_message_commands_conversation_idx
      ON conversation_message_commands(tenant_id,conversation_replynest_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS conversation_action_commands (
      command_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      conversation_replynest_id UUID NOT NULL,
      platform_user_id UUID NOT NULL REFERENCES platform_users(platform_user_id),
      idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
      request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
      action TEXT NOT NULL CHECK (action IN ('claim','assign','set_status')),
      state TEXT NOT NULL DEFAULT 'processing' CHECK (state IN ('processing','accepted','failed','uncertain')),
      response_status INTEGER,
      response_body JSONB,
      error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id,idempotency_key)
    );
    ALTER TABLE conversation_action_commands DROP CONSTRAINT IF EXISTS conversation_action_commands_action_check;
    ALTER TABLE conversation_action_commands ADD CONSTRAINT conversation_action_commands_action_check
      CHECK (action IN ('claim','assign','set_status'));
    CREATE INDEX IF NOT EXISTS conversation_action_commands_conversation_idx
      ON conversation_action_commands(tenant_id,conversation_replynest_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS billing_accounts (
      billing_account_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','closed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id,currency)
    );
    CREATE TABLE IF NOT EXISTS ledger_transactions (
      transaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      transaction_type TEXT NOT NULL CHECK (transaction_type IN ('opening','topup','charge','refund','gift_grant','referral_reward','ai_credit_grant','expiration','adjustment','reversal')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','posted')),
      idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
      request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
      source_type TEXT NOT NULL CHECK (char_length(source_type) BETWEEN 1 AND 64),
      source_id TEXT NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 200),
      reversal_of UUID REFERENCES ledger_transactions(transaction_id),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
      occurred_at TIMESTAMPTZ NOT NULL,
      posted_at TIMESTAMPTZ,
      created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 200),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id,idempotency_key),
      CHECK ((status='pending' AND posted_at IS NULL) OR (status='posted' AND posted_at IS NOT NULL)),
      CHECK ((transaction_type='reversal') = (reversal_of IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ledger_transactions_single_reversal_idx
      ON ledger_transactions(reversal_of) WHERE reversal_of IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ledger_transactions_tenant_posted_idx
      ON ledger_transactions(tenant_id,posted_at DESC,transaction_id) WHERE status='posted';
    CREATE TABLE IF NOT EXISTS ledger_entries (
      entry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      transaction_id UUID NOT NULL REFERENCES ledger_transactions(transaction_id),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      account TEXT NOT NULL CHECK (account IN ('cash','gift','referral','ai_credit','revenue','clearing')),
      direction TEXT NOT NULL CHECK (direction IN ('debit','credit')),
      amount_minor BIGINT NOT NULL CHECK (amount_minor>0),
      currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (expires_at IS NULL OR (account IN ('gift','referral','ai_credit') AND direction='credit'))
    );
    CREATE INDEX IF NOT EXISTS ledger_entries_tenant_account_idx
      ON ledger_entries(tenant_id,account,currency,created_at);
    CREATE OR REPLACE FUNCTION enforce_ledger_entry_append_only() RETURNS trigger AS $$
    DECLARE parent_status TEXT; parent_tenant TEXT; parent_currency TEXT;
    BEGIN
      IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'ledger_entries are append-only'; END IF;
      SELECT status,tenant_id,currency INTO parent_status,parent_tenant,parent_currency
        FROM ledger_transactions WHERE transaction_id=NEW.transaction_id FOR UPDATE;
      IF parent_status IS NULL THEN RAISE EXCEPTION 'ledger transaction does not exist'; END IF;
      IF parent_status <> 'pending' THEN RAISE EXCEPTION 'posted ledger transaction is immutable'; END IF;
      IF NEW.tenant_id <> parent_tenant OR NEW.currency <> parent_currency THEN
        RAISE EXCEPTION 'ledger entry tenant or currency mismatch';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS ledger_entries_append_only ON ledger_entries;
    CREATE TRIGGER ledger_entries_append_only BEFORE INSERT OR UPDATE OR DELETE ON ledger_entries
      FOR EACH ROW EXECUTE FUNCTION enforce_ledger_entry_append_only();
    CREATE OR REPLACE FUNCTION enforce_ledger_transaction_lifecycle() RETURNS trigger AS $$
    DECLARE entry_count BIGINT; debit_total NUMERIC; credit_total NUMERIC;
    BEGIN
      IF TG_OP='INSERT' THEN
        IF NEW.status <> 'pending' OR NEW.posted_at IS NOT NULL THEN RAISE EXCEPTION 'ledger transaction must start pending'; END IF;
        RETURN NEW;
      END IF;
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ledger_transactions are append-only'; END IF;
      IF OLD.status <> 'pending' THEN RAISE EXCEPTION 'posted ledger transaction is immutable'; END IF;
      IF NEW.status <> 'posted' OR NEW.posted_at IS NULL THEN RAISE EXCEPTION 'only pending to posted transition is allowed'; END IF;
      IF (to_jsonb(NEW)-'status'-'posted_at') <> (to_jsonb(OLD)-'status'-'posted_at') THEN
        RAISE EXCEPTION 'ledger transaction facts are immutable';
      END IF;
      SELECT COUNT(*),COALESCE(SUM(amount_minor) FILTER (WHERE direction='debit'),0),COALESCE(SUM(amount_minor) FILTER (WHERE direction='credit'),0)
        INTO entry_count,debit_total,credit_total FROM ledger_entries WHERE transaction_id=OLD.transaction_id;
      IF entry_count < 2 OR debit_total <= 0 OR debit_total <> credit_total THEN
        RAISE EXCEPTION 'ledger transaction is not balanced';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS ledger_transactions_lifecycle ON ledger_transactions;
    CREATE TRIGGER ledger_transactions_lifecycle BEFORE INSERT OR UPDATE OR DELETE ON ledger_transactions
      FOR EACH ROW EXECUTE FUNCTION enforce_ledger_transaction_lifecycle();
    CREATE TABLE IF NOT EXISTS payment_orders (
      payment_order_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      order_number TEXT NOT NULL UNIQUE CHECK (order_number ~ '^RN[0-9A-Z]{20}$'),
      idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
      request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
      product_code TEXT NOT NULL CHECK (char_length(product_code) BETWEEN 2 AND 64),
      provider TEXT NOT NULL CHECK (provider IN ('synthetic','wechat_pay','alipay')),
      provider_order_id TEXT,
      currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency='CNY'),
      amount_minor BIGINT NOT NULL CHECK (amount_minor>0),
      refunded_minor BIGINT NOT NULL DEFAULT 0 CHECK (refunded_minor>=0 AND refunded_minor<=amount_minor),
      status TEXT NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment','paid','partially_refunded','refunded','chargeback','cancelled')),
      ledger_transaction_id UUID REFERENCES ledger_transactions(transaction_id),
      reversal_ledger_transaction_id UUID REFERENCES ledger_transactions(transaction_id),
      paid_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 200),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(tenant_id,idempotency_key),
      UNIQUE(provider,provider_order_id),
      CHECK ((status IN ('paid','partially_refunded','refunded','chargeback')) = (paid_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS payment_orders_tenant_created_idx ON payment_orders(tenant_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS payment_events (
      payment_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      payment_order_id UUID NOT NULL REFERENCES payment_orders(payment_order_id),
      provider TEXT NOT NULL CHECK (provider IN ('synthetic','wechat_pay','alipay')),
      provider_event_id TEXT NOT NULL CHECK (char_length(provider_event_id) BETWEEN 1 AND 200),
      event_type TEXT NOT NULL CHECK (event_type IN ('payment_succeeded','payment_refunded','payment_chargeback','payment_cancelled')),
      amount_minor BIGINT NOT NULL CHECK (amount_minor>=0),
      currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency='CNY'),
      payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
      occurred_at TIMESTAMPTZ NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(provider,provider_event_id)
    );
    CREATE INDEX IF NOT EXISTS payment_events_order_idx ON payment_events(payment_order_id,received_at,payment_event_id);
    CREATE TABLE IF NOT EXISTS payment_order_status_events (
      status_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      payment_order_id UUID NOT NULL REFERENCES payment_orders(payment_order_id),
      payment_event_id UUID REFERENCES payment_events(payment_event_id),
      from_status TEXT,
      to_status TEXT NOT NULL CHECK (to_status IN ('pending_payment','paid','partially_refunded','refunded','chargeback','cancelled')),
      outcome TEXT NOT NULL CHECK (outcome IN ('applied','deferred','ignored')),
      reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 200),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS payment_order_status_events_order_idx ON payment_order_status_events(payment_order_id,created_at,status_event_id);
    CREATE OR REPLACE FUNCTION prevent_payment_event_mutation() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'payment events are append-only'; END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS payment_events_append_only ON payment_events;
    CREATE TRIGGER payment_events_append_only BEFORE UPDATE OR DELETE ON payment_events FOR EACH ROW EXECUTE FUNCTION prevent_payment_event_mutation();
    DROP TRIGGER IF EXISTS payment_status_events_append_only ON payment_order_status_events;
    CREATE TRIGGER payment_status_events_append_only BEFORE UPDATE OR DELETE ON payment_order_status_events FOR EACH ROW EXECUTE FUNCTION prevent_payment_event_mutation();
    CREATE TABLE IF NOT EXISTS payment_ledger_outbox (
      outbox_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      payment_order_id UUID NOT NULL REFERENCES payment_orders(payment_order_id),
      payment_event_id UUID NOT NULL REFERENCES payment_events(payment_event_id),
      operation TEXT NOT NULL CHECK (operation IN ('settle','refund','chargeback')),
      amount_minor BIGINT NOT NULL CHECK (amount_minor>0),
      currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency='CNY'),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','succeeded','dead')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count>=0),
      available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      lease_until TIMESTAMPTZ,
      ledger_transaction_id UUID REFERENCES ledger_transactions(transaction_id),
      last_error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(payment_event_id)
    );
    CREATE INDEX IF NOT EXISTS payment_ledger_outbox_dispatch_idx ON payment_ledger_outbox(status,available_at,created_at);
    CREATE TABLE IF NOT EXISTS payment_reconciliation_runs (
      run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      scope_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
      difference_count INTEGER NOT NULL DEFAULT 0,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      error_code TEXT
    );
    CREATE TABLE IF NOT EXISTS payment_reconciliation_differences (
      difference_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id UUID NOT NULL REFERENCES payment_reconciliation_runs(run_id),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      payment_order_id UUID REFERENCES payment_orders(payment_order_id),
      payment_event_id UUID REFERENCES payment_events(payment_event_id),
      difference_type TEXT NOT NULL CHECK (difference_type IN ('outbox_missing','outbox_stale','outbox_dead','ledger_missing','ledger_amount_mismatch','order_amount_mismatch')),
      expected_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      actual_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','repair_requested','resolved')),
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(run_id,difference_type,payment_event_id)
    );
    CREATE INDEX IF NOT EXISTS payment_reconciliation_open_idx ON payment_reconciliation_differences(status,created_at DESC);
    CREATE TABLE IF NOT EXISTS payment_repair_requests (
      repair_request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      difference_id UUID NOT NULL REFERENCES payment_reconciliation_differences(difference_id),
      action TEXT NOT NULL CHECK(action='requeue_projection'),
      status TEXT NOT NULL DEFAULT 'pending_approval' CHECK(status IN ('pending_approval','executed','rejected')),
      requested_by UUID NOT NULL REFERENCES platform_admin_accounts(admin_id),
      request_reason TEXT NOT NULL CHECK(char_length(request_reason) BETWEEN 10 AND 500),
      approval_mode TEXT NOT NULL DEFAULT 'dual' CHECK(approval_mode IN ('single','dual')),
      approved_by UUID REFERENCES platform_admin_accounts(admin_id),
      approval_reason TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at TIMESTAMPTZ,
      executed_at TIMESTAMPTZ
    );
    ALTER TABLE payment_repair_requests ADD COLUMN IF NOT EXISTS approval_mode TEXT NOT NULL DEFAULT 'dual';
    DO $$ DECLARE item RECORD; BEGIN
      FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='payment_repair_requests'::regclass AND contype='c' AND pg_get_constraintdef(oid) ILIKE '%approved_by%requested_by%' LOOP
        EXECUTE format('ALTER TABLE payment_repair_requests DROP CONSTRAINT %I',item.conname);
      END LOOP;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS payment_repair_one_pending_idx ON payment_repair_requests(difference_id) WHERE status='pending_approval';
    CREATE TABLE IF NOT EXISTS payment_order_query_jobs (
      query_job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      payment_order_id UUID NOT NULL REFERENCES payment_orders(payment_order_id),
      provider TEXT NOT NULL CHECK(provider IN ('wechat_pay','alipay')),
      slot_started_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','retry_pending','succeeded','dead')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
      max_attempts INTEGER NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 20),
      available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      lease_until TIMESTAMPTZ,
      worker_id TEXT,
      result_state TEXT CHECK(result_state IN ('pending','paid','closed','unknown')),
      last_error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      UNIQUE(payment_order_id,slot_started_at)
    );
    CREATE INDEX IF NOT EXISTS payment_order_query_claim_idx ON payment_order_query_jobs(status,available_at,created_at)
      WHERE status IN ('pending','processing','retry_pending');
    CREATE TABLE IF NOT EXISTS payment_order_query_events (
      query_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      query_job_id UUID NOT NULL REFERENCES payment_order_query_jobs(query_job_id),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      payment_order_id UUID NOT NULL REFERENCES payment_orders(payment_order_id),
      outcome TEXT NOT NULL CHECK(outcome IN ('succeeded','retry_pending','dead')),
      reason TEXT NOT NULL CHECK(char_length(reason) BETWEEN 1 AND 120),
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS payment_order_query_events_job_idx ON payment_order_query_events(query_job_id,created_at);
    DROP TRIGGER IF EXISTS payment_order_query_events_append_only ON payment_order_query_events;
    CREATE TRIGGER payment_order_query_events_append_only BEFORE UPDATE OR DELETE ON payment_order_query_events
      FOR EACH ROW EXECUTE FUNCTION prevent_payment_event_mutation();
    CREATE TABLE IF NOT EXISTS growth_campaigns (
      campaign_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_key TEXT NOT NULL CHECK (campaign_key ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
      version INTEGER NOT NULL CHECK (version > 0),
      campaign_type TEXT NOT NULL CHECK (campaign_type IN ('trial')),
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','ended')),
      name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      qualification_rule JSONB NOT NULL CHECK (jsonb_typeof(qualification_rule)='object'),
      benefit_rule JSONB NOT NULL CHECK (jsonb_typeof(benefit_rule)='object'),
      created_by TEXT NOT NULL,
      approved_by TEXT,
      published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (ends_at > starts_at),
      CHECK ((status='draft' AND published_at IS NULL) OR (status<>'draft' AND published_at IS NOT NULL)),
      UNIQUE (campaign_key,version)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS growth_campaigns_one_active_idx
      ON growth_campaigns(campaign_key) WHERE status='active';
    ALTER TABLE growth_campaigns DROP CONSTRAINT IF EXISTS growth_campaigns_campaign_type_check;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='growth_campaigns_campaign_type_allowed') THEN
        ALTER TABLE growth_campaigns ADD CONSTRAINT growth_campaigns_campaign_type_allowed CHECK (campaign_type IN ('trial','referral'));
      END IF;
    END $$;
    CREATE OR REPLACE FUNCTION protect_published_campaign_facts() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='DELETE' AND OLD.status <> 'draft' THEN RAISE EXCEPTION 'published campaign versions cannot be deleted'; END IF;
      IF TG_OP='UPDATE' AND OLD.status <> 'draft' AND
        (to_jsonb(NEW)-'status') <> (to_jsonb(OLD)-'status') THEN
        RAISE EXCEPTION 'published campaign facts are immutable; create a new version';
      END IF;
      RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS growth_campaigns_version_guard ON growth_campaigns;
    CREATE TRIGGER growth_campaigns_version_guard BEFORE UPDATE OR DELETE ON growth_campaigns
      FOR EACH ROW EXECUTE FUNCTION protect_published_campaign_facts();
    CREATE TABLE IF NOT EXISTS tenant_trial_signals (
      tenant_id TEXT PRIMARY KEY REFERENCES tenants(tenant_id),
      organization_fingerprint_hash TEXT,
      risk_state TEXT NOT NULL DEFAULT 'clear' CHECK (risk_state IN ('clear','review','blocked')),
      risk_reason_codes TEXT[] NOT NULL DEFAULT '{}',
      updated_by TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (organization_fingerprint_hash IS NULL OR organization_fingerprint_hash ~ '^[a-f0-9]{64}$')
    );
    CREATE TABLE IF NOT EXISTS trial_eligibility_decisions (
      decision_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      campaign_id UUID NOT NULL REFERENCES growth_campaigns(campaign_id),
      campaign_key TEXT NOT NULL,
      campaign_version INTEGER NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('eligible','review','rejected')),
      reason_codes TEXT[] NOT NULL,
      signal_snapshot JSONB NOT NULL CHECK (jsonb_typeof(signal_snapshot)='object'),
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      request_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS trial_decisions_tenant_created_idx
      ON trial_eligibility_decisions(tenant_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS trial_entitlements (
      entitlement_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      campaign_id UUID NOT NULL REFERENCES growth_campaigns(campaign_id),
      campaign_key TEXT NOT NULL,
      campaign_version INTEGER NOT NULL,
      decision_id UUID NOT NULL REFERENCES trial_eligibility_decisions(decision_id),
      status TEXT NOT NULL CHECK (status IN ('provisioning','active','expired','revoked','converted')),
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      grace_ends_at TIMESTAMPTZ NOT NULL,
      benefit_snapshot JSONB NOT NULL CHECK (jsonb_typeof(benefit_snapshot)='object'),
      ledger_transaction_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(ledger_transaction_ids)='array'),
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (ends_at > starts_at AND grace_ends_at >= ends_at),
      UNIQUE (tenant_id,campaign_key)
    );
    CREATE INDEX IF NOT EXISTS trial_entitlements_expiry_idx ON trial_entitlements(status,ends_at)
      WHERE status IN ('provisioning','active');
    CREATE OR REPLACE FUNCTION enforce_trial_entitlement_lifecycle() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'trial entitlements cannot be deleted'; END IF;
      IF (to_jsonb(NEW)-'status'-'ends_at'-'grace_ends_at'-'ledger_transaction_ids'-'updated_at') <>
         (to_jsonb(OLD)-'status'-'ends_at'-'grace_ends_at'-'ledger_transaction_ids'-'updated_at') THEN
        RAISE EXCEPTION 'trial entitlement facts are immutable';
      END IF;
      IF OLD.status='provisioning' THEN
        IF NEW.status <> 'active' OR NEW.ends_at<>OLD.ends_at OR NEW.grace_ends_at<>OLD.grace_ends_at THEN
          RAISE EXCEPTION 'invalid trial provisioning transition';
        END IF;
      ELSIF OLD.status='active' THEN
        IF NEW.status='active' THEN
          IF NEW.ends_at<=OLD.ends_at OR NEW.grace_ends_at<=OLD.grace_ends_at OR NEW.ledger_transaction_ids<>OLD.ledger_transaction_ids THEN
            RAISE EXCEPTION 'trial extension must only increase its time window';
          END IF;
        ELSIF NEW.status NOT IN ('expired','revoked','converted') OR NEW.ends_at<>OLD.ends_at OR NEW.grace_ends_at<>OLD.grace_ends_at OR NEW.ledger_transaction_ids<>OLD.ledger_transaction_ids THEN
          RAISE EXCEPTION 'invalid active trial transition';
        END IF;
      ELSE
        RAISE EXCEPTION 'terminal trial entitlement is immutable';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS trial_entitlements_lifecycle ON trial_entitlements;
    CREATE TRIGGER trial_entitlements_lifecycle BEFORE UPDATE OR DELETE ON trial_entitlements
      FOR EACH ROW EXECUTE FUNCTION enforce_trial_entitlement_lifecycle();
    CREATE TABLE IF NOT EXISTS trial_adjustments (
      adjustment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entitlement_id UUID NOT NULL REFERENCES trial_entitlements(entitlement_id),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      action TEXT NOT NULL CHECK (action IN ('extended','expired','revoked','converted')),
      reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
      before_data JSONB NOT NULL CHECK (jsonb_typeof(before_data)='object'),
      after_data JSONB NOT NULL CHECK (jsonb_typeof(after_data)='object'),
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      request_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS trial_adjustments_tenant_created_idx
      ON trial_adjustments(tenant_id,created_at DESC);
    CREATE OR REPLACE FUNCTION prevent_trial_history_mutation() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'trial decision and adjustment history is append-only'; END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS trial_decisions_append_only ON trial_eligibility_decisions;
    CREATE TRIGGER trial_decisions_append_only BEFORE UPDATE OR DELETE ON trial_eligibility_decisions
      FOR EACH ROW EXECUTE FUNCTION prevent_trial_history_mutation();
    DROP TRIGGER IF EXISTS trial_adjustments_append_only ON trial_adjustments;
    CREATE TRIGGER trial_adjustments_append_only BEFORE UPDATE OR DELETE ON trial_adjustments
      FOR EACH ROW EXECUTE FUNCTION prevent_trial_history_mutation();
    INSERT INTO growth_campaigns
      (campaign_key,version,campaign_type,status,name,starts_at,ends_at,qualification_rule,benefit_rule,created_by,approved_by,published_at)
    VALUES
      ('professional-trial-cn',1,'trial','active','14天专业版试用','2026-01-01T00:00:00+08:00','2030-01-01T00:00:00+08:00',
       '{"verified_contact":"any","once_per_real_tenant":true,"medium_risk":"review","high_risk":"reject"}'::jsonb,
       '{"trial_days":14,"grace_days":7,"seat_limit":3,"message_limit":5000,"knowledge_bytes":1073741824,"features":["wechat_official","ai_copilot","knowledge_base","team_notifications"],"grants":[{"account":"gift","currency":"CNY","amount_minor":3000},{"account":"ai_credit","currency":"AIC","amount_minor":100000}]}'::jsonb,
       'system.seed','system.seed',NOW())
    ON CONFLICT(campaign_key,version) DO NOTHING;
    INSERT INTO growth_campaigns
      (campaign_key,version,campaign_type,status,name,starts_at,ends_at,qualification_rule,benefit_rule,created_by,approved_by,published_at)
    VALUES
      ('tenant-referral-cn',1,'referral','active','企业邀请计划','2026-01-01T00:00:00+08:00','2030-01-01T00:00:00+08:00',
       '{"inviter_billing_status":"paid","min_account_age_days":0,"min_lifetime_cash_paid_minor":10000,"attribution_window_minutes":30,"min_first_cash_payment_minor":10000,"observation_days":7}'::jsonb,
       '{"inviter_reward":{"account":"referral","currency":"CNY","amount_minor":5000,"expires_days":180},"invitee_reward":{"account":"gift","currency":"CNY","amount_minor":3000,"expires_days":90}}'::jsonb,
       'system.seed','system.seed',NOW())
    ON CONFLICT(campaign_key,version) DO NOTHING;
    CREATE TABLE IF NOT EXISTS tenant_commercial_profiles (
      tenant_id TEXT PRIMARY KEY REFERENCES tenants(tenant_id),
      billing_status TEXT NOT NULL DEFAULT 'free' CHECK (billing_status IN ('free','trial','paid','delinquent','risk_restricted')),
      lifetime_cash_paid_minor BIGINT NOT NULL DEFAULT 0 CHECK (lifetime_cash_paid_minor>=0),
      first_paid_at TIMESTAMPTZ,
      updated_by TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS referral_invite_codes (
      invite_code_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id UUID NOT NULL REFERENCES growth_campaigns(campaign_id),
      campaign_key TEXT NOT NULL,
      campaign_version INTEGER NOT NULL,
      inviter_tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      inviter_user_id UUID NOT NULL REFERENCES platform_users(platform_user_id),
      invite_code TEXT NOT NULL UNIQUE CHECK (invite_code ~ '^[A-Za-z0-9_-]{20,64}$'),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS referral_one_active_code_idx
      ON referral_invite_codes(campaign_key,inviter_tenant_id) WHERE status='active';
    CREATE TABLE IF NOT EXISTS referrals (
      referral_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id UUID NOT NULL REFERENCES growth_campaigns(campaign_id),
      campaign_key TEXT NOT NULL,
      campaign_version INTEGER NOT NULL,
      invite_code_id UUID NOT NULL REFERENCES referral_invite_codes(invite_code_id),
      inviter_tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      inviter_user_id UUID NOT NULL REFERENCES platform_users(platform_user_id),
      invitee_tenant_id TEXT NOT NULL UNIQUE REFERENCES tenants(tenant_id),
      invitee_user_id UUID NOT NULL REFERENCES platform_users(platform_user_id),
      status TEXT NOT NULL DEFAULT 'attributed',
      qualification_event_id UUID,
      observation_ends_at TIMESTAMPTZ,
      risk_score INTEGER CHECK (risk_score BETWEEN 0 AND 100),
      risk_reasons TEXT[] NOT NULL DEFAULT '{}',
      reviewed_by TEXT,
      reviewed_at TIMESTAMPTZ,
      attributed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (inviter_tenant_id<>invitee_tenant_id),
      CHECK (inviter_user_id<>invitee_user_id),
      CHECK ((status='attributed' AND qualification_event_id IS NULL AND observation_ends_at IS NULL) OR
             (status<>'attributed' AND (qualification_event_id IS NOT NULL OR status='rejected')))
    );
    ALTER TABLE referrals DROP CONSTRAINT IF EXISTS referrals_status_check;
    ALTER TABLE referrals DROP CONSTRAINT IF EXISTS referrals_status_allowed;
    ALTER TABLE referrals ADD CONSTRAINT referrals_status_allowed
      CHECK (status IN ('attributed','pending','review','qualified','rejected','revoked'));
    ALTER TABLE referrals ADD COLUMN IF NOT EXISTS risk_decision_id UUID;
    CREATE INDEX IF NOT EXISTS referrals_inviter_created_idx ON referrals(inviter_tenant_id,attributed_at DESC);
    CREATE INDEX IF NOT EXISTS referrals_pending_observation_idx ON referrals(status,observation_ends_at) WHERE status='pending';
    CREATE TABLE IF NOT EXISTS referral_qualification_events (
      event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      referral_id UUID NOT NULL REFERENCES referrals(referral_id),
      invitee_tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      event_type TEXT NOT NULL CHECK (event_type IN ('payment_settled','payment_refunded','payment_chargeback','payment_invalidated')),
      source_type TEXT NOT NULL CHECK (char_length(source_type) BETWEEN 1 AND 64),
      source_id TEXT NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 200),
      cash_paid_minor BIGINT NOT NULL CHECK (cash_paid_minor>=0),
      currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      occurred_at TIMESTAMPTZ NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (source_type,source_id,event_type)
    );
    ALTER TABLE referrals DROP CONSTRAINT IF EXISTS referrals_qualification_event_id_fkey;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='referrals_qualification_event_fk') THEN
        ALTER TABLE referrals ADD CONSTRAINT referrals_qualification_event_fk FOREIGN KEY(qualification_event_id) REFERENCES referral_qualification_events(event_id);
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS referral_status_events (
      status_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      referral_id UUID NOT NULL REFERENCES referrals(referral_id),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      from_status TEXT,
      to_status TEXT NOT NULL,
      reason_codes TEXT[] NOT NULL DEFAULT '{}',
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      request_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE referral_status_events DROP CONSTRAINT IF EXISTS referral_status_events_to_status_check;
    ALTER TABLE referral_status_events DROP CONSTRAINT IF EXISTS referral_status_events_to_status_allowed;
    ALTER TABLE referral_status_events ADD CONSTRAINT referral_status_events_to_status_allowed
      CHECK (to_status IN ('attributed','pending','review','qualified','rejected','revoked'));
    CREATE INDEX IF NOT EXISTS referral_status_events_referral_idx ON referral_status_events(referral_id,created_at);
    CREATE OR REPLACE FUNCTION protect_referral_history() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'referral event history is append-only'; END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS referral_qualification_events_append_only ON referral_qualification_events;
    CREATE TRIGGER referral_qualification_events_append_only BEFORE UPDATE OR DELETE ON referral_qualification_events
      FOR EACH ROW EXECUTE FUNCTION protect_referral_history();
    DROP TRIGGER IF EXISTS referral_status_events_append_only ON referral_status_events;
    CREATE TRIGGER referral_status_events_append_only BEFORE UPDATE OR DELETE ON referral_status_events
      FOR EACH ROW EXECUTE FUNCTION protect_referral_history();
    CREATE OR REPLACE FUNCTION enforce_referral_lifecycle() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'referrals cannot be deleted'; END IF;
      IF (to_jsonb(NEW)-'status'-'qualification_event_id'-'observation_ends_at'-'risk_score'-'risk_reasons'-'risk_decision_id'-'reviewed_by'-'reviewed_at'-'updated_at') <>
         (to_jsonb(OLD)-'status'-'qualification_event_id'-'observation_ends_at'-'risk_score'-'risk_reasons'-'risk_decision_id'-'reviewed_by'-'reviewed_at'-'updated_at') THEN
        RAISE EXCEPTION 'referral attribution facts are immutable';
      END IF;
      IF OLD.status='attributed' AND NEW.status NOT IN ('pending','rejected') THEN RAISE EXCEPTION 'invalid referral transition'; END IF;
      IF OLD.status='pending' AND NEW.status NOT IN ('review','qualified','rejected') THEN RAISE EXCEPTION 'invalid referral transition'; END IF;
      IF OLD.status='review' AND NEW.status NOT IN ('qualified','rejected') THEN RAISE EXCEPTION 'invalid referral transition'; END IF;
      IF OLD.status='qualified' AND NEW.status<>'revoked' THEN RAISE EXCEPTION 'invalid referral transition'; END IF;
      IF OLD.status IN ('rejected','revoked') THEN RAISE EXCEPTION 'terminal referral is immutable'; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS referrals_lifecycle ON referrals;
    CREATE TRIGGER referrals_lifecycle BEFORE UPDATE OR DELETE ON referrals
      FOR EACH ROW EXECUTE FUNCTION enforce_referral_lifecycle();
    CREATE TABLE IF NOT EXISTS tenant_risk_signals (
      signal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      signal_type TEXT NOT NULL CHECK (signal_type IN ('verified_phone','legal_entity','wechat_official_account','payment_subject','device','ip_network')),
      fingerprint_hash TEXT NOT NULL CHECK (fingerprint_hash ~ '^[a-f0-9]{64}$'),
      confidence TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
      source TEXT NOT NULL CHECK (char_length(source) BETWEEN 1 AND 64),
      verified_at TIMESTAMPTZ,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(tenant_id,signal_type,fingerprint_hash)
    );
    CREATE INDEX IF NOT EXISTS tenant_risk_signals_match_idx ON tenant_risk_signals(signal_type,fingerprint_hash,tenant_id);
    CREATE TABLE IF NOT EXISTS tenant_risk_signal_revocations (
      revocation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      signal_id UUID NOT NULL UNIQUE REFERENCES tenant_risk_signals(signal_id),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
      revoked_by TEXT NOT NULL,
      revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS referral_risk_assessments (
      assessment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      referral_id UUID NOT NULL REFERENCES referrals(referral_id),
      assessment_version INTEGER NOT NULL CHECK (assessment_version>0),
      outcome TEXT NOT NULL CHECK (outcome IN ('allow','review','reject')),
      risk_score INTEGER NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
      reason_codes TEXT[] NOT NULL DEFAULT '{}',
      signal_snapshot JSONB NOT NULL CHECK (jsonb_typeof(signal_snapshot)='object'),
      policy_version INTEGER NOT NULL DEFAULT 1,
      actor_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(referral_id,assessment_version)
    );
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='referrals_risk_decision_fk') THEN
        ALTER TABLE referrals ADD CONSTRAINT referrals_risk_decision_fk FOREIGN KEY(risk_decision_id) REFERENCES referral_risk_assessments(assessment_id);
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS referral_manual_reviews (
      review_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      referral_id UUID NOT NULL REFERENCES referrals(referral_id),
      assessment_id UUID NOT NULL REFERENCES referral_risk_assessments(assessment_id),
      decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
      reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
      reviewer_id TEXT NOT NULL,
      request_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(referral_id)
    );
    CREATE TABLE IF NOT EXISTS referral_reward_grants (
      grant_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      referral_id UUID NOT NULL REFERENCES referrals(referral_id),
      beneficiary_tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      beneficiary_role TEXT NOT NULL CHECK (beneficiary_role IN ('inviter','invitee')),
      account TEXT NOT NULL CHECK (account IN ('referral','gift')),
      currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      amount_minor BIGINT NOT NULL CHECK (amount_minor>0),
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'provisioning' CHECK (status IN ('provisioning','posted','reversed')),
      ledger_transaction_id UUID REFERENCES ledger_transactions(transaction_id),
      reversal_transaction_id UUID REFERENCES ledger_transactions(transaction_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(referral_id,beneficiary_role),
      CHECK ((status='provisioning' AND ledger_transaction_id IS NULL AND reversal_transaction_id IS NULL) OR
             (status='posted' AND ledger_transaction_id IS NOT NULL AND reversal_transaction_id IS NULL) OR
             (status='reversed' AND ledger_transaction_id IS NOT NULL AND reversal_transaction_id IS NOT NULL))
    );
    CREATE OR REPLACE FUNCTION protect_referral_risk_history() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'referral risk history is append-only'; END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS tenant_risk_signals_append_only ON tenant_risk_signals;
    CREATE TRIGGER tenant_risk_signals_append_only BEFORE UPDATE OR DELETE ON tenant_risk_signals FOR EACH ROW EXECUTE FUNCTION protect_referral_risk_history();
    DROP TRIGGER IF EXISTS tenant_risk_signal_revocations_append_only ON tenant_risk_signal_revocations;
    CREATE TRIGGER tenant_risk_signal_revocations_append_only BEFORE UPDATE OR DELETE ON tenant_risk_signal_revocations FOR EACH ROW EXECUTE FUNCTION protect_referral_risk_history();
    DROP TRIGGER IF EXISTS referral_risk_assessments_append_only ON referral_risk_assessments;
    CREATE TRIGGER referral_risk_assessments_append_only BEFORE UPDATE OR DELETE ON referral_risk_assessments FOR EACH ROW EXECUTE FUNCTION protect_referral_risk_history();
    DROP TRIGGER IF EXISTS referral_manual_reviews_append_only ON referral_manual_reviews;
    CREATE TRIGGER referral_manual_reviews_append_only BEFORE UPDATE OR DELETE ON referral_manual_reviews FOR EACH ROW EXECUTE FUNCTION protect_referral_risk_history();
    CREATE OR REPLACE FUNCTION protect_referral_reward_grant() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'referral reward grants cannot be deleted'; END IF;
      IF (to_jsonb(NEW)-'status'-'ledger_transaction_id'-'reversal_transaction_id'-'updated_at') <>
         (to_jsonb(OLD)-'status'-'ledger_transaction_id'-'reversal_transaction_id'-'updated_at') THEN
        RAISE EXCEPTION 'referral reward facts are immutable';
      END IF;
      IF OLD.status='provisioning' AND NEW.status<>'posted' THEN RAISE EXCEPTION 'invalid referral reward transition'; END IF;
      IF OLD.status='posted' AND NEW.status<>'reversed' THEN RAISE EXCEPTION 'invalid referral reward transition'; END IF;
      IF OLD.status='reversed' THEN RAISE EXCEPTION 'terminal referral reward is immutable'; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS referral_reward_grants_lifecycle ON referral_reward_grants;
    CREATE TRIGGER referral_reward_grants_lifecycle BEFORE UPDATE OR DELETE ON referral_reward_grants FOR EACH ROW EXECUTE FUNCTION protect_referral_reward_grant();
    CREATE TABLE IF NOT EXISTS plan_catalog_versions (
      plan_version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_code TEXT NOT NULL CHECK(plan_code IN ('free','starter','professional','enterprise')),
      version INTEGER NOT NULL CHECK(version>0),
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','retired')),
      name TEXT NOT NULL,
      billing_period TEXT NOT NULL CHECK(billing_period IN ('none','monthly','annual','custom')),
      price_minor BIGINT CHECK(price_minor IS NULL OR price_minor>=0),
      currency TEXT NOT NULL DEFAULT 'CNY' CHECK(currency='CNY'),
      entitlement_rules JSONB NOT NULL CHECK(jsonb_typeof(entitlement_rules)='object'),
      effective_from TIMESTAMPTZ NOT NULL,
      effective_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(plan_code,version),
      CHECK(effective_until IS NULL OR effective_until>effective_from)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS plan_catalog_one_active_idx ON plan_catalog_versions(plan_code) WHERE status='active';
    CREATE OR REPLACE FUNCTION protect_plan_catalog_version() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'plan catalog versions are immutable'; END IF;
      IF (to_jsonb(NEW)-'status'-'effective_until')<>(to_jsonb(OLD)-'status'-'effective_until') THEN RAISE EXCEPTION 'plan catalog facts are immutable'; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS plan_catalog_version_immutable ON plan_catalog_versions;
    CREATE TRIGGER plan_catalog_version_immutable BEFORE UPDATE OR DELETE ON plan_catalog_versions FOR EACH ROW EXECUTE FUNCTION protect_plan_catalog_version();
    ${planPricingSchema}
    ${extensionSchema}
    ${automationRuleSchema}
    ${openPlatformSchema}
    CREATE TABLE IF NOT EXISTS tenant_subscriptions (
      subscription_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      plan_version_id UUID NOT NULL REFERENCES plan_catalog_versions(plan_version_id),
      status TEXT NOT NULL CHECK(status IN ('active','trialing','past_due','canceled','expired')),
      source TEXT NOT NULL CHECK(source IN ('free_baseline','synthetic','payment','manual')),
      provider TEXT,
      provider_subscription_id TEXT,
      current_period_start TIMESTAMPTZ NOT NULL,
      current_period_end TIMESTAMPTZ,
      cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
      price_minor_snapshot BIGINT CHECK(price_minor_snapshot IS NULL OR price_minor_snapshot>=0),
      currency_snapshot TEXT NOT NULL DEFAULT 'CNY' CHECK(currency_snapshot='CNY'),
      entitlement_snapshot JSONB NOT NULL CHECK(jsonb_typeof(entitlement_snapshot)='object'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK(current_period_end IS NULL OR current_period_end>current_period_start)
    );
    ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS price_minor_snapshot BIGINT;
    ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS currency_snapshot TEXT NOT NULL DEFAULT 'CNY';
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='tenant_subscriptions'::regclass AND tgname='tenant_subscription_facts_immutable') THEN ALTER TABLE tenant_subscriptions DISABLE TRIGGER tenant_subscription_facts_immutable; END IF; END $$;
    UPDATE tenant_subscriptions s SET price_minor_snapshot=p.price_minor,currency_snapshot=p.currency
      FROM plan_catalog_versions p WHERE p.plan_version_id=s.plan_version_id AND s.price_minor_snapshot IS NULL;
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='tenant_subscriptions'::regclass AND tgname='tenant_subscription_facts_immutable') THEN ALTER TABLE tenant_subscriptions ENABLE TRIGGER tenant_subscription_facts_immutable; END IF; END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS tenant_subscription_one_current_idx ON tenant_subscriptions(tenant_id) WHERE status IN ('active','trialing','past_due');
    CREATE OR REPLACE FUNCTION protect_subscription_facts() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'subscription history is immutable'; END IF;
      IF NEW.tenant_id<>OLD.tenant_id OR NEW.plan_version_id<>OLD.plan_version_id OR NEW.source<>OLD.source OR NEW.price_minor_snapshot IS DISTINCT FROM OLD.price_minor_snapshot OR NEW.currency_snapshot<>OLD.currency_snapshot OR NEW.entitlement_snapshot<>OLD.entitlement_snapshot OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'subscription facts are immutable'; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS tenant_subscription_facts_immutable ON tenant_subscriptions;
    CREATE TRIGGER tenant_subscription_facts_immutable BEFORE UPDATE OR DELETE ON tenant_subscriptions FOR EACH ROW EXECUTE FUNCTION protect_subscription_facts();
    CREATE TABLE IF NOT EXISTS subscription_events (
      subscription_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      subscription_id UUID NOT NULL REFERENCES tenant_subscriptions(subscription_id),
      event_type TEXT NOT NULL CHECK(event_type IN ('created','activated','plan_changed','renewed','past_due','cancel_scheduled','canceled','expired')),
      source TEXT NOT NULL,
      event_key TEXT NOT NULL,
      facts JSONB NOT NULL DEFAULT '{}'::jsonb,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(tenant_id,event_key)
    );
    ${planCheckoutSchema}
    ${paymentRefundSchema}
    ${walletSchema}
    ${templateMarketSchema}
    ${aiPointsSchema}
    ${growthPolicySchema}
    ${subscriptionMailSchema}
    ${aiLowMailSchema}
    ${aiUsageSummarySchema}
    CREATE INDEX IF NOT EXISTS admin_wallet_created_idx ON wallet_requests(created_at DESC,request_id DESC);
    CREATE INDEX IF NOT EXISTS admin_wallet_status_idx ON wallet_requests(status,created_at DESC,request_id DESC);
    CREATE INDEX IF NOT EXISTS admin_refunds_created_idx ON payment_refund_requests(created_at DESC,refund_request_id DESC);
    CREATE INDEX IF NOT EXISTS admin_refunds_status_idx ON payment_refund_requests(status,created_at DESC,refund_request_id DESC);
    CREATE INDEX IF NOT EXISTS admin_commissions_created_idx ON plan_commissions(created_at DESC,commission_id DESC);
    CREATE INDEX IF NOT EXISTS admin_commissions_status_idx ON plan_commissions(status,created_at DESC,commission_id DESC);
    CREATE TABLE IF NOT EXISTS usage_events (
      usage_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      metric TEXT NOT NULL CHECK(metric IN ('ai_actions','messages','automation_runs')),
      units BIGINT NOT NULL CHECK(units>0),
      idempotency_key TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(tenant_id,metric,idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS usage_events_period_idx ON usage_events(tenant_id,metric,occurred_at);
    CREATE OR REPLACE FUNCTION prevent_usage_event_mutation() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'usage events are append-only'; END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS usage_events_append_only ON usage_events;
    CREATE TRIGGER usage_events_append_only BEFORE UPDATE OR DELETE ON usage_events FOR EACH ROW EXECUTE FUNCTION prevent_usage_event_mutation();
    DROP TRIGGER IF EXISTS subscription_events_append_only ON subscription_events;
    CREATE TRIGGER subscription_events_append_only BEFORE UPDATE OR DELETE ON subscription_events FOR EACH ROW EXECUTE FUNCTION prevent_usage_event_mutation();
    CREATE TABLE IF NOT EXISTS subscription_change_requests (
      change_request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      current_subscription_id UUID NOT NULL REFERENCES tenant_subscriptions(subscription_id),
      target_plan_version_id UUID NOT NULL REFERENCES plan_catalog_versions(plan_version_id),
      status TEXT NOT NULL DEFAULT 'pending_approval' CHECK(status IN ('pending_approval','executed','rejected')),
      requested_by UUID NOT NULL REFERENCES platform_admin_accounts(admin_id),
      request_reason TEXT NOT NULL CHECK(char_length(request_reason) BETWEEN 10 AND 500),
      requested_price_minor BIGINT CHECK(requested_price_minor IS NULL OR requested_price_minor>=0),
      requested_currency TEXT NOT NULL DEFAULT 'CNY' CHECK(requested_currency='CNY'),
      requested_entitlement_snapshot JSONB CHECK(requested_entitlement_snapshot IS NULL OR jsonb_typeof(requested_entitlement_snapshot)='object'),
      approval_mode TEXT NOT NULL DEFAULT 'dual' CHECK(approval_mode IN ('single','dual')),
      approved_by UUID REFERENCES platform_admin_accounts(admin_id),
      approval_reason TEXT CHECK(approval_reason IS NULL OR char_length(approval_reason) BETWEEN 10 AND 500),
      executed_subscription_id UUID REFERENCES tenant_subscriptions(subscription_id),
      decided_at TIMESTAMPTZ,
      executed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK((status='pending_approval' AND approved_by IS NULL AND decided_at IS NULL AND executed_subscription_id IS NULL AND executed_at IS NULL)
        OR (status='rejected' AND approved_by IS NOT NULL AND decided_at IS NOT NULL AND executed_subscription_id IS NULL AND executed_at IS NULL)
        OR (status='executed' AND approved_by IS NOT NULL AND decided_at IS NOT NULL AND executed_subscription_id IS NOT NULL AND executed_at IS NOT NULL))
    );
    ALTER TABLE subscription_change_requests ADD COLUMN IF NOT EXISTS requested_price_minor BIGINT;
    ALTER TABLE subscription_change_requests ADD COLUMN IF NOT EXISTS requested_currency TEXT NOT NULL DEFAULT 'CNY';
    ALTER TABLE subscription_change_requests ADD COLUMN IF NOT EXISTS requested_entitlement_snapshot JSONB;
    ALTER TABLE subscription_change_requests ADD COLUMN IF NOT EXISTS approval_mode TEXT NOT NULL DEFAULT 'dual';
    DO $$ DECLARE item RECORD; BEGIN
      FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='subscription_change_requests'::regclass AND contype='c' AND pg_get_constraintdef(oid) ILIKE '%approved_by%requested_by%' LOOP
        EXECUTE format('ALTER TABLE subscription_change_requests DROP CONSTRAINT %I',item.conname);
      END LOOP;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS subscription_change_one_pending_idx ON subscription_change_requests(tenant_id) WHERE status='pending_approval';
    CREATE INDEX IF NOT EXISTS admin_subscription_created_idx ON subscription_change_requests(created_at DESC,change_request_id DESC);
    CREATE INDEX IF NOT EXISTS admin_subscription_status_idx ON subscription_change_requests(status,created_at DESC,change_request_id DESC);
    CREATE INDEX IF NOT EXISTS admin_points_created_idx ON ai_point_refunds(created_at DESC,request_id DESC);
    CREATE INDEX IF NOT EXISTS admin_points_status_idx ON ai_point_refunds(status,created_at DESC,request_id DESC);
    CREATE INDEX IF NOT EXISTS admin_privacy_due_idx ON privacy_requests(due_at,created_at DESC,privacy_request_id DESC);
    CREATE INDEX IF NOT EXISTS admin_privacy_status_due_idx ON privacy_requests(status,due_at,created_at DESC,privacy_request_id DESC);
    CREATE INDEX IF NOT EXISTS admin_difference_created_idx ON payment_reconciliation_differences(created_at DESC,difference_id DESC);
    CREATE INDEX IF NOT EXISTS admin_difference_status_idx ON payment_reconciliation_differences(status,created_at DESC,difference_id DESC);
    CREATE INDEX IF NOT EXISTS admin_repair_created_idx ON payment_repair_requests(requested_at DESC,repair_request_id DESC);
    CREATE INDEX IF NOT EXISTS admin_repair_status_idx ON payment_repair_requests(status,requested_at DESC,repair_request_id DESC);
    CREATE OR REPLACE FUNCTION protect_subscription_change_request() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'subscription change history is immutable'; END IF;
      IF OLD.status<>'pending_approval' THEN RAISE EXCEPTION 'decided subscription change is immutable'; END IF;
      IF NEW.tenant_id<>OLD.tenant_id OR NEW.current_subscription_id<>OLD.current_subscription_id OR NEW.target_plan_version_id<>OLD.target_plan_version_id OR NEW.requested_by<>OLD.requested_by OR NEW.request_reason<>OLD.request_reason OR NEW.requested_price_minor IS DISTINCT FROM OLD.requested_price_minor OR NEW.requested_currency<>OLD.requested_currency OR NEW.requested_entitlement_snapshot IS DISTINCT FROM OLD.requested_entitlement_snapshot OR NEW.approval_mode<>OLD.approval_mode OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'subscription change facts are immutable'; END IF;
      IF NEW.status NOT IN ('executed','rejected') THEN RAISE EXCEPTION 'invalid subscription change transition'; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS subscription_change_request_lifecycle ON subscription_change_requests;
    CREATE TRIGGER subscription_change_request_lifecycle BEFORE UPDATE OR DELETE ON subscription_change_requests FOR EACH ROW EXECUTE FUNCTION protect_subscription_change_request();
    CREATE TABLE IF NOT EXISTS quota_notification_jobs (
      quota_job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      metric TEXT NOT NULL CHECK(metric IN ('seats','channels','customers','ai_actions_monthly','knowledge_bytes')),
      period_key TEXT NOT NULL,
      threshold INTEGER NOT NULL CHECK(threshold IN (80,100)),
      used_units BIGINT NOT NULL CHECK(used_units>=0),
      limit_units BIGINT NOT NULL CHECK(limit_units>=0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','emitted','failed')),
      notification_id UUID,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(tenant_id,metric,period_key,threshold)
    );
    CREATE INDEX IF NOT EXISTS quota_notification_pending_idx ON quota_notification_jobs(next_attempt_at) WHERE status='pending';
    INSERT INTO plan_catalog_versions(plan_code,version,status,name,billing_period,price_minor,entitlement_rules,effective_from) VALUES
      ('free',1,'active','长期免费版','none',0,'{"seat_limit":2,"channel_limit":1,"customer_limit":1000,"ai_actions_monthly":100,"knowledge_bytes":104857600,"automation_rule_limit":3,"qr_code_limit":5,"audit_retention_days":7,"features":["ai_copilot","knowledge_base","wechat_official"]}'::jsonb,'2026-01-01T00:00:00+08:00'),
      ('starter',1,'active','入门版','monthly',4900,'{"seat_limit":3,"channel_limit":1,"customer_limit":5000,"ai_actions_monthly":500,"knowledge_bytes":1073741824,"automation_rule_limit":10,"qr_code_limit":20,"audit_retention_days":30,"features":["ai_copilot","basic_webhook","knowledge_base","wechat_official"]}'::jsonb,'2026-01-01T00:00:00+08:00'),
      ('professional',1,'active','专业版','monthly',19900,'{"seat_limit":10,"channel_limit":3,"customer_limit":50000,"ai_actions_monthly":5000,"knowledge_bytes":10737418240,"automation_rule_limit":100,"qr_code_limit":500,"audit_retention_days":365,"features":["advanced_rbac","ai_auto_reply","ai_copilot","api","byok","knowledge_base","team_notifications","tool_calling","wechat_official","webhook"]}'::jsonb,'2026-01-01T00:00:00+08:00'),
      ('enterprise',1,'active','企业版','custom',NULL,'{"seat_limit":null,"channel_limit":null,"customer_limit":null,"ai_actions_monthly":null,"knowledge_bytes":null,"automation_rule_limit":null,"qr_code_limit":null,"audit_retention_days":null,"features":["advanced_rbac","ai_auto_reply","ai_copilot","api","byok","dedicated_support","knowledge_base","sla","team_notifications","tool_calling","wechat_official","webhook"]}'::jsonb,'2026-01-01T00:00:00+08:00')
    ON CONFLICT(plan_code,version) DO NOTHING;
    INSERT INTO tenant_subscriptions(tenant_id,plan_version_id,status,source,current_period_start,current_period_end,price_minor_snapshot,currency_snapshot,entitlement_snapshot)
    SELECT t.tenant_id,p.plan_version_id,'active','free_baseline',NOW(),'2099-12-31T23:59:59Z',p.price_minor,p.currency,p.entitlement_rules
      FROM tenants t JOIN plan_catalog_versions p ON p.plan_code='free' AND p.status='active'
     WHERE NOT EXISTS(SELECT 1 FROM tenant_subscriptions s WHERE s.tenant_id=t.tenant_id AND s.status IN ('active','trialing','past_due'));
    INSERT INTO subscription_events(tenant_id,subscription_id,event_type,source,event_key,facts)
    SELECT s.tenant_id,s.subscription_id,'created',s.source,'baseline:'||s.subscription_id::text,jsonb_build_object('status',s.status,'plan_version_id',s.plan_version_id)
      FROM tenant_subscriptions s WHERE NOT EXISTS(SELECT 1 FROM subscription_events e WHERE e.tenant_id=s.tenant_id AND e.event_key='baseline:'||s.subscription_id::text);
    CREATE TABLE IF NOT EXISTS knowledge_documents (
      document_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      title TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK (source_type IN ('knowledge', 'faq', 'script', 'temporary_policy_text')),
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'inactive', 'deleted')),
      content TEXT NOT NULL,
      keywords TEXT[] NOT NULL DEFAULT '{}',
      valid_from TIMESTAMPTZ,
      valid_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, title, version)
    );
    CREATE INDEX IF NOT EXISTS knowledge_documents_tenant_status_idx ON knowledge_documents(tenant_id, status);
    ${knowledgeListSchema}
    ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS content_format TEXT NOT NULL DEFAULT 'text';
    ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS original_filename TEXT;
    ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS content_checksum TEXT;
    ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS ingestion_status TEXT NOT NULL DEFAULT 'ready';
    ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS storage_key TEXT;
    ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS mime_type TEXT;
    ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS file_size BIGINT;
    ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS scan_status TEXT NOT NULL DEFAULT 'not_required';
    ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS parse_status TEXT NOT NULL DEFAULT 'ready';
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      chunk_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      document_id UUID NOT NULL REFERENCES knowledge_documents(document_id),
      document_version INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding vector(768),
      embedding_provider TEXT,
      embedding_model TEXT,
      embedding_status TEXT NOT NULL DEFAULT 'pending' CHECK (embedding_status IN ('pending','ready','failed','stale')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id,document_id,document_version,chunk_index)
    );
    CREATE INDEX IF NOT EXISTS knowledge_chunks_tenant_document_idx
      ON knowledge_chunks(tenant_id,document_id,document_version,chunk_index);
    CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_hnsw
      ON knowledge_chunks USING hnsw (embedding vector_cosine_ops) WHERE embedding_status='ready';
    CREATE TABLE IF NOT EXISTS knowledge_jobs (
      job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      document_id UUID NOT NULL REFERENCES knowledge_documents(document_id),
      job_type TEXT NOT NULL CHECK (job_type IN ('parse_and_index','embed_document')),
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','dead')),
      progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      locked_at TIMESTAMPTZ,
      worker_id TEXT,
      last_error TEXT,
      result JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS knowledge_jobs_claim_idx
      ON knowledge_jobs(status,scheduled_at,created_at) WHERE status IN ('queued','failed');
    CREATE INDEX IF NOT EXISTS knowledge_jobs_tenant_created_idx
      ON knowledge_jobs(tenant_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS mock_orders (
      order_pk UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      external_order_id TEXT NOT NULL,
      customer_id UUID NOT NULL REFERENCES customers(customer_id),
      status TEXT NOT NULL CHECK (status IN ('pending_payment','paid','processing','shipped','delivered','cancelled','refunded')),
      amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
      currency TEXT NOT NULL DEFAULT 'CNY',
      product_summary TEXT NOT NULL,
      product_batch_id TEXT,
      placed_at TIMESTAMPTZ NOT NULL,
      paid_at TIMESTAMPTZ,
      fulfilled_at TIMESTAMPTZ,
      source_system TEXT NOT NULL DEFAULT 'mock-order-api',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id,external_order_id)
    );
    CREATE INDEX IF NOT EXISTS mock_orders_tenant_customer_idx
      ON mock_orders(tenant_id,customer_id,placed_at DESC);
    CREATE TABLE IF NOT EXISTS tool_invocations (
      invocation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      tool_name TEXT NOT NULL,
      tool_version TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      customer_id UUID REFERENCES customers(customer_id),
      idempotency_key TEXT NOT NULL,
      authorization_scope TEXT NOT NULL,
      data_classification TEXT NOT NULL,
      input_data JSONB NOT NULL,
      output_data JSONB,
      status TEXT NOT NULL CHECK (status IN ('succeeded','not_found','forbidden','invalid_input','rate_limited','timeout','failed')),
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id,tool_name,idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS tool_invocations_rate_idx
      ON tool_invocations(tenant_id,actor_id,tool_name,created_at DESC);
    CREATE TABLE IF NOT EXISTS temporary_policies (
      policy_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      name TEXT NOT NULL,
      policy_type TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'active', 'paused', 'expired', 'revoked')),
      priority INTEGER NOT NULL DEFAULT 100,
      valid_from TIMESTAMPTZ NOT NULL,
      valid_until TIMESTAMPTZ NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      eligibility_time_basis TEXT NOT NULL CHECK (eligibility_time_basis IN ('purchase_time', 'registration_time', 'request_time', 'action_time', 'conversation_started_at')),
      scope JSONB NOT NULL DEFAULT '{}'::jsonb,
      conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
      decision JSONB NOT NULL,
      allowed_actions TEXT[] NOT NULL DEFAULT '{}',
      forbidden_actions TEXT[] NOT NULL DEFAULT '{}',
      reply_guidance TEXT NOT NULL,
      requires_human_approval BOOLEAN NOT NULL DEFAULT TRUE,
      version INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      approved_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (valid_until > valid_from),
      UNIQUE (tenant_id, name, version)
    );
    CREATE INDEX IF NOT EXISTS temporary_policies_tenant_status_time_idx
      ON temporary_policies(tenant_id, status, valid_from, valid_until);
    CREATE TABLE IF NOT EXISTS historical_reply_examples (
      example_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      source_conversation_id TEXT NOT NULL,
      customer_question TEXT NOT NULL,
      agent_reply TEXT NOT NULL,
      intent TEXT NOT NULL,
      keywords TEXT[] NOT NULL DEFAULT '{}',
      applicable_policy_ids UUID[] NOT NULL DEFAULT '{}',
      event_occurred_at TIMESTAMPTZ NOT NULL,
      policy_valid_at_that_time BOOLEAN NOT NULL DEFAULT FALSE,
      policy_independent BOOLEAN NOT NULL DEFAULT FALSE,
      review_status TEXT NOT NULL CHECK (review_status IN ('pending', 'approved', 'rejected', 'expired')),
      pii_redacted BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, source_conversation_id, intent)
    );
    CREATE INDEX IF NOT EXISTS historical_examples_tenant_review_idx
      ON historical_reply_examples(tenant_id, review_status, pii_redacted);
    CREATE TABLE IF NOT EXISTS ai_recommendations (
      recommendation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      idempotency_key TEXT,
      customer_id UUID NOT NULL REFERENCES customers(customer_id),
      conversation_id TEXT,
      question TEXT NOT NULL,
      context_snapshot JSONB NOT NULL,
      policy_decisions JSONB NOT NULL DEFAULT '[]'::jsonb,
      policy_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
      knowledge_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
      historical_examples JSONB NOT NULL DEFAULT '[]'::jsonb,
      recommendation_text TEXT,
      status TEXT NOT NULL CHECK (status IN ('generated', 'inserted', 'accepted', 'edited', 'rejected', 'expired_before_send', 'blocked_by_policy_conflict', 'insufficient_evidence')),
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      valid_until TIMESTAMPTZ NOT NULL,
      human_agent_action TEXT,
      human_agent_text TEXT,
      action_at TIMESTAMPTZ
    );
    ALTER TABLE ai_recommendations ADD COLUMN IF NOT EXISTS human_agent_text TEXT;
    ALTER TABLE ai_recommendations ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
    ALTER TABLE ai_recommendations ADD COLUMN IF NOT EXISTS tool_results JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE ai_recommendations ADD COLUMN IF NOT EXISTS evidence_panel JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE ai_recommendations ADD COLUMN IF NOT EXISTS confidence JSONB NOT NULL DEFAULT '{"score":0,"percent":0,"level":"low","evidence_source_count":0,"auto_reply_candidate":false,"delivery_mode":"human_confirmation","reasons":[]}'::jsonb;
    ALTER TABLE ai_recommendations ADD COLUMN IF NOT EXISTS sent_chatwoot_message_id TEXT;
    ALTER TABLE ai_recommendations ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
    ALTER TABLE ai_recommendations DROP CONSTRAINT IF EXISTS ai_recommendations_status_check;
    ALTER TABLE ai_recommendations ADD CONSTRAINT ai_recommendations_status_check
      CHECK (status IN ('generated', 'inserted', 'accepted', 'edited', 'rejected', 'expired_before_send', 'blocked_by_policy_conflict', 'insufficient_evidence'));
    CREATE UNIQUE INDEX IF NOT EXISTS ai_recommendations_tenant_idempotency_key
      ON ai_recommendations(tenant_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
    UPDATE ai_recommendations SET idempotency_key='legacy-' || recommendation_id::text
      WHERE idempotency_key IS NULL;
    CREATE INDEX IF NOT EXISTS ai_recommendations_tenant_created_idx
      ON ai_recommendations(tenant_id, generated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS ai_recommendations_chatwoot_message_unique
      ON ai_recommendations(tenant_id,sent_chatwoot_message_id) WHERE sent_chatwoot_message_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS channel_connections (
      connection_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      channel_type TEXT NOT NULL CHECK (channel_type IN ('wechat_official_account','web_chat','wechat_miniprogram')),
      display_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft','validating','ready','error','disabled')),
      credential_ref TEXT,
      configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_checked_at TIMESTAMPTZ,
      last_error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id,channel_type)
    );
    ALTER TABLE channel_connections DROP CONSTRAINT IF EXISTS channel_connections_channel_type_check;
    ALTER TABLE channel_connections ADD CONSTRAINT channel_connections_channel_type_check
      CHECK (channel_type IN ('wechat_official_account','web_chat','wechat_miniprogram','douyin','tiktok'));
    ALTER TABLE channel_connections ADD COLUMN IF NOT EXISTS callback_key TEXT;
    ALTER TABLE channel_connections ADD COLUMN IF NOT EXISTS external_account_id TEXT;
    ALTER TABLE channel_connections ADD COLUMN IF NOT EXISTS capability_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE channel_connections ADD COLUMN IF NOT EXISTS capability_checked_at TIMESTAMPTZ;
    ALTER TABLE channel_connections DROP CONSTRAINT IF EXISTS channel_connections_tenant_id_channel_type_key;
    CREATE UNIQUE INDEX IF NOT EXISTS channel_connections_callback_key_key
      ON channel_connections(callback_key) WHERE callback_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS channel_connections_external_account_key
      ON channel_connections(tenant_id,channel_type,external_account_id) WHERE external_account_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS channel_connections_synthetic_key
      ON channel_connections(tenant_id,channel_type)
      WHERE external_account_id IS NULL AND configuration->>'mode'='synthetic';
    CREATE TABLE IF NOT EXISTS channel_connection_events (
      event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      connection_id UUID NOT NULL REFERENCES channel_connections(connection_id),
      event_type TEXT NOT NULL,
      result TEXT NOT NULL CHECK (result IN ('succeeded','failed')),
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS channel_connection_events_tenant_created_idx
      ON channel_connection_events(tenant_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS social_events (
      social_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      channel_connection_id UUID NOT NULL REFERENCES channel_connections(connection_id),
      provider TEXT NOT NULL CHECK(provider IN ('douyin','tiktok')),
      event_type TEXT NOT NULL CHECK(event_type IN ('dm.message','comment.created','comment.reply','auth.revoked')),
      external_account_id TEXT NOT NULL CHECK(char_length(external_account_id) BETWEEN 1 AND 200),
      external_event_id TEXT NOT NULL CHECK(char_length(external_event_id) BETWEEN 1 AND 200),
      external_user_id TEXT NOT NULL CHECK(char_length(external_user_id) BETWEEN 1 AND 200),
      content TEXT NOT NULL CHECK(char_length(content)<=5000),
      content_hash TEXT NOT NULL CHECK(char_length(content_hash)=64),
      video_id TEXT,
      comment_id TEXT,
      parent_comment_id TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(metadata)='object'),
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','classified','routed','dead')),
      error_code TEXT,
      occurred_at TIMESTAMPTZ NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(channel_connection_id,external_event_id),
      CHECK(event_type NOT LIKE 'comment.%' OR (video_id IS NOT NULL AND comment_id IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS social_events_tenant_status_idx
      ON social_events(tenant_id,status,received_at,social_event_id);
    CREATE INDEX IF NOT EXISTS social_events_connection_user_idx
      ON social_events(channel_connection_id,external_user_id,occurred_at DESC);
    CREATE TABLE IF NOT EXISTS social_classifications (
      classification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      social_event_id UUID NOT NULL UNIQUE REFERENCES social_events(social_event_id),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      category TEXT NOT NULL CHECK(category IN ('spam','generic_interaction','purchase_intent','pre_sale_question','after_sales','complaint_risk','public_crisis','unknown')),
      confidence NUMERIC(5,4) NOT NULL CHECK(confidence BETWEEN 0 AND 1),
      source TEXT NOT NULL CHECK(source IN ('tenant_rule','deterministic','ai','fallback')),
      reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(reason_codes)='array'),
      matched_rule_id TEXT,
      classifier_version TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS social_classifications_tenant_category_idx
      ON social_classifications(tenant_id,category,created_at DESC);
    CREATE TABLE IF NOT EXISTS social_routing_decisions (
      routing_decision_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      social_event_id UUID NOT NULL UNIQUE REFERENCES social_events(social_event_id),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      route TEXT NOT NULL CHECK(route IN ('chatwoot_dm','metrics_only','suppressed','chatwoot_case','manual_review','escalate')),
      priority TEXT NOT NULL CHECK(priority IN ('low','normal','high','urgent')),
      requires_human BOOLEAN NOT NULL,
      action_gate JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(action_gate)='object'),
      policy_version TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS social_routing_tenant_route_idx
      ON social_routing_decisions(tenant_id,route,created_at DESC);
    CREATE TABLE IF NOT EXISTS social_tenant_rules (
      rule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      name TEXT NOT NULL CHECK(char_length(name) BETWEEN 2 AND 80),
      priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 10000),
      category TEXT NOT NULL CHECK(category IN ('spam','generic_interaction','purchase_intent','pre_sale_question','after_sales','complaint_risk','public_crisis')),
      keywords JSONB NOT NULL CHECK(jsonb_typeof(keywords)='array' AND jsonb_array_length(keywords) BETWEEN 1 AND 20),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
      version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
      created_by TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(tenant_id,name)
    );
    CREATE INDEX IF NOT EXISTS social_tenant_rules_active_idx
      ON social_tenant_rules(tenant_id,priority DESC,created_at) WHERE status='active';
    CREATE UNIQUE INDEX IF NOT EXISTS social_tenant_rules_active_priority_unique_idx
      ON social_tenant_rules(tenant_id,priority) WHERE status='active';
    CREATE TABLE IF NOT EXISTS social_classification_corrections (
      correction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      social_event_id UUID NOT NULL REFERENCES social_events(social_event_id),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      previous_category TEXT NOT NULL CHECK(previous_category IN ('spam','generic_interaction','purchase_intent','pre_sale_question','after_sales','complaint_risk','public_crisis','unknown')),
      corrected_category TEXT NOT NULL CHECK(corrected_category IN ('spam','generic_interaction','purchase_intent','pre_sale_question','after_sales','complaint_risk','public_crisis')),
      corrected_route TEXT NOT NULL CHECK(corrected_route IN ('chatwoot_dm','metrics_only','suppressed','chatwoot_case','manual_review','escalate')),
      corrected_priority TEXT NOT NULL CHECK(corrected_priority IN ('low','normal','high','urgent')),
      reason TEXT NOT NULL CHECK(char_length(reason) BETWEEN 10 AND 500),
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      request_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS social_corrections_event_created_idx
      ON social_classification_corrections(tenant_id,social_event_id,created_at DESC,correction_id DESC);
    CREATE TABLE IF NOT EXISTS social_classification_evaluations (
      evaluation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      social_event_id UUID NOT NULL REFERENCES social_events(social_event_id),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      machine_category TEXT NOT NULL CHECK(machine_category IN ('spam','generic_interaction','purchase_intent','pre_sale_question','after_sales','complaint_risk','public_crisis','unknown')),
      evaluated_category TEXT NOT NULL CHECK(evaluated_category IN ('spam','generic_interaction','purchase_intent','pre_sale_question','after_sales','complaint_risk','public_crisis')),
      outcome TEXT NOT NULL CHECK(outcome IN ('confirmed','corrected')),
      reason TEXT NOT NULL CHECK(char_length(reason) BETWEEN 10 AND 500),
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      request_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS social_evaluations_event_created_idx
      ON social_classification_evaluations(tenant_id,social_event_id,created_at DESC,evaluation_id DESC);
    CREATE TABLE IF NOT EXISTS social_case_actions (
      action_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      social_event_id UUID NOT NULL REFERENCES social_events(social_event_id),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      action TEXT NOT NULL CHECK(action IN ('acknowledge','resolve','reopen')),
      resulting_state TEXT NOT NULL CHECK(resulting_state IN ('pending','acknowledged','resolved')),
      reason TEXT NOT NULL CHECK(char_length(reason) BETWEEN 10 AND 500),
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      request_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS social_case_actions_event_created_idx
      ON social_case_actions(tenant_id,social_event_id,created_at DESC,action_id DESC);
    CREATE OR REPLACE FUNCTION prevent_social_decision_mutation() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'social classification and routing decisions are append-only'; END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS social_classifications_append_only ON social_classifications;
    CREATE TRIGGER social_classifications_append_only BEFORE UPDATE OR DELETE ON social_classifications
      FOR EACH ROW EXECUTE FUNCTION prevent_social_decision_mutation();
    DROP TRIGGER IF EXISTS social_routing_decisions_append_only ON social_routing_decisions;
    CREATE TRIGGER social_routing_decisions_append_only BEFORE UPDATE OR DELETE ON social_routing_decisions
      FOR EACH ROW EXECUTE FUNCTION prevent_social_decision_mutation();
    DROP TRIGGER IF EXISTS social_classification_corrections_append_only ON social_classification_corrections;
    CREATE TRIGGER social_classification_corrections_append_only BEFORE UPDATE OR DELETE ON social_classification_corrections
      FOR EACH ROW EXECUTE FUNCTION prevent_social_decision_mutation();
    DROP TRIGGER IF EXISTS social_classification_evaluations_append_only ON social_classification_evaluations;
    CREATE TRIGGER social_classification_evaluations_append_only BEFORE UPDATE OR DELETE ON social_classification_evaluations
      FOR EACH ROW EXECUTE FUNCTION prevent_social_decision_mutation();
    DROP TRIGGER IF EXISTS social_case_actions_append_only ON social_case_actions;
    CREATE TRIGGER social_case_actions_append_only BEFORE UPDATE OR DELETE ON social_case_actions
      FOR EACH ROW EXECUTE FUNCTION prevent_social_decision_mutation();
    CREATE TABLE IF NOT EXISTS gateway_events (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      external_event_id TEXT NOT NULL,
      external_message_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      payload JSONB NOT NULL,
      error TEXT,
      failure_code TEXT,
      chatwoot_message_id BIGINT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_attempt_at TIMESTAMPTZ,
      locked_at TIMESTAMPTZ,
      worker_id TEXT,
      dead_at TIMESTAMPTZ,
      replay_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ,
      UNIQUE (tenant_id, channel, external_event_id),
      UNIQUE (tenant_id, channel, external_message_id)
    );
    ALTER TABLE gateway_events ADD COLUMN IF NOT EXISTS channel_connection_id UUID REFERENCES channel_connections(connection_id);
    ALTER TABLE gateway_events DROP CONSTRAINT IF EXISTS gateway_events_tenant_id_channel_external_event_id_key;
    ALTER TABLE gateway_events DROP CONSTRAINT IF EXISTS gateway_events_tenant_id_channel_external_message_id_key;
    CREATE UNIQUE INDEX IF NOT EXISTS gateway_events_connection_event_key
      ON gateway_events(tenant_id,channel,COALESCE(channel_connection_id,'00000000-0000-0000-0000-000000000000'::uuid),external_event_id);
    CREATE UNIQUE INDEX IF NOT EXISTS gateway_events_connection_message_key
      ON gateway_events(tenant_id,channel,COALESCE(channel_connection_id,'00000000-0000-0000-0000-000000000000'::uuid),external_message_id);
    ALTER TABLE gateway_events ALTER COLUMN status SET DEFAULT 'queued';
    ALTER TABLE gateway_events ADD COLUMN IF NOT EXISTS failure_code TEXT;
    ALTER TABLE gateway_events ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE gateway_events ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 5;
    ALTER TABLE gateway_events ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE gateway_events ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
    ALTER TABLE gateway_events ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
    ALTER TABLE gateway_events ADD COLUMN IF NOT EXISTS worker_id TEXT;
    ALTER TABLE gateway_events ADD COLUMN IF NOT EXISTS dead_at TIMESTAMPTZ;
    ALTER TABLE gateway_events ADD COLUMN IF NOT EXISTS replay_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE gateway_events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    UPDATE gateway_events SET status='retry_pending',next_attempt_at=NOW(),updated_at=NOW()
      WHERE status='processing' AND processed_at IS NULL AND created_at < NOW()-INTERVAL '2 minutes';
    UPDATE gateway_events SET status='dead',failure_code=COALESCE(failure_code,'legacy_processing_failure'),
      error='Legacy failed event requires audited replay',dead_at=COALESCE(dead_at,NOW()),updated_at=NOW()
      WHERE status='failed';
    CREATE INDEX IF NOT EXISTS gateway_events_claim_idx
      ON gateway_events(status,next_attempt_at,id) WHERE status IN ('queued','retry_pending','processing');
    CREATE INDEX IF NOT EXISTS gateway_events_dead_idx
      ON gateway_events(tenant_id,dead_at DESC,id DESC) WHERE status='dead';
    CREATE TABLE IF NOT EXISTS channel_identities (
      id BIGSERIAL PRIMARY KEY,
      identity_id UUID NOT NULL DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL,
      customer_id UUID,
      channel TEXT NOT NULL,
      external_user_id TEXT NOT NULL,
      chatwoot_contact_id BIGINT,
      chatwoot_source_id TEXT NOT NULL,
      chatwoot_conversation_id BIGINT NOT NULL,
      sync_status TEXT NOT NULL DEFAULT 'synced',
      last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (identity_id),
      UNIQUE (tenant_id, channel, external_user_id)
    );
    ALTER TABLE channel_identities ADD COLUMN IF NOT EXISTS channel_connection_id UUID REFERENCES channel_connections(connection_id);
    ALTER TABLE channel_identities DROP CONSTRAINT IF EXISTS channel_identities_tenant_id_channel_external_user_id_key;
    CREATE UNIQUE INDEX IF NOT EXISTS channel_identities_connection_external_user_key
      ON channel_identities(tenant_id,channel,COALESCE(channel_connection_id,'00000000-0000-0000-0000-000000000000'::uuid),external_user_id);
    CREATE TABLE IF NOT EXISTS outbox_events (
      id BIGSERIAL PRIMARY KEY,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'published',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      published_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS outbound_deliveries (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT,
      chatwoot_message_id BIGINT NOT NULL UNIQUE,
      chatwoot_conversation_id BIGINT,
      external_user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'processing',
      payload JSONB NOT NULL,
      error TEXT,
      failure_code TEXT,
      retryable BOOLEAN NOT NULL DEFAULT FALSE,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TIMESTAMPTZ,
      last_attempt_at TIMESTAMPTZ,
      failure_notified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE outbound_deliveries ADD COLUMN IF NOT EXISTS tenant_id TEXT;
    ALTER TABLE outbound_deliveries ADD COLUMN IF NOT EXISTS chatwoot_conversation_id BIGINT;
    ALTER TABLE outbound_deliveries ADD COLUMN IF NOT EXISTS failure_code TEXT;
    ALTER TABLE outbound_deliveries ADD COLUMN IF NOT EXISTS retryable BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE outbound_deliveries ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE outbound_deliveries ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
    ALTER TABLE outbound_deliveries ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
    ALTER TABLE outbound_deliveries ADD COLUMN IF NOT EXISTS failure_notified_at TIMESTAMPTZ;
    ALTER TABLE outbound_deliveries ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    UPDATE outbound_deliveries d
       SET tenant_id=i.tenant_id, chatwoot_conversation_id=i.chatwoot_conversation_id
      FROM channel_identities i
     WHERE d.tenant_id IS NULL AND d.external_user_id=i.external_user_id;
    CREATE INDEX IF NOT EXISTS outbound_deliveries_tenant_status_idx
      ON outbound_deliveries(tenant_id,status,updated_at DESC);
    CREATE INDEX IF NOT EXISTS outbound_deliveries_retry_idx
      ON outbound_deliveries(status,next_retry_at) WHERE retryable=TRUE;
    CREATE UNIQUE INDEX IF NOT EXISTS channel_identities_tenant_identity_idx
      ON channel_identities(tenant_id,identity_id);
    CREATE TABLE IF NOT EXISTS marketing_consent_events (
      consent_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      identity_id UUID NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'marketing' CHECK(purpose='marketing'),
      status TEXT NOT NULL CHECK(status IN ('granted','withdrawn')),
      source TEXT NOT NULL CHECK(source IN ('customer_action','agent_recorded','imported_with_evidence')),
      evidence_ref TEXT NOT NULL CHECK(char_length(evidence_ref) BETWEEN 1 AND 200),
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      request_id UUID NOT NULL,
      idempotency_key TEXT NOT NULL CHECK(char_length(idempotency_key) BETWEEN 8 AND 128),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY(tenant_id,identity_id) REFERENCES channel_identities(tenant_id,identity_id),
      UNIQUE(tenant_id,idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS marketing_consent_latest_idx
      ON marketing_consent_events(tenant_id,identity_id,purpose,created_at DESC,consent_event_id DESC);
    CREATE OR REPLACE FUNCTION prevent_marketing_consent_mutation() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'marketing consent events are append-only'; END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS marketing_consent_events_append_only ON marketing_consent_events;
    CREATE TRIGGER marketing_consent_events_append_only BEFORE UPDATE OR DELETE ON marketing_consent_events
      FOR EACH ROW EXECUTE FUNCTION prevent_marketing_consent_mutation();
    CREATE TABLE IF NOT EXISTS message_campaigns (
      campaign_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      name TEXT NOT NULL CHECK(char_length(name) BETWEEN 2 AND 80),
      channel TEXT NOT NULL CHECK(channel IN ('wechat_official_account','mock-wechat')),
      purpose TEXT NOT NULL DEFAULT 'marketing' CHECK(purpose='marketing'),
      content TEXT NOT NULL CHECK(char_length(content) BETWEEN 1 AND 1000),
      audience_filter JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','snapshotted','approved','cancelled')),
      idempotency_key TEXT NOT NULL CHECK(char_length(idempotency_key) BETWEEN 8 AND 128),
      request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
      created_by UUID NOT NULL REFERENCES platform_users(platform_user_id),
      snapshot_at TIMESTAMPTZ,
      audience_total INTEGER NOT NULL DEFAULT 0 CHECK(audience_total>=0),
      eligible_total INTEGER NOT NULL DEFAULT 0 CHECK(eligible_total>=0 AND eligible_total<=audience_total),
      suppressed_total INTEGER NOT NULL DEFAULT 0 CHECK(suppressed_total>=0 AND suppressed_total<=audience_total),
      approved_by UUID REFERENCES platform_users(platform_user_id),
      approval_reason TEXT,
      approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(tenant_id,idempotency_key),
      CHECK(eligible_total+suppressed_total=audience_total),
      CHECK((status IN ('draft','cancelled') OR snapshot_at IS NOT NULL)),
      CHECK((status<>'approved') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND char_length(approval_reason) BETWEEN 10 AND 500))
    );
    ALTER TABLE message_campaigns ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
    ALTER TABLE message_campaigns ADD COLUMN IF NOT EXISTS channel_connection_id UUID REFERENCES channel_connections(connection_id);
    ALTER TABLE message_campaigns ADD COLUMN IF NOT EXISTS timezone TEXT;
    ALTER TABLE message_campaigns ADD COLUMN IF NOT EXISTS quiet_hours_start TIME;
    ALTER TABLE message_campaigns ADD COLUMN IF NOT EXISTS quiet_hours_end TIME;
    ALTER TABLE message_campaigns ADD COLUMN IF NOT EXISTS rate_limit_per_minute INTEGER;
    ALTER TABLE message_campaigns ADD COLUMN IF NOT EXISTS cancel_condition JSONB;
    ALTER TABLE message_campaigns ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
    ALTER TABLE message_campaigns ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
    ALTER TABLE message_campaigns DROP CONSTRAINT IF EXISTS message_campaigns_status_check;
    ALTER TABLE message_campaigns DROP CONSTRAINT IF EXISTS message_campaigns_status_v2_check;
    ALTER TABLE message_campaigns ADD CONSTRAINT message_campaigns_status_v2_check CHECK(status IN ('draft','snapshotted','approved','scheduled','running','paused','completed','failed','cancelled'));
    DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='message_campaigns_schedule_fields_check') THEN
        ALTER TABLE message_campaigns ADD CONSTRAINT message_campaigns_schedule_fields_check CHECK(
          (status IN ('draft','snapshotted','approved','cancelled')) OR
          (scheduled_at IS NOT NULL AND timezone IS NOT NULL AND quiet_hours_start IS NOT NULL AND quiet_hours_end IS NOT NULL AND rate_limit_per_minute BETWEEN 1 AND 100 AND cancel_condition IS NOT NULL)
        );
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS message_campaigns_tenant_created_idx ON message_campaigns(tenant_id,created_at DESC);
    CREATE OR REPLACE FUNCTION protect_message_campaign() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'message campaign history is immutable'; END IF;
      IF NEW.tenant_id<>OLD.tenant_id OR NEW.name<>OLD.name OR NEW.channel<>OLD.channel OR NEW.purpose<>OLD.purpose OR NEW.content<>OLD.content OR NEW.audience_filter<>OLD.audience_filter OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.request_hash<>OLD.request_hash OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at THEN
        RAISE EXCEPTION 'message campaign facts are immutable';
      END IF;
      IF OLD.status<>'approved' AND (NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at OR NEW.timezone IS DISTINCT FROM OLD.timezone OR NEW.quiet_hours_start IS DISTINCT FROM OLD.quiet_hours_start OR NEW.quiet_hours_end IS DISTINCT FROM OLD.quiet_hours_end OR NEW.rate_limit_per_minute IS DISTINCT FROM OLD.rate_limit_per_minute OR NEW.cancel_condition IS DISTINCT FROM OLD.cancel_condition) THEN
        RAISE EXCEPTION 'message campaign schedule is immutable';
      END IF;
      IF NOT ((OLD.status='draft' AND NEW.status IN ('snapshotted','cancelled')) OR (OLD.status='snapshotted' AND NEW.status IN ('approved','cancelled')) OR (OLD.status='approved' AND NEW.status IN ('scheduled','cancelled')) OR (OLD.status='scheduled' AND NEW.status IN ('running','paused','cancelled')) OR (OLD.status='running' AND NEW.status IN ('paused','completed','failed','cancelled')) OR (OLD.status='paused' AND NEW.status IN ('scheduled','running','cancelled')) OR (OLD.status='failed' AND NEW.status IN ('running','cancelled'))) THEN
        RAISE EXCEPTION 'invalid message campaign transition';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS message_campaigns_lifecycle ON message_campaigns;
    CREATE TRIGGER message_campaigns_lifecycle BEFORE UPDATE OR DELETE ON message_campaigns
      FOR EACH ROW EXECUTE FUNCTION protect_message_campaign();
    CREATE TABLE IF NOT EXISTS message_campaign_recipients (
      recipient_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id UUID NOT NULL REFERENCES message_campaigns(campaign_id),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      identity_id UUID NOT NULL,
      customer_id UUID NOT NULL REFERENCES customers(customer_id),
      consent_event_id UUID REFERENCES marketing_consent_events(consent_event_id),
      eligible BOOLEAN NOT NULL,
      suppression_reason TEXT CHECK(suppression_reason IN ('consent_missing','unsubscribed','identity_not_ready')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY(tenant_id,identity_id) REFERENCES channel_identities(tenant_id,identity_id),
      UNIQUE(campaign_id,identity_id),
      CHECK((eligible AND suppression_reason IS NULL) OR (NOT eligible AND suppression_reason IS NOT NULL))
    );
    CREATE OR REPLACE FUNCTION prevent_message_campaign_recipient_mutation() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'campaign audience snapshots are append-only'; END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS message_campaign_recipients_append_only ON message_campaign_recipients;
    CREATE TRIGGER message_campaign_recipients_append_only BEFORE UPDATE OR DELETE ON message_campaign_recipients
      FOR EACH ROW EXECUTE FUNCTION prevent_message_campaign_recipient_mutation();
    CREATE TABLE IF NOT EXISTS message_campaign_events (
      event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id UUID NOT NULL REFERENCES message_campaigns(campaign_id),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      event_type TEXT NOT NULL CHECK(event_type IN ('draft_created','audience_snapshotted','approved','cancelled')),
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      reason TEXT,
      facts JSONB NOT NULL DEFAULT '{}'::jsonb,
      request_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE message_campaign_events DROP CONSTRAINT IF EXISTS message_campaign_events_event_type_check;
    ALTER TABLE message_campaign_events DROP CONSTRAINT IF EXISTS message_campaign_events_event_type_v2_check;
    ALTER TABLE message_campaign_events ADD CONSTRAINT message_campaign_events_event_type_v2_check CHECK(event_type IN ('draft_created','audience_snapshotted','approved','scheduled','started','paused','resumed','completed','failed','cancelled','delivery_retried'));
    CREATE INDEX IF NOT EXISTS message_campaign_events_campaign_idx ON message_campaign_events(campaign_id,created_at);
    DROP TRIGGER IF EXISTS message_campaign_events_append_only ON message_campaign_events;
    CREATE TRIGGER message_campaign_events_append_only BEFORE UPDATE OR DELETE ON message_campaign_events
      FOR EACH ROW EXECUTE FUNCTION prevent_marketing_consent_mutation();
    CREATE TABLE IF NOT EXISTS message_campaign_deliveries (
      delivery_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id UUID NOT NULL REFERENCES message_campaigns(campaign_id),
      recipient_id UUID NOT NULL REFERENCES message_campaign_recipients(recipient_id),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','retry_pending','delivered','suppressed','dead','cancelled')),
      scheduled_for TIMESTAMPTZ NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 3),
      next_attempt_at TIMESTAMPTZ NOT NULL,
      locked_at TIMESTAMPTZ,
      worker_id TEXT,
      provider_receipt_id TEXT,
      failure_code TEXT,
      suppression_reason TEXT CHECK(suppression_reason IN ('consent_withdrawn','consent_missing','identity_not_ready','cancel_condition_matched')),
      delivered_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(campaign_id,recipient_id)
    );
    CREATE INDEX IF NOT EXISTS message_campaign_delivery_claim_idx ON message_campaign_deliveries(status,next_attempt_at,delivery_id) WHERE status IN ('queued','retry_pending','processing');
    CREATE INDEX IF NOT EXISTS campaign_created_metrics_idx ON message_campaigns(created_at);
    CREATE INDEX IF NOT EXISTS campaign_active_metrics_idx ON message_campaigns(status) WHERE status IN ('scheduled','running','paused');
    CREATE INDEX IF NOT EXISTS delivery_tenant_metrics_idx ON message_campaign_deliveries(tenant_id);
    CREATE INDEX IF NOT EXISTS delivery_created_metrics_idx ON message_campaign_deliveries(created_at);
    CREATE INDEX IF NOT EXISTS delivery_updated_metrics_idx ON message_campaign_deliveries(updated_at);
    CREATE OR REPLACE FUNCTION protect_message_campaign_delivery() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'campaign delivery history cannot be deleted'; END IF;
      IF NEW.campaign_id<>OLD.campaign_id OR NEW.recipient_id<>OLD.recipient_id OR NEW.tenant_id<>OLD.tenant_id OR NEW.scheduled_for<>OLD.scheduled_for OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'campaign delivery identity is immutable'; END IF;
      IF NEW.attempt_count<OLD.attempt_count OR NEW.attempt_count>3 THEN RAISE EXCEPTION 'invalid campaign attempt count'; END IF;
      IF NOT ((OLD.status IN ('queued','retry_pending') AND NEW.status=OLD.status AND NEW.next_attempt_at>OLD.next_attempt_at AND NEW.attempt_count=OLD.attempt_count) OR (OLD.status='queued' AND NEW.status IN ('processing','suppressed','cancelled')) OR (OLD.status='processing' AND NEW.status IN ('delivered','retry_pending','suppressed','dead','cancelled')) OR (OLD.status='retry_pending' AND NEW.status IN ('processing','suppressed','cancelled')) OR (OLD.status='dead' AND NEW.status='retry_pending' AND OLD.attempt_count<3 AND NEW.attempt_count=OLD.attempt_count AND NEW.next_attempt_at>OLD.next_attempt_at)) THEN RAISE EXCEPTION 'invalid campaign delivery transition'; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS message_campaign_deliveries_lifecycle ON message_campaign_deliveries;
    CREATE TRIGGER message_campaign_deliveries_lifecycle BEFORE UPDATE OR DELETE ON message_campaign_deliveries FOR EACH ROW EXECUTE FUNCTION protect_message_campaign_delivery();
    CREATE TABLE IF NOT EXISTS message_campaign_delivery_events (
      event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      delivery_id UUID NOT NULL REFERENCES message_campaign_deliveries(delivery_id),
      campaign_id UUID NOT NULL REFERENCES message_campaigns(campaign_id),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      event_type TEXT NOT NULL CHECK(event_type IN ('queued','attempted','retry_scheduled','manual_retry','delivered','suppressed','dead','cancelled')),
      facts JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS message_campaign_delivery_events_delivery_idx ON message_campaign_delivery_events(delivery_id,created_at);
    ALTER TABLE message_campaign_delivery_events DROP CONSTRAINT IF EXISTS message_campaign_delivery_events_event_type_check;
    ALTER TABLE message_campaign_delivery_events DROP CONSTRAINT IF EXISTS message_campaign_delivery_events_event_type_v2_check;
    ALTER TABLE message_campaign_delivery_events ADD CONSTRAINT message_campaign_delivery_events_event_type_v2_check CHECK(event_type IN ('queued','attempted','retry_scheduled','manual_retry','delivered','suppressed','dead','cancelled'));
    DROP TRIGGER IF EXISTS message_campaign_delivery_events_append_only ON message_campaign_delivery_events;
    CREATE TRIGGER message_campaign_delivery_events_append_only BEFORE UPDATE OR DELETE ON message_campaign_delivery_events FOR EACH ROW EXECUTE FUNCTION prevent_marketing_consent_mutation();
    CREATE TABLE IF NOT EXISTS notification_preferences (
      tenant_id TEXT PRIMARY KEY REFERENCES tenants(tenant_id),
      channels TEXT[] NOT NULL DEFAULT ARRAY['in_app','chatwoot']::TEXT[],
      minimum_external_severity TEXT NOT NULL DEFAULT 'warning'
        CHECK (minimum_external_severity IN ('info','warning','critical')),
      quiet_hours_start TIME NOT NULL DEFAULT '22:00',
      quiet_hours_end TIME NOT NULL DEFAULT '08:00',
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      escalation_minutes INTEGER NOT NULL DEFAULT 15 CHECK (escalation_minutes BETWEEN 5 AND 1440),
      message_notification_mode TEXT NOT NULL DEFAULT 'unattended'
        CHECK (message_notification_mode IN ('off','every_message','unattended','both')),
      unattended_minutes INTEGER NOT NULL DEFAULT 10 CHECK (unattended_minutes BETWEEN 1 AND 1440),
      include_message_preview BOOLEAN NOT NULL DEFAULT FALSE,
      updated_by TEXT NOT NULL DEFAULT 'system',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (channels <@ ARRAY['in_app','chatwoot','enterprise_wechat','browser_push']::TEXT[]),
      CHECK (channels @> ARRAY['in_app']::TEXT[])
    );
    CREATE TABLE IF NOT EXISTS notification_events (
      notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
      title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
      summary TEXT NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 500),
      resource_type TEXT,
      resource_id TEXT,
      dedupe_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
      requires_action BOOLEAN NOT NULL DEFAULT TRUE,
      occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count>0),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      first_occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      acknowledged_by UUID REFERENCES platform_users(platform_user_id),
      acknowledged_at TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ,
      escalated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS notification_events_open_dedupe_idx
      ON notification_events(tenant_id,dedupe_key) WHERE status IN ('open','acknowledged');
    CREATE INDEX IF NOT EXISTS notification_events_tenant_status_idx
      ON notification_events(tenant_id,status,last_occurred_at DESC);
    CREATE TABLE IF NOT EXISTS notification_deliveries (
      delivery_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      notification_id UUID NOT NULL REFERENCES notification_events(notification_id),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      channel TEXT NOT NULL CHECK (channel IN ('in_app','chatwoot','enterprise_wechat','browser_push','webhook')),
      target_ref TEXT NOT NULL DEFAULT 'tenant',
      status TEXT NOT NULL CHECK (status IN ('pending','delivered','dry_run','suppressed','failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      provider_ref TEXT,
      error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (notification_id,channel,target_ref)
    );
    CREATE INDEX IF NOT EXISTS notification_deliveries_pending_idx
      ON notification_deliveries(status,next_attempt_at) WHERE status='pending';
    CREATE TABLE IF NOT EXISTS notification_receipts (
      notification_id UUID NOT NULL REFERENCES notification_events(notification_id),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      platform_user_id UUID NOT NULL REFERENCES platform_users(platform_user_id),
      read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (notification_id,platform_user_id)
    );
    ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS message_notification_mode TEXT NOT NULL DEFAULT 'unattended';
    ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS unattended_minutes INTEGER NOT NULL DEFAULT 10;
    ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS include_message_preview BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE notification_preferences DROP CONSTRAINT IF EXISTS notification_preferences_message_notification_mode_check;
    ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_message_notification_mode_check
      CHECK (message_notification_mode IN ('off','every_message','unattended','both'));
    ALTER TABLE notification_preferences DROP CONSTRAINT IF EXISTS notification_preferences_unattended_minutes_check;
    ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_unattended_minutes_check
      CHECK (unattended_minutes BETWEEN 1 AND 1440);
    ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS requires_action BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE notification_deliveries DROP CONSTRAINT IF EXISTS notification_deliveries_channel_check;
    ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_channel_check
      CHECK (channel IN ('in_app','chatwoot','enterprise_wechat','browser_push','webhook'));
    ALTER TABLE notification_preferences DROP CONSTRAINT IF EXISTS notification_preferences_channels_check;
    ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_channels_check
      CHECK (channels <@ ARRAY['in_app','chatwoot','enterprise_wechat','browser_push']::TEXT[] AND channels @> ARRAY['in_app']::TEXT[]);
    CREATE TABLE IF NOT EXISTS browser_push_subscriptions (
      subscription_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      platform_user_id UUID NOT NULL REFERENCES platform_users(platform_user_id),
      endpoint_hash TEXT NOT NULL,
      endpoint_ciphertext TEXT NOT NULL,
      p256dh_ciphertext TEXT NOT NULL,
      auth_ciphertext TEXT NOT NULL,
      device_label TEXT NOT NULL DEFAULT 'Browser' CHECK (char_length(device_label) BETWEEN 1 AND 80),
      user_agent TEXT CHECK (user_agent IS NULL OR char_length(user_agent)<=300),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
      failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count>=0),
      last_success_at TIMESTAMPTZ,
      last_failure_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id,platform_user_id,endpoint_hash)
    );
    CREATE INDEX IF NOT EXISTS browser_push_subscriptions_active_idx
      ON browser_push_subscriptions(tenant_id,status) WHERE status='active';
    CREATE TABLE IF NOT EXISTS notification_webhook_destinations (
      destination_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      provider TEXT NOT NULL CHECK (provider IN ('feishu','wecom','dingtalk','custom')),
      display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
      endpoint_ciphertext TEXT NOT NULL,
      signing_secret_ciphertext TEXT,
      endpoint_host TEXT NOT NULL CHECK (char_length(endpoint_host) BETWEEN 1 AND 253),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
      last_tested_at TIMESTAMPTZ,
      last_test_status TEXT CHECK (last_test_status IN ('delivered','failed')),
      last_error_code TEXT,
      created_by UUID REFERENCES platform_users(platform_user_id),
      updated_by UUID REFERENCES platform_users(platform_user_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id,display_name)
    );
    CREATE INDEX IF NOT EXISTS notification_webhook_destinations_active_idx
      ON notification_webhook_destinations(tenant_id,status,created_at) WHERE status='active';
    CREATE TABLE IF NOT EXISTS tenant_quick_replies (
      quick_reply_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      shortcut TEXT NOT NULL CHECK (shortcut ~ '^[a-z0-9_-]{1,32}$'),
      title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
      content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
      created_by UUID REFERENCES platform_users(platform_user_id),
      updated_by UUID REFERENCES platform_users(platform_user_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS tenant_quick_replies_active_shortcut_key
      ON tenant_quick_replies(tenant_id,shortcut) WHERE status='active';
    CREATE INDEX IF NOT EXISTS tenant_quick_replies_search_idx
      ON tenant_quick_replies(tenant_id,status,updated_at DESC);
    CREATE TABLE IF NOT EXISTS conversation_attention (
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      chatwoot_conversation_id BIGINT NOT NULL,
      last_inbound_message_id TEXT NOT NULL,
      last_inbound_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      message_preview TEXT,
      last_outbound_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','responded')),
      unattended_notification_id UUID REFERENCES notification_events(notification_id),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id,chatwoot_conversation_id)
    );
    ALTER TABLE conversation_attention ADD COLUMN IF NOT EXISTS message_preview TEXT;
    CREATE INDEX IF NOT EXISTS conversation_attention_pending_idx
      ON conversation_attention(status,last_inbound_at) WHERE status='pending';
    ALTER TABLE channel_identities ADD COLUMN IF NOT EXISTS identity_id UUID DEFAULT gen_random_uuid();
    ALTER TABLE channel_identities ADD COLUMN IF NOT EXISTS customer_id UUID;
    ALTER TABLE channel_identities ADD COLUMN IF NOT EXISTS sync_status TEXT NOT NULL DEFAULT 'synced';
    ALTER TABLE channel_identities ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    UPDATE channel_identities SET identity_id=gen_random_uuid() WHERE identity_id IS NULL;
    ALTER TABLE channel_identities ALTER COLUMN identity_id SET NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS channel_identities_identity_id_key ON channel_identities(identity_id);
    ALTER TABLE channel_identities DROP CONSTRAINT IF EXISTS channel_identities_chatwoot_conversation_id_key;
    CREATE UNIQUE INDEX IF NOT EXISTS channel_identities_tenant_conversation_key
      ON channel_identities(tenant_id, chatwoot_conversation_id);
    CREATE TABLE IF NOT EXISTS conversation_resource_mappings (
      replynest_resource_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      resource_type TEXT NOT NULL CHECK(resource_type IN ('conversation','message','attachment')),
      chatwoot_account_id BIGINT NOT NULL,
      chatwoot_resource_id TEXT NOT NULL CHECK(char_length(chatwoot_resource_id) BETWEEN 1 AND 128),
      parent_replynest_resource_id UUID REFERENCES conversation_resource_mappings(replynest_resource_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(tenant_id,resource_type,chatwoot_account_id,chatwoot_resource_id)
    );
    CREATE INDEX IF NOT EXISTS conversation_resource_mappings_tenant_resource_idx
      ON conversation_resource_mappings(tenant_id,resource_type,replynest_resource_id);
    CREATE TABLE IF NOT EXISTS conversation_file_transfers (
      transfer_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
      conversation_replynest_id UUID NOT NULL REFERENCES conversation_resource_mappings(replynest_resource_id),
      direction TEXT NOT NULL CHECK(direction IN ('outbound_download','inbound_upload')),
      status TEXT NOT NULL CHECK(status IN ('pending_upload','ready','infected','expired','revoked')),
      file_name TEXT,
      mime_type TEXT,
      size_bytes BIGINT CHECK(size_bytes IS NULL OR (size_bytes BETWEEN 1 AND 26214400)),
      storage_key TEXT,
      token_hash CHAR(64) NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      max_downloads INTEGER NOT NULL DEFAULT 10 CHECK(max_downloads BETWEEN 1 AND 100),
      download_count INTEGER NOT NULL DEFAULT 0 CHECK(download_count >= 0),
      created_by UUID REFERENCES platform_users(platform_user_id),
      uploaded_at TIMESTAMPTZ,
      last_downloaded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK ((status='pending_upload' AND direction='inbound_upload' AND storage_key IS NULL)
          OR (status<>'pending_upload')),
      CHECK ((status='ready' AND file_name IS NOT NULL AND mime_type IS NOT NULL AND size_bytes IS NOT NULL AND storage_key IS NOT NULL)
          OR status<>'ready')
    );
    CREATE INDEX IF NOT EXISTS conversation_file_transfers_tenant_conversation_idx
      ON conversation_file_transfers(tenant_id,conversation_replynest_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS conversation_file_transfers_expiry_idx
      ON conversation_file_transfers(status,expires_at);
    CREATE OR REPLACE FUNCTION prevent_conversation_resource_mapping_delete() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'conversation resource mappings cannot be deleted';
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS conversation_resource_mapping_no_delete ON conversation_resource_mappings;
    CREATE TRIGGER conversation_resource_mapping_no_delete BEFORE DELETE ON conversation_resource_mappings
      FOR EACH ROW EXECUTE FUNCTION prevent_conversation_resource_mapping_delete();
    ${massCampaignSchema}
    ${campaignMonitorSchema}
  `;
}

export async function migrate(): Promise<void> {
  await pool.query(businessSchemaSql());
}

function apiKeyHash(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export async function seedBusinessLayer(): Promise<void> {
  const demoTenantId = requiredEnv("DEMO_TENANT_ID");
  const demoTenantName = requiredEnv("DEMO_TENANT_NAME");
  const demoApiKey = requiredEnv("DEMO_TENANT_API_KEY");
  const isolationTenantId = requiredEnv("ISOLATION_TEST_TENANT_ID");
  const isolationApiKey = requiredEnv("ISOLATION_TEST_TENANT_API_KEY");
  const chatwootAccountId = Number(requiredEnv("CHATWOOT_ACCOUNT_ID"));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO tenants (tenant_id, name, status, chatwoot_account_id, signup_source)
       VALUES ($1, $2, 'active', $3, 'platform_operator')
       ON CONFLICT (tenant_id) DO UPDATE SET name=EXCLUDED.name, chatwoot_account_id=EXCLUDED.chatwoot_account_id, updated_at=NOW()`,
      [demoTenantId, demoTenantName, chatwootAccountId]
    );
    await client.query(
      `INSERT INTO tenants (tenant_id, name, status, signup_source)
       VALUES ($1, '隔离测试企业', 'test', 'automated_test')
       ON CONFLICT (tenant_id) DO NOTHING`,
      [isolationTenantId]
    );
    await client.query(
      `INSERT INTO channel_connections
        (tenant_id,channel_type,display_name,status,configuration,last_checked_at)
       SELECT $1,'wechat_official_account','合成微信公众号','ready',
              '{"mode":"synthetic","authorization":"mock_oauth","callback_verified":true}'::jsonb,NOW()
        WHERE NOT EXISTS (
          SELECT 1 FROM channel_connections
           WHERE tenant_id=$1 AND channel_type='wechat_official_account'
             AND external_account_id IS NULL AND configuration->>'mode'='synthetic'
        )`,
      [demoTenantId]
    );
    await client.query(
      `INSERT INTO tenant_ai_settings
        (tenant_id,llm_provider,llm_model,embedding_provider,updated_by)
       VALUES
        ($1,'deterministic','deterministic-phase4-sample','none','platform_operator'),
        ($2,'deterministic','deterministic-phase4-sample','none','platform_operator')
       ON CONFLICT (tenant_id) DO NOTHING`,
      [demoTenantId, isolationTenantId]
    );
    for (const item of [
      { tenantId: demoTenantId, rawKey: demoApiKey },
      { tenantId: isolationTenantId, rawKey: isolationApiKey }
    ]) {
      await client.query(
        `INSERT INTO tenant_api_keys (tenant_id, key_hash, key_hint, role)
         VALUES ($1, $2, $3, 'tenant_admin') ON CONFLICT (key_hash) DO NOTHING`,
        [item.tenantId, apiKeyHash(item.rawKey), item.rawKey.slice(-6)]
      );
    }
    const unmapped = await client.query<{ id: string; tenant_id: string; external_user_id: string }>(
      `SELECT id, tenant_id, external_user_id FROM channel_identities WHERE customer_id IS NULL FOR UPDATE`
    );
    for (const identity of unmapped.rows) {
      const customer = await client.query<{ customer_id: string }>(
        `INSERT INTO customers (tenant_id, name, attributes)
         VALUES ($1, $2, '{"migrated_from":"phase2"}'::jsonb) RETURNING customer_id`,
        [identity.tenant_id, identity.external_user_id]
      );
      await client.query(`UPDATE channel_identities SET customer_id=$1 WHERE id=$2`, [customer.rows[0].customer_id, identity.id]);
    }
    await client.query(
      `INSERT INTO customers (tenant_id, name, attributes)
       SELECT $1, '隔离测试客户', '{"test_fixture":true}'::jsonb
       WHERE NOT EXISTS (SELECT 1 FROM customers WHERE tenant_id=$1)`,
      [isolationTenantId]
    );
    await client.query(
      `INSERT INTO mock_orders
        (tenant_id,external_order_id,customer_id,status,amount_cents,currency,product_summary,product_batch_id,placed_at,paid_at,fulfilled_at)
       SELECT $1,'ORD-SHARED-001',customer_id,'shipped',12900,'CNY','星云路由器（合成）','BATCH-2026-08',
              NOW()-INTERVAL '5 days',NOW()-INTERVAL '5 days',NOW()-INTERVAL '1 day'
         FROM customers WHERE tenant_id=$1 ORDER BY created_at LIMIT 1
       ON CONFLICT (tenant_id,external_order_id) DO NOTHING`,
      [demoTenantId]
    );
    await client.query(
      `INSERT INTO mock_orders
        (tenant_id,external_order_id,customer_id,status,amount_cents,currency,product_summary,product_batch_id,placed_at,paid_at)
       SELECT $1,'ORD-SHARED-001',customer_id,'paid',8800,'CNY','隔离企业合成产品','ISOLATION-BATCH',
              NOW()-INTERVAL '2 days',NOW()-INTERVAL '2 days'
         FROM customers WHERE tenant_id=$1 ORDER BY created_at LIMIT 1
       ON CONFLICT (tenant_id,external_order_id) DO NOTHING`,
      [isolationTenantId]
    );
    await client.query(
      `INSERT INTO knowledge_documents (tenant_id, title, source_type, content, keywords)
       VALUES
         ($1, '标准退款说明', 'knowledge', '常规退款需要核对订单状态、商品状态和企业正式售后政策；AI 只能建议，不能直接执行退款。', ARRAY['退款','退货','售后']),
         ($1, '优惠沟通语气', 'script', '向符合条件的客户说明优惠时，应清楚说明适用范围、截止时间和使用限制，避免承诺未确认权益。', ARRAY['优惠','优惠券','活动'])
       ON CONFLICT (tenant_id, title, version) DO NOTHING`,
      [demoTenantId]
    );
    await client.query(
      `INSERT INTO knowledge_documents (tenant_id, title, source_type, content, keywords)
       VALUES ($1, '隔离企业机密政策', 'knowledge', 'ISOLATION-TENANT-SECRET-CONTENT', ARRAY['退款','机密'])
       ON CONFLICT (tenant_id, title, version) DO NOTHING`,
      [isolationTenantId]
    );
    await client.query(
      `INSERT INTO temporary_policies
        (tenant_id, name, policy_type, status, priority, valid_from, valid_until, eligibility_time_basis,
         scope, conditions, decision, allowed_actions, reply_guidance, version, created_by, approved_by)
       VALUES
        ($1, 'BATCH-2026-08 临时退款规则', 'refund', 'active', 200, NOW()-INTERVAL '7 days', NOW()+INTERVAL '30 days', 'request_time',
         '{"product_batch_ids":["BATCH-2026-08"],"channels":["mock-wechat"]}', '{}',
         '{"eligibility":"eligible","shipping_fee_refund":true}', ARRAY['recommend_refund'],
         '该批次属于临时退款处理范围。请先核对订单和商品状态，再由人工客服确认退款资格；不要直接承诺退款已完成。', 1, 'platform_operator', 'tenant_admin'),
        ($1, 'BATCH-OLD 已过期退款规则', 'refund', 'expired', 200, NOW()-INTERVAL '60 days', NOW()-INTERVAL '30 days', 'request_time',
         '{"product_batch_ids":["BATCH-OLD"]}', '{}', '{"eligibility":"eligible"}', ARRAY['recommend_refund'],
         '历史上该批次允许特殊退款。', 1, 'platform_operator', 'tenant_admin'),
        ($1, 'Mock 微信新客临时优惠', 'promotion', 'active', 150, NOW()-INTERVAL '2 days', NOW()+INTERVAL '14 days', 'registration_time',
         '{"channels":["mock-wechat"],"customer_segments":["new-customer"]}', '{}',
         '{"eligibility":"eligible","benefit":"TEMP-COUPON"}', ARRAY['recommend_coupon'],
         '该客户可能符合本期渠道优惠，请核对注册时间后说明优惠截止时间和使用限制。', 1, 'platform_operator', 'tenant_admin'),
        ($1, '冲突测试规则 A', 'refund', 'active', 300, NOW()-INTERVAL '1 day', NOW()+INTERVAL '7 days', 'request_time',
         '{"product_batch_ids":["BATCH-CONFLICT"]}', '{}', '{"eligibility":"eligible"}', ARRAY['recommend_refund'],
         '规则 A 认为符合退款条件。', 1, 'automated_test', 'tenant_admin'),
        ($1, '冲突测试规则 B', 'refund', 'active', 300, NOW()-INTERVAL '1 day', NOW()+INTERVAL '7 days', 'request_time',
         '{"product_batch_ids":["BATCH-CONFLICT"]}', '{}', '{"eligibility":"ineligible"}', ARRAY[]::TEXT[],
         '规则 B 认为不符合退款条件。', 1, 'automated_test', 'tenant_admin')
       ON CONFLICT (tenant_id, name, version) DO NOTHING`,
      [demoTenantId]
    );
    await client.query(
      `INSERT INTO historical_reply_examples
        (tenant_id, source_conversation_id, customer_question, agent_reply, intent, keywords,
         applicable_policy_ids, event_occurred_at, policy_valid_at_that_time, policy_independent, review_status, pii_redacted)
       VALUES
        ($1, 'history-expired-policy', '这个旧批次可以退款吗？', '当时可以直接按临时政策办理退款。', 'refund', ARRAY['退款','旧批次'],
         ARRAY[(SELECT policy_id FROM temporary_policies WHERE tenant_id=$1 AND name='BATCH-OLD 已过期退款规则' AND version=1)],
         NOW()-INTERVAL '45 days', TRUE, FALSE, 'approved', TRUE),
        ($1, 'history-tone-example', '退款进度怎么样？', '您好，我先帮您核对订单和适用政策，请稍候。', 'refund', ARRAY['退款','进度'],
         ARRAY[]::UUID[], NOW()-INTERVAL '10 days', FALSE, TRUE, 'approved', TRUE),
        ($1, 'history-unreviewed', '可以发优惠券吗？', '可以，马上给您发。', 'promotion', ARRAY['优惠券'],
         ARRAY[]::UUID[], NOW()-INTERVAL '1 day', FALSE, TRUE, 'pending', TRUE)
       ON CONFLICT (tenant_id, source_conversation_id, intent) DO NOTHING`,
      [demoTenantId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await pool.query(`ALTER TABLE channel_identities ALTER COLUMN customer_id SET NOT NULL`);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='channel_identities_customer_fk') THEN
        ALTER TABLE channel_identities ADD CONSTRAINT channel_identities_customer_fk
          FOREIGN KEY (customer_id) REFERENCES customers(customer_id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='channel_identities_tenant_fk') THEN
        ALTER TABLE channel_identities ADD CONSTRAINT channel_identities_tenant_fk
          FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id);
      END IF;
    END $$;
  `);
}

export type Identity = {
  customer_id: string;
  external_user_id: string;
  channel: string;
  chatwoot_source_id: string;
  chatwoot_conversation_id: string;
  channel_connection_id: string | null;
};

export async function findIdentity(tenantId: string, externalUserId: string, channel = "mock-wechat", connectionId: string | null = null): Promise<Identity | undefined> {
  const result = await pool.query<Identity>(
    `SELECT customer_id, external_user_id, channel, chatwoot_source_id, chatwoot_conversation_id,channel_connection_id
       FROM channel_identities WHERE tenant_id=$1 AND channel=$2 AND external_user_id=$3
        AND channel_connection_id IS NOT DISTINCT FROM $4::uuid`,
    [tenantId, channel, externalUserId, connectionId]
  );
  return result.rows[0];
}

export async function findIdentityByConversation(tenantId: string, conversationId: string): Promise<Identity | undefined> {
  const result = await pool.query<Identity>(
    `SELECT customer_id, external_user_id, channel, chatwoot_source_id, chatwoot_conversation_id,channel_connection_id
       FROM channel_identities WHERE tenant_id=$1 AND chatwoot_conversation_id=$2`,
    [tenantId, conversationId]
  );
  return result.rows[0];
}
