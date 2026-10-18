export const walletSchema=`
CREATE TABLE IF NOT EXISTS wallet_topups (
 payment_order_id UUID PRIMARY KEY REFERENCES payment_orders(payment_order_id),
 tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
 payment_mode TEXT NOT NULL CHECK(payment_mode='live'),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '15 minutes'
);
CREATE TABLE IF NOT EXISTS wallet_purchases (
 purchase_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
 idempotency_key TEXT NOT NULL,plan_version_id UUID NOT NULL REFERENCES plan_catalog_versions(plan_version_id),
 plan_name TEXT NOT NULL,billing_period TEXT NOT NULL CHECK(billing_period IN ('monthly','annual')),
 amount_minor BIGINT NOT NULL CHECK(amount_minor>0),gift_minor BIGINT NOT NULL CHECK(gift_minor>=0),cash_minor BIGINT NOT NULL CHECK(cash_minor>=0),
 gift_allocations JSONB NOT NULL,entitlement_snapshot JSONB NOT NULL,
 subscription_id UUID NOT NULL REFERENCES tenant_subscriptions(subscription_id),period_start TIMESTAMPTZ NOT NULL,period_end TIMESTAMPTZ NOT NULL,
 created_by TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),policy_version INTEGER NOT NULL DEFAULT 2 CHECK(policy_version=2),
 UNIQUE(tenant_id,idempotency_key),CHECK(amount_minor=gift_minor+cash_minor),CHECK(period_end>period_start)
);
CREATE TABLE IF NOT EXISTS wallet_requests (
 request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),idempotency_key TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('cash_refund','referral_withdrawal','plan_refund')),
 purchase_id UUID REFERENCES wallet_purchases(purchase_id),amount_minor BIGINT NOT NULL CHECK(amount_minor>0),
 fee_minor BIGINT NOT NULL CHECK(fee_minor>=0),net_minor BIGINT NOT NULL CHECK(net_minor>0),quote JSONB NOT NULL,
 reason TEXT NOT NULL,created_by TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','paid','rejected')),
 reviewed_by UUID,review_note TEXT,receipt_reference TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(tenant_id,idempotency_key),CHECK(net_minor<=amount_minor),CHECK((kind='plan_refund')=(purchase_id IS NOT NULL)),
 CHECK(status<>'paid' OR (reviewed_by IS NOT NULL AND receipt_reference IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS wallet_one_plan_refund ON wallet_requests(purchase_id) WHERE status<>'rejected' AND purchase_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wallet_receipt_unique ON wallet_requests(receipt_reference) WHERE kind<>'plan_refund' AND status='paid';
CREATE INDEX IF NOT EXISTS wallet_requests_tenant ON wallet_requests(tenant_id,created_at DESC);
CREATE OR REPLACE FUNCTION protect_wallet_facts() RETURNS trigger AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'wallet facts are immutable'; END IF;
 IF TG_TABLE_NAME<>'wallet_requests' THEN RAISE EXCEPTION 'wallet purchase and topup facts are immutable'; END IF;
 IF (to_jsonb(NEW)-'status'-'reviewed_by'-'review_note'-'receipt_reference'-'updated_at')<>(to_jsonb(OLD)-'status'-'reviewed_by'-'review_note'-'receipt_reference'-'updated_at') THEN RAISE EXCEPTION 'wallet request facts are immutable'; END IF;
 IF OLD.status IN ('paid','rejected') THEN RAISE EXCEPTION 'wallet terminal request is immutable'; END IF;
 IF NOT ((OLD.status='requested' AND NEW.status IN ('approved','rejected','paid')) OR (OLD.status='approved' AND NEW.status IN ('paid','rejected'))) THEN RAISE EXCEPTION 'invalid wallet transition'; END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS wallet_purchase_immutable ON wallet_purchases;
CREATE TRIGGER wallet_purchase_immutable BEFORE UPDATE OR DELETE ON wallet_purchases FOR EACH ROW EXECUTE FUNCTION protect_wallet_facts();
DROP TRIGGER IF EXISTS wallet_topup_immutable ON wallet_topups;
CREATE TRIGGER wallet_topup_immutable BEFORE UPDATE OR DELETE ON wallet_topups FOR EACH ROW EXECUTE FUNCTION protect_wallet_facts();
DROP TRIGGER IF EXISTS wallet_request_immutable ON wallet_requests;
CREATE TRIGGER wallet_request_immutable BEFORE UPDATE OR DELETE ON wallet_requests FOR EACH ROW EXECUTE FUNCTION protect_wallet_facts();
`;
