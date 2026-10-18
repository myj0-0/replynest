export const extensionSchema = `
CREATE TABLE IF NOT EXISTS tenant_extensions (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  extension_id UUID NOT NULL DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  active_version INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(tenant_id,extension_id)
);
CREATE TABLE IF NOT EXISTS tenant_extension_versions (
  tenant_id TEXT NOT NULL, extension_id UUID NOT NULL, version INTEGER NOT NULL CHECK(version>0),
  definition JSONB NOT NULL, definition_hash TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES platform_users(platform_user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(tenant_id,extension_id,version),
  FOREIGN KEY(tenant_id,extension_id) REFERENCES tenant_extensions(tenant_id,extension_id)
);
CREATE TABLE IF NOT EXISTS tenant_extension_simulations (
  tenant_id TEXT NOT NULL, extension_id UUID NOT NULL, version INTEGER NOT NULL,
  simulation_id UUID NOT NULL DEFAULT gen_random_uuid(),
  actor_id UUID NOT NULL REFERENCES platform_users(platform_user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(tenant_id,simulation_id), UNIQUE(tenant_id,extension_id,version),
  FOREIGN KEY(tenant_id,extension_id,version) REFERENCES tenant_extension_versions(tenant_id,extension_id,version)
);
CREATE TABLE IF NOT EXISTS tenant_extension_records (
  tenant_id TEXT NOT NULL, extension_id UUID NOT NULL, version INTEGER NOT NULL,
  record_id UUID NOT NULL DEFAULT gen_random_uuid(), idempotency_key UUID NOT NULL,
  input_hash TEXT NOT NULL, data JSONB NOT NULL, trace JSONB NOT NULL,
  created_by UUID NOT NULL REFERENCES platform_users(platform_user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(tenant_id,record_id), UNIQUE(tenant_id,extension_id,idempotency_key),
  FOREIGN KEY(tenant_id,extension_id,version) REFERENCES tenant_extension_versions(tenant_id,extension_id,version)
);
CREATE INDEX IF NOT EXISTS tenant_extension_records_list ON tenant_extension_records(tenant_id,extension_id,created_at DESC);
CREATE TABLE IF NOT EXISTS tenant_extension_generations (
  generation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  actor_id UUID NOT NULL REFERENCES platform_users(platform_user_id),
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','succeeded','failed')),
  model TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  error_code TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS tenant_extension_generations_quota ON tenant_extension_generations(tenant_id,created_at);
ALTER TABLE tenant_extensions ADD COLUMN IF NOT EXISTS custom_metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(custom_metadata)='object' AND octet_length(custom_metadata::text)<=8192);
ALTER TABLE tenant_extension_versions ADD COLUMN IF NOT EXISTS runtime_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS tenant_extension_code_runs (
 run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
 extension_id UUID NOT NULL,version INTEGER NOT NULL,actor_id UUID NOT NULL REFERENCES platform_users(platform_user_id),
 status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),error_code TEXT,duration_ms INTEGER,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),completed_at TIMESTAMPTZ,
 FOREIGN KEY(tenant_id,extension_id,version) REFERENCES tenant_extension_versions(tenant_id,extension_id,version)
);
CREATE INDEX IF NOT EXISTS tenant_extension_code_runs_recent ON tenant_extension_code_runs(tenant_id,created_at DESC);
CREATE TABLE IF NOT EXISTS studio_intent_runs (
 run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
 actor_id UUID NOT NULL REFERENCES platform_users(platform_user_id),extension_id UUID NOT NULL,version INTEGER NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','succeeded','failed')),
 FOREIGN KEY(tenant_id,extension_id,version) REFERENCES tenant_extension_versions(tenant_id,extension_id,version)
);
CREATE INDEX IF NOT EXISTS studio_intent_runs_budget ON studio_intent_runs(tenant_id,created_at DESC);
`;
