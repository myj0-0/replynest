export const subscriptionMailSchema=`
CREATE TABLE IF NOT EXISTS subscription_mail_rollout(id INTEGER PRIMARY KEY CHECK(id=1),starts_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp());
INSERT INTO subscription_mail_rollout(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS subscription_mail_events(
 event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),event_key TEXT UNIQUE NOT NULL,
 tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),subscription_id UUID NOT NULL REFERENCES tenant_subscriptions(subscription_id),
 kind TEXT NOT NULL CHECK(kind IN ('purchased','expiring')),period_end TIMESTAMPTZ NOT NULL,
 facts JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','prepared','canceled')));
ALTER TABLE subscription_mail_events ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS subscription_mail_events_due ON subscription_mail_events(next_attempt_at) WHERE status='pending';
CREATE INDEX IF NOT EXISTS subscription_mail_expiry ON tenant_subscriptions(current_period_end) WHERE status='active' AND source='payment';
CREATE TABLE IF NOT EXISTS subscription_mail_deliveries(
 delivery_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),event_id UUID NOT NULL REFERENCES subscription_mail_events(event_id),
 email TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','retry','review','canceled')),
 attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 error_code TEXT,UNIQUE(event_id,email));
CREATE INDEX IF NOT EXISTS subscription_mail_due ON subscription_mail_deliveries(next_attempt_at) WHERE status IN ('pending','retry');
`;
