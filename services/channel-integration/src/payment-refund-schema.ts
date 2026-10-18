export const paymentRefundSchema=`
CREATE TABLE IF NOT EXISTS payment_refund_requests (
  refund_request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_order_id UUID NOT NULL UNIQUE REFERENCES payment_orders(payment_order_id),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  amount_minor BIGINT NOT NULL CHECK(amount_minor>0),
  request_number TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL CHECK(char_length(reason) BETWEEN 10 AND 256),
  requested_by UUID NOT NULL,
  approved_by UUID,
  status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','processing','retry','succeeded','review','rejected')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error_code TEXT,
  receipt_time TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE payment_refund_requests ADD COLUMN IF NOT EXISTS policy_quote JSONB;
DO $$ DECLARE rule RECORD; BEGIN
  FOR rule IN SELECT conname FROM pg_constraint WHERE conrelid='payment_refund_requests'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%approved_by%requested_by%'
  LOOP EXECUTE format('ALTER TABLE payment_refund_requests DROP CONSTRAINT %I',rule.conname); END LOOP;
END $$;
CREATE OR REPLACE FUNCTION protect_payment_refund_facts() RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'refund history is immutable'; END IF;
  IF (to_jsonb(NEW)-'approved_by'-'status'-'attempt_count'-'available_at'-'last_error_code'-'receipt_time'-'completed_at'-'updated_at') <>
     (to_jsonb(OLD)-'approved_by'-'status'-'attempt_count'-'available_at'-'last_error_code'-'receipt_time'-'completed_at'-'updated_at')
     THEN RAISE EXCEPTION 'refund facts are immutable'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS payment_refund_facts ON payment_refund_requests;
CREATE TRIGGER payment_refund_facts BEFORE UPDATE OR DELETE ON payment_refund_requests FOR EACH ROW EXECUTE FUNCTION protect_payment_refund_facts();
`;
