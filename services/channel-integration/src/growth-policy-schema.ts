import {defaultGrowthPolicy} from './growth-policy-core.js';
export const growthPolicySchema=`
CREATE TABLE IF NOT EXISTS growth_policy_versions(version INTEGER PRIMARY KEY, rules JSONB NOT NULL, reason TEXT NOT NULL, created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp());
INSERT INTO growth_policy_versions(version,rules,reason,created_by) VALUES(1,'${JSON.stringify(defaultGrowthPolicy)}','Initial configurable growth policy','system.seed') ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION protect_growth_policy() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'growth policy history is immutable'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_policy_immutable ON growth_policy_versions;
CREATE TRIGGER growth_policy_immutable BEFORE UPDATE OR DELETE ON growth_policy_versions FOR EACH ROW EXECUTE FUNCTION protect_growth_policy();
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS growth_policy_version INTEGER REFERENCES growth_policy_versions(version);
CREATE TABLE IF NOT EXISTS plan_commissions(
 commission_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), purchase_id UUID UNIQUE NOT NULL REFERENCES wallet_purchases(purchase_id),
 referral_id UUID NOT NULL REFERENCES referrals(referral_id), inviter_tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id), invitee_tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
 policy_version INTEGER NOT NULL REFERENCES growth_policy_versions(version), cash_minor BIGINT NOT NULL CHECK(cash_minor>0), rate_bps INTEGER NOT NULL CHECK(rate_bps BETWEEN 0 AND 10000),
 amount_minor BIGINT NOT NULL CHECK(amount_minor>=0), payment_kind TEXT NOT NULL CHECK(payment_kind IN ('first','repeat')),
 matures_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','review','posted','rejected')),
 retained_minor BIGINT, reversal_minor BIGINT NOT NULL DEFAULT 0, ledger_transaction_id UUID REFERENCES ledger_transactions(transaction_id), review_note TEXT, reviewed_by TEXT);
CREATE INDEX IF NOT EXISTS plan_commission_maturity ON plan_commissions(matures_at) WHERE status='pending';
CREATE OR REPLACE FUNCTION protect_plan_commission() RETURNS trigger AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'commission history cannot be deleted'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','retained_minor','reversal_minor','ledger_transaction_id','review_note','reviewed_by'])<>(to_jsonb(OLD)-ARRAY['status','retained_minor','reversal_minor','ledger_transaction_id','review_note','reviewed_by']) THEN RAISE EXCEPTION 'commission facts are immutable';END IF;RETURN NEW;END;$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS plan_commission_immutable ON plan_commissions;
CREATE TRIGGER plan_commission_immutable BEFORE UPDATE OR DELETE ON plan_commissions FOR EACH ROW EXECUTE FUNCTION protect_plan_commission();
`;
