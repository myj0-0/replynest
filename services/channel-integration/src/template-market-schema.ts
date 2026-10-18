export const templateMarketSchema = `
CREATE TABLE IF NOT EXISTS template_market_policy (
 id INTEGER PRIMARY KEY CHECK(id=1), fee_bps INTEGER NOT NULL DEFAULT 200 CHECK(fee_bps BETWEEN 0 AND 10000),
 version INTEGER NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO template_market_policy(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS template_market_listings (
 listing_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), seller_tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
 created_by UUID NOT NULL REFERENCES platform_users(platform_user_id),
 title TEXT NOT NULL, summary TEXT NOT NULL, category TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('quick_replies','knowledge')), content JSONB NOT NULL CHECK(jsonb_typeof(content)='array'),
 price_minor INTEGER NOT NULL CHECK(price_minor BETWEEN 0 AND 9900), license_text TEXT NOT NULL, source_note TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','published','rejected','withdrawn')),
 reviewed_by UUID REFERENCES platform_admin_accounts(admin_id), review_note TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), reviewed_at TIMESTAMPTZ,
 CHECK(status='pending' OR reviewed_by IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS template_market_public_idx ON template_market_listings(created_at DESC,listing_id DESC) WHERE status='published';
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='template_market_listings'::regclass AND conname='template_market_listings_kind_check' AND pg_get_constraintdef(oid) LIKE '%studio%') THEN
  ALTER TABLE template_market_listings DROP CONSTRAINT IF EXISTS template_market_listings_kind_check;
  ALTER TABLE template_market_listings ADD CONSTRAINT template_market_listings_kind_check CHECK(kind IN ('quick_replies','knowledge','studio'));
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS template_market_kind_idx ON template_market_listings(kind,created_at DESC,listing_id DESC) WHERE status='published';
CREATE INDEX IF NOT EXISTS template_market_category_idx ON template_market_listings(category,created_at DESC,listing_id DESC) WHERE status='published';
CREATE INDEX IF NOT EXISTS template_market_review_idx ON template_market_listings(status,created_at,listing_id);
CREATE INDEX IF NOT EXISTS template_market_seller_idx ON template_market_listings(seller_tenant_id,created_at DESC,listing_id DESC);
CREATE TABLE IF NOT EXISTS template_market_orders (
 order_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), listing_id UUID NOT NULL REFERENCES template_market_listings(listing_id),
 buyer_tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id), seller_tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
 idempotency_key TEXT NOT NULL, created_by UUID NOT NULL REFERENCES platform_users(platform_user_id),
 amount_minor INTEGER NOT NULL CHECK(amount_minor BETWEEN 0 AND 9900), fee_bps INTEGER NOT NULL CHECK(fee_bps BETWEEN 0 AND 10000),
 fee_minor INTEGER NOT NULL CHECK(fee_minor>=0), seller_minor INTEGER NOT NULL CHECK(seller_minor>=0), policy_version INTEGER NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), available_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '7 days',
 CHECK(amount_minor=fee_minor+seller_minor),CHECK(buyer_tenant_id<>seller_tenant_id),
 UNIQUE(buyer_tenant_id,idempotency_key),UNIQUE(buyer_tenant_id,listing_id)
);
CREATE INDEX IF NOT EXISTS template_market_orders_seller_idx ON template_market_orders(seller_tenant_id,available_at,order_id);
CREATE TABLE IF NOT EXISTS template_market_refunds (
 order_id UUID PRIMARY KEY REFERENCES template_market_orders(order_id), reason TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','rejected')),
 requested_by UUID NOT NULL REFERENCES platform_users(platform_user_id),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 reviewed_by UUID REFERENCES platform_admin_accounts(admin_id),review_note TEXT,reviewed_at TIMESTAMPTZ,
 CHECK(status='requested' OR reviewed_by IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS template_market_refunds_queue_idx ON template_market_refunds(status,created_at,order_id);
CREATE TABLE IF NOT EXISTS template_market_payees (
 payee_id UUID PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),created_by UUID NOT NULL REFERENCES platform_users(platform_user_id),
 subject_type TEXT NOT NULL CHECK(subject_type IN ('business','individual')),sealed JSONB NOT NULL,
 masked_name TEXT NOT NULL,masked_account TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','rejected','superseded','revoked')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),reviewed_at TIMESTAMPTZ,reviewed_by UUID REFERENCES platform_admin_accounts(admin_id),review_note TEXT,
 CHECK(status NOT IN ('verified','rejected','revoked') OR reviewed_by IS NOT NULL),UNIQUE(tenant_id,payee_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS market_payee_current_idx ON template_market_payees(tenant_id) WHERE status IN ('pending','verified');
CREATE INDEX IF NOT EXISTS market_payee_queue_idx ON template_market_payees(status,created_at,payee_id);
CREATE INDEX IF NOT EXISTS market_payee_tenant_idx ON template_market_payees(tenant_id,created_at DESC,payee_id);
CREATE OR REPLACE FUNCTION protect_market_payee() RETURNS trigger AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'market payee facts are immutable'; END IF;
 IF (to_jsonb(NEW)-'status'-'reviewed_at'-'reviewed_by'-'review_note')<>(to_jsonb(OLD)-'status'-'reviewed_at'-'reviewed_by'-'review_note')
 OR NOT ((OLD.status='pending' AND NEW.status IN ('verified','rejected','superseded')) OR (OLD.status='verified' AND NEW.status IN ('revoked','superseded')))
 THEN RAISE EXCEPTION 'invalid payee transition'; END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS market_payee_facts ON template_market_payees;
CREATE TRIGGER market_payee_facts BEFORE UPDATE OR DELETE ON template_market_payees FOR EACH ROW EXECUTE FUNCTION protect_market_payee();
CREATE TABLE IF NOT EXISTS template_market_payouts (
 payout_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), seller_tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
 requested_by UUID NOT NULL REFERENCES platform_users(platform_user_id), idempotency_key TEXT NOT NULL,
 amount_minor INTEGER NOT NULL CHECK(amount_minor BETWEEN 1 AND 100000000),
 fee_bps INTEGER NOT NULL CHECK(fee_bps=100), fee_minor INTEGER NOT NULL CHECK(fee_minor>=0),
 net_minor INTEGER NOT NULL CHECK(net_minor>0), CHECK(amount_minor=fee_minor+net_minor),
 status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','paid','rejected')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 reviewed_by UUID REFERENCES platform_admin_accounts(admin_id), review_note TEXT,
 payment_reference TEXT, UNIQUE(seller_tenant_id,idempotency_key),
 CHECK(status='requested' OR reviewed_by IS NOT NULL), CHECK(status<>'paid' OR (payment_reference IS NOT NULL AND length(payment_reference)>=5))
);
CREATE INDEX IF NOT EXISTS template_market_payout_seller_idx ON template_market_payouts(seller_tenant_id,status,created_at DESC,payout_id);
ALTER TABLE template_market_payouts ADD COLUMN IF NOT EXISTS payee_id UUID;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='market_payout_payee_tenant_fk') THEN
 ALTER TABLE template_market_payouts ADD CONSTRAINT market_payout_payee_tenant_fk FOREIGN KEY(seller_tenant_id,payee_id) REFERENCES template_market_payees(tenant_id,payee_id);
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS template_market_payout_queue_idx ON template_market_payouts(status,created_at,payout_id);
CREATE UNIQUE INDEX IF NOT EXISTS template_market_payout_receipt_idx ON template_market_payouts(payment_reference) WHERE status='paid';
ALTER TABLE template_market_payouts DROP CONSTRAINT IF EXISTS market_payout_paid_reference_required;
ALTER TABLE template_market_payouts ADD CONSTRAINT market_payout_paid_reference_required CHECK(status<>'paid' OR (payment_reference IS NOT NULL AND length(payment_reference)>=5));
CREATE OR REPLACE FUNCTION protect_template_market_payout() RETURNS trigger AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'market payout facts are immutable'; END IF;
 IF (to_jsonb(NEW)-'status'-'reviewed_by'-'review_note'-'updated_at'-'payment_reference')<>(to_jsonb(OLD)-'status'-'reviewed_by'-'review_note'-'updated_at'-'payment_reference')
 OR NOT ((OLD.status='requested' AND NEW.status IN ('approved','rejected')) OR (OLD.status='approved' AND NEW.status IN ('paid','rejected')))
 THEN RAISE EXCEPTION 'invalid market payout transition'; END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS template_market_payout_facts ON template_market_payouts;
CREATE TRIGGER template_market_payout_facts BEFORE UPDATE OR DELETE ON template_market_payouts FOR EACH ROW EXECUTE FUNCTION protect_template_market_payout();
CREATE TABLE IF NOT EXISTS template_market_imports (
 order_id UUID PRIMARY KEY REFERENCES template_market_orders(order_id),tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
 created_by UUID NOT NULL REFERENCES platform_users(platform_user_id),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 imported_ids JSONB NOT NULL,license_text TEXT NOT NULL,source_note TEXT NOT NULL
);
-- Seller proceeds deliberately never credit legacy cash: that cash can be refunded as a recharge.
-- Immutable sale/refund journal and dedicated payout facts form the separate seller liability balance.
CREATE TABLE IF NOT EXISTS template_market_journal (
 order_id UUID NOT NULL REFERENCES template_market_orders(order_id),
 event TEXT NOT NULL CHECK(event IN ('sale','refund')),
 amount_minor INTEGER NOT NULL CHECK(amount_minor>=0), seller_minor INTEGER NOT NULL CHECK(seller_minor>=0),fee_minor INTEGER NOT NULL CHECK(fee_minor>=0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(order_id,event),CHECK(amount_minor=seller_minor+fee_minor)
);
CREATE OR REPLACE FUNCTION protect_template_market_facts() RETURNS trigger AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'template market facts are immutable'; END IF;
 IF TG_TABLE_NAME IN ('template_market_orders','template_market_journal') THEN RAISE EXCEPTION 'template market facts are immutable'; END IF;
 IF TG_TABLE_NAME='template_market_listings' THEN
  IF (to_jsonb(NEW)-'status'-'reviewed_by'-'review_note'-'reviewed_at')<>(to_jsonb(OLD)-'status'-'reviewed_by'-'review_note'-'reviewed_at') THEN RAISE EXCEPTION 'submit a new immutable listing version'; END IF;
  IF NOT ((OLD.status='pending' AND NEW.status IN ('published','rejected')) OR (OLD.status='published' AND NEW.status='withdrawn')) THEN RAISE EXCEPTION 'invalid listing transition'; END IF;
 ELSE
  IF (to_jsonb(NEW)-'status'-'reviewed_by'-'review_note'-'reviewed_at')<>(to_jsonb(OLD)-'status'-'reviewed_by'-'review_note'-'reviewed_at') OR OLD.status<>'requested' OR NEW.status NOT IN ('approved','rejected') THEN RAISE EXCEPTION 'invalid refund transition'; END IF;
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS template_market_listing_facts ON template_market_listings;
CREATE TRIGGER template_market_listing_facts BEFORE UPDATE OR DELETE ON template_market_listings FOR EACH ROW EXECUTE FUNCTION protect_template_market_facts();
DROP TRIGGER IF EXISTS template_market_order_facts ON template_market_orders;
CREATE TRIGGER template_market_order_facts BEFORE UPDATE OR DELETE ON template_market_orders FOR EACH ROW EXECUTE FUNCTION protect_template_market_facts();
DROP TRIGGER IF EXISTS template_market_journal_facts ON template_market_journal;
CREATE TRIGGER template_market_journal_facts BEFORE UPDATE OR DELETE ON template_market_journal FOR EACH ROW EXECUTE FUNCTION protect_template_market_facts();
DROP TRIGGER IF EXISTS template_market_refund_facts ON template_market_refunds;
CREATE TRIGGER template_market_refund_facts BEFORE UPDATE OR DELETE ON template_market_refunds FOR EACH ROW EXECUTE FUNCTION protect_template_market_facts();
`;
