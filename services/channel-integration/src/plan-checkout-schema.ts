// Kept separate so the exact production constraints can be exercised in isolated tests.
export const planCheckoutSchema = `
CREATE TABLE IF NOT EXISTS plan_payment_purchases (
  payment_order_id UUID PRIMARY KEY REFERENCES payment_orders(payment_order_id),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  plan_version_id UUID NOT NULL REFERENCES plan_catalog_versions(plan_version_id),
  plan_code TEXT NOT NULL CHECK(plan_code IN ('starter','professional')),
  plan_name TEXT NOT NULL,
  entitlement_snapshot JSONB NOT NULL,
  amount_minor BIGINT NOT NULL CHECK(amount_minor>0),
  currency TEXT NOT NULL CHECK(currency='CNY'),
  payment_mode TEXT NOT NULL CHECK(payment_mode IN ('live','sandbox')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','fulfilled','review')),
  review_reason TEXT,
  subscription_id UUID REFERENCES tenant_subscriptions(subscription_id),
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '15 minutes',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fulfilled_at TIMESTAMPTZ,
  CHECK((status='fulfilled')=(fulfilled_at IS NOT NULL)),
  CHECK(status<>'fulfilled' OR (subscription_id IS NOT NULL AND period_end>period_start))
);
ALTER TABLE plan_payment_purchases ADD COLUMN IF NOT EXISTS billing_period TEXT NOT NULL DEFAULT 'monthly' CHECK(billing_period IN ('monthly','annual'));
ALTER TABLE plan_payment_purchases ADD COLUMN IF NOT EXISTS refund_policy_version INTEGER CHECK(refund_policy_version=1);
CREATE INDEX IF NOT EXISTS plan_purchases_pending_idx ON plan_payment_purchases(created_at) WHERE status='pending';
CREATE INDEX IF NOT EXISTS plan_purchases_tenant_idx ON plan_payment_purchases(tenant_id,created_at DESC);
CREATE OR REPLACE FUNCTION protect_plan_purchase() RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'plan purchase is immutable'; END IF;
  IF (to_jsonb(NEW)-'status'-'review_reason'-'subscription_id'-'period_start'-'period_end'-'fulfilled_at') <>
     (to_jsonb(OLD)-'status'-'review_reason'-'subscription_id'-'period_start'-'period_end'-'fulfilled_at')
     THEN RAISE EXCEPTION 'plan purchase facts are immutable'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS plan_purchase_immutable ON plan_payment_purchases;
CREATE TRIGGER plan_purchase_immutable BEFORE UPDATE OR DELETE ON plan_payment_purchases FOR EACH ROW EXECUTE FUNCTION protect_plan_purchase();
`;
