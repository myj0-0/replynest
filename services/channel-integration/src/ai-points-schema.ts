import {aiPointsProjectionSchema} from './ai-points-projection.js';
import {aiPointFundingProjectionSchema} from './ai-point-funding-projection.js';
export const aiPointsSchema=`
CREATE TABLE IF NOT EXISTS ai_usage_calls(
 call_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
 request_key TEXT NOT NULL,feature TEXT NOT NULL CHECK(feature IN ('copilot','studio','embedding_query','embedding_document')),
 model TEXT NOT NULL,price_snapshot JSONB NOT NULL,period_start TIMESTAMPTZ NOT NULL,
 status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','succeeded','failed','abandoned')),
 reserved_micros BIGINT NOT NULL CHECK(reserved_micros>=0),monthly_reserved_micros BIGINT NOT NULL CHECK(monthly_reserved_micros>=0),
 credit_allocations JSONB NOT NULL DEFAULT '[]',monthly_charged_micros BIGINT NOT NULL DEFAULT 0 CHECK(monthly_charged_micros>=0),
 charged_micros BIGINT NOT NULL DEFAULT 0 CHECK(charged_micros>=0),cost_nano_cny BIGINT CHECK(cost_nano_cny>=0),
 input_tokens BIGINT,output_tokens BIGINT,cached_input_tokens BIGINT,error_code TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),completed_at TIMESTAMPTZ,
 UNIQUE(tenant_id,request_key),CHECK(monthly_reserved_micros<=reserved_micros),CHECK(charged_micros<=reserved_micros),
 CHECK(monthly_charged_micros<=charged_micros)
);
CREATE INDEX IF NOT EXISTS ai_usage_calls_tenant_period ON ai_usage_calls(tenant_id,period_start,status);
CREATE TABLE IF NOT EXISTS ai_point_pack_versions(
 pack_version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),version INTEGER NOT NULL UNIQUE,
 points BIGINT NOT NULL CHECK(points>0 AND points<=10000000),price_minor BIGINT NOT NULL CHECK(price_minor>0),
 status TEXT NOT NULL CHECK(status IN ('active','retired')),created_by TEXT NOT NULL,reason TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_point_pack_one_active ON ai_point_pack_versions(status) WHERE status='active';
INSERT INTO ai_point_pack_versions(version,points,price_minor,status,created_by,reason)
 SELECT 1,10000,1500,'active','system','Initial 10000-point pack; estimated model budget CNY 10' WHERE NOT EXISTS(SELECT 1 FROM ai_point_pack_versions);
CREATE TABLE IF NOT EXISTS ai_point_pack_purchases(
 purchase_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
 idempotency_key TEXT NOT NULL,pack_version_id UUID NOT NULL REFERENCES ai_point_pack_versions(pack_version_id),
 points BIGINT NOT NULL CHECK(points>0),amount_minor BIGINT NOT NULL CHECK(amount_minor>0),gift_minor BIGINT NOT NULL CHECK(gift_minor>=0),cash_minor BIGINT NOT NULL CHECK(cash_minor>=0),
 created_by TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(tenant_id,idempotency_key),CHECK(gift_minor+cash_minor=amount_minor)
);
CREATE OR REPLACE FUNCTION protect_ai_usage_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status<>'reserved' THEN RAISE EXCEPTION 'ai_usage_immutable'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','monthly_charged_micros','charged_micros','cost_nano_cny','input_tokens','output_tokens','cached_input_tokens','error_code','completed_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','monthly_charged_micros','charged_micros','cost_nano_cny','input_tokens','output_tokens','cached_input_tokens','error_code','completed_at']) THEN RAISE EXCEPTION 'ai_usage_facts_immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ai_usage_terminal_guard ON ai_usage_calls;
CREATE TRIGGER ai_usage_terminal_guard BEFORE UPDATE OR DELETE ON ai_usage_calls FOR EACH ROW EXECUTE FUNCTION protect_ai_usage_terminal();
ALTER TABLE ai_point_pack_purchases ADD COLUMN IF NOT EXISTS gift_allocations JSONB NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS ai_point_refunds(
 request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
 purchase_id UUID NOT NULL REFERENCES ai_point_pack_purchases(purchase_id),entry_id UUID NOT NULL REFERENCES ledger_entries(entry_id),
 point_micros BIGINT NOT NULL CHECK(point_micros>0),amount_minor BIGINT NOT NULL CHECK(amount_minor>0),
 fee_minor BIGINT NOT NULL CHECK(fee_minor>=0),net_minor BIGINT NOT NULL CHECK(net_minor>0),
 cash_minor BIGINT NOT NULL CHECK(cash_minor>=0),gift_minor BIGINT NOT NULL CHECK(gift_minor>=0),
 status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','rejected')),
 reason TEXT NOT NULL,created_by TEXT NOT NULL,reviewed_by TEXT,review_note TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK(net_minor+fee_minor=amount_minor),CHECK(cash_minor+gift_minor=net_minor)
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_point_refund_active ON ai_point_refunds(purchase_id) WHERE status IN ('requested','approved');
CREATE OR REPLACE FUNCTION protect_ai_pack_facts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ai_pack_immutable'; END IF;
 IF TG_TABLE_NAME='ai_point_pack_purchases' THEN RAISE EXCEPTION 'ai_pack_immutable'; END IF;
 IF TG_TABLE_NAME='ai_point_pack_versions' AND (OLD.status<>'active' OR NEW.status<>'retired' OR (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status')) THEN RAISE EXCEPTION 'ai_pack_immutable'; END IF;
 IF TG_TABLE_NAME='ai_point_refunds' AND (OLD.status<>'requested' OR NEW.status NOT IN ('approved','rejected') OR (to_jsonb(NEW)-ARRAY['status','reviewed_by','review_note','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','reviewed_by','review_note','updated_at'])) THEN RAISE EXCEPTION 'ai_refund_immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ai_pack_purchase_guard ON ai_point_pack_purchases;
CREATE TRIGGER ai_pack_purchase_guard BEFORE UPDATE OR DELETE ON ai_point_pack_purchases FOR EACH ROW EXECUTE FUNCTION protect_ai_pack_facts();
DROP TRIGGER IF EXISTS ai_pack_version_guard ON ai_point_pack_versions;
CREATE TRIGGER ai_pack_version_guard BEFORE UPDATE OR DELETE ON ai_point_pack_versions FOR EACH ROW EXECUTE FUNCTION protect_ai_pack_facts();
DROP TRIGGER IF EXISTS ai_pack_refund_guard ON ai_point_refunds;
CREATE TRIGGER ai_pack_refund_guard BEFORE UPDATE OR DELETE ON ai_point_refunds FOR EACH ROW EXECUTE FUNCTION protect_ai_pack_facts();
${aiPointsProjectionSchema}
${aiPointFundingProjectionSchema}
`;
