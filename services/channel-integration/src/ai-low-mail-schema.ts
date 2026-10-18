export const aiLowMailSchema=`
CREATE TABLE IF NOT EXISTS ai_low_mail_state(
 tenant_id TEXT PRIMARY KEY REFERENCES tenants(tenant_id),
 is_low BOOLEAN NOT NULL DEFAULT FALSE,generation BIGINT NOT NULL DEFAULT 0,
 last_enqueued_at TIMESTAMPTZ,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE ai_low_mail_state ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS ai_low_mail_events(
 event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
 generation BIGINT NOT NULL,facts JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','prepared','canceled')),
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(tenant_id,generation)
);
CREATE INDEX IF NOT EXISTS ai_low_mail_events_due ON ai_low_mail_events(next_attempt_at,event_id) WHERE status='pending';
CREATE TABLE IF NOT EXISTS ai_low_mail_deliveries(
 delivery_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),event_id UUID NOT NULL REFERENCES ai_low_mail_events(event_id),
 email TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','retry','review','canceled')),
 attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 error_code TEXT,UNIQUE(event_id,email)
);
CREATE INDEX IF NOT EXISTS ai_low_mail_due ON ai_low_mail_deliveries(next_attempt_at,delivery_id) WHERE status IN ('pending','retry');
CREATE INDEX IF NOT EXISTS ai_low_mail_issues ON ai_low_mail_deliveries(updated_at DESC,delivery_id) WHERE status IN ('retry','review');
`;
