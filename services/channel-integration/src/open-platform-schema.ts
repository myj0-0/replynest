export const openPlatformSchema = `
ALTER TABLE tenant_extensions ADD COLUMN IF NOT EXISTS workbench_enabled BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS extension_context_grants (
 tenant_id TEXT NOT NULL, extension_id UUID NOT NULL, version INTEGER NOT NULL,
 platform_user_id UUID NOT NULL REFERENCES platform_users(platform_user_id), scopes JSONB NOT NULL,
 granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '90 days',
 PRIMARY KEY(tenant_id,extension_id,version,platform_user_id),
 FOREIGN KEY(tenant_id,extension_id,version) REFERENCES tenant_extension_versions(tenant_id,extension_id,version)
);
CREATE TABLE IF NOT EXISTS external_apps (
 tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id), app_id UUID NOT NULL DEFAULT gen_random_uuid(),
 name TEXT NOT NULL, scopes JSONB NOT NULL, token_hash TEXT NOT NULL UNIQUE,
 created_by UUID NOT NULL REFERENCES platform_users(platform_user_id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL,
 revoked_at TIMESTAMPTZ, webhook_url_cipher TEXT, webhook_secret_cipher TEXT,
 PRIMARY KEY(tenant_id,app_id)
);
CREATE TABLE IF NOT EXISTS external_app_rate (
 tenant_id TEXT NOT NULL, app_id UUID NOT NULL, bucket TIMESTAMPTZ NOT NULL, count INTEGER NOT NULL,
 PRIMARY KEY(tenant_id,app_id), FOREIGN KEY(tenant_id,app_id) REFERENCES external_apps(tenant_id,app_id)
);
CREATE TABLE IF NOT EXISTS external_app_records (
 tenant_id TEXT NOT NULL, app_id UUID NOT NULL, record_id UUID NOT NULL DEFAULT gen_random_uuid(),
 idempotency_key UUID NOT NULL, input_hash TEXT NOT NULL, data JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(tenant_id,app_id,record_id),
 UNIQUE(tenant_id,app_id,idempotency_key), FOREIGN KEY(tenant_id,app_id) REFERENCES external_apps(tenant_id,app_id)
);
CREATE TABLE IF NOT EXISTS external_app_events (
 tenant_id TEXT NOT NULL, app_id UUID NOT NULL, event_id UUID NOT NULL DEFAULT gen_random_uuid(),
 payload JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(tenant_id,app_id,event_id), FOREIGN KEY(tenant_id,app_id) REFERENCES external_apps(tenant_id,app_id)
);
CREATE INDEX IF NOT EXISTS external_app_events_pending ON external_app_events(next_attempt_at) WHERE status='pending';
`;
