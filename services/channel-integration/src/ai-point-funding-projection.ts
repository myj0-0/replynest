// Preserve the AIC ledger lot semantics; this is not a second spendable wallet.
export const aiPointFundingProjectionSchema=`
CREATE TABLE IF NOT EXISTS ai_point_funding_lots(
 tenant_id TEXT NOT NULL,entry_id UUID NOT NULL,transaction_id UUID NOT NULL,
 remaining_minor BIGINT NOT NULL CHECK(remaining_minor>=0),expires_at TIMESTAMPTZ,
 posted_at TIMESTAMPTZ NOT NULL,PRIMARY KEY(tenant_id,entry_id)
);
CREATE INDEX IF NOT EXISTS ai_point_funding_active_idx ON ai_point_funding_lots(tenant_id,expires_at,posted_at,transaction_id,entry_id) WHERE remaining_minor>0;
CREATE INDEX IF NOT EXISTS ai_point_funding_original_idx ON ai_point_funding_lots(tenant_id,transaction_id,entry_id);
CREATE TABLE IF NOT EXISTS ai_point_refund_usage(
 tenant_id TEXT NOT NULL,entry_id UUID NOT NULL,held_micros BIGINT NOT NULL DEFAULT 0 CHECK(held_micros>=0),PRIMARY KEY(tenant_id,entry_id)
);
CREATE TABLE IF NOT EXISTS ai_point_funding_version(version INT PRIMARY KEY CHECK(version=1),rebuilt_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

CREATE OR REPLACE FUNCTION apply_ai_point_funding(t ledger_transactions) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE e RECORD;lot RECORD;part JSONB;remaining BIGINT;debit BIGINT;explicit_parts JSONB;
BEGIN
 IF t.status<>'posted' OR t.currency<>'AIC' THEN RETURN; END IF;
 FOR e IN SELECT * FROM ledger_entries WHERE tenant_id=t.tenant_id AND transaction_id=t.transaction_id
  AND account='ai_credit' AND currency='AIC' ORDER BY entry_id LOOP
  remaining:=e.amount_minor;
  IF t.reversal_of IS NOT NULL THEN
   IF e.direction<>'debit' THEN RAISE EXCEPTION 'gift_ledger_requires_review';END IF;
   FOR lot IN SELECT * FROM ai_point_funding_lots WHERE tenant_id=t.tenant_id AND transaction_id=t.reversal_of ORDER BY entry_id FOR UPDATE LOOP
    debit:=LEAST(remaining,lot.remaining_minor);
    UPDATE ai_point_funding_lots SET remaining_minor=remaining_minor-debit WHERE tenant_id=t.tenant_id AND entry_id=lot.entry_id;
    remaining:=remaining-debit;
   END LOOP;
   IF remaining<>0 THEN RAISE EXCEPTION 'gift_ledger_requires_review';END IF;
  ELSIF e.direction='credit' THEN
   INSERT INTO ai_point_funding_lots(tenant_id,entry_id,transaction_id,remaining_minor,expires_at,posted_at)
    VALUES(t.tenant_id,e.entry_id,t.transaction_id,e.amount_minor,e.expires_at,t.posted_at);
  ELSE
   explicit_parts:=t.metadata->'gift_allocations';
   IF jsonb_typeof(explicit_parts)='array' THEN
    FOR part IN SELECT value FROM jsonb_array_elements(explicit_parts) LOOP
     IF jsonb_typeof(part->'amount_minor')<>'number' OR (part->>'amount_minor')::numeric<>trunc((part->>'amount_minor')::numeric)
       OR (part->>'amount_minor')::numeric NOT BETWEEN 0 AND 9007199254740991 THEN RAISE EXCEPTION 'gift_ledger_requires_review';END IF;
     debit:=(part->>'amount_minor')::bigint;
     IF debit IS NULL OR debit>remaining THEN RAISE EXCEPTION 'gift_ledger_requires_review';END IF;
     UPDATE ai_point_funding_lots SET remaining_minor=remaining_minor-debit
      WHERE tenant_id=t.tenant_id AND entry_id=(part->>'entry_id')::uuid AND remaining_minor>=debit;
     IF NOT FOUND THEN RAISE EXCEPTION 'gift_ledger_requires_review';END IF;
     remaining:=remaining-debit;
    END LOOP;
   ELSIF explicit_parts IS NULL OR explicit_parts IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb) THEN
    FOR lot IN SELECT * FROM ai_point_funding_lots WHERE tenant_id=t.tenant_id AND remaining_minor>0
     AND (expires_at IS NULL OR expires_at>t.posted_at)
     ORDER BY expires_at NULLS LAST,posted_at,transaction_id,entry_id FOR UPDATE LOOP
     debit:=LEAST(remaining,lot.remaining_minor);
     UPDATE ai_point_funding_lots SET remaining_minor=remaining_minor-debit WHERE tenant_id=t.tenant_id AND entry_id=lot.entry_id;
     remaining:=remaining-debit;EXIT WHEN remaining=0;
    END LOOP;
   END IF;
   IF remaining<>0 THEN RAISE EXCEPTION 'gift_ledger_requires_review';END IF;
  END IF;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION sync_ai_point_funding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='posted' AND OLD.status<>'posted' THEN PERFORM apply_ai_point_funding(NEW);END IF;RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ai_point_funding_projection ON ledger_transactions;
CREATE TRIGGER ai_point_funding_projection AFTER UPDATE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION sync_ai_point_funding();

CREATE OR REPLACE FUNCTION sync_ai_point_refund_usage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE delta BIGINT;
BEGIN
 delta:=CASE WHEN NEW.status IN ('requested','approved') THEN NEW.point_micros ELSE 0 END;
 IF TG_OP='UPDATE' THEN delta:=delta-CASE WHEN OLD.status IN ('requested','approved') THEN OLD.point_micros ELSE 0 END;END IF;
 INSERT INTO ai_point_refund_usage(tenant_id,entry_id) VALUES(NEW.tenant_id,NEW.entry_id) ON CONFLICT DO NOTHING;
 UPDATE ai_point_refund_usage SET held_micros=held_micros+delta WHERE tenant_id=NEW.tenant_id AND entry_id=NEW.entry_id;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ai_point_refund_projection ON ai_point_refunds;
CREATE TRIGGER ai_point_refund_projection AFTER INSERT OR UPDATE ON ai_point_refunds FOR EACH ROW EXECUTE FUNCTION sync_ai_point_refund_usage();

CREATE OR REPLACE FUNCTION rebuild_ai_point_funding_projection() RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE t ledger_transactions;
BEGIN
 LOCK TABLE ledger_transactions IN SHARE ROW EXCLUSIVE MODE;
 LOCK TABLE ai_point_refunds IN SHARE ROW EXCLUSIVE MODE;
 DELETE FROM ai_point_funding_lots;DELETE FROM ai_point_refund_usage;
 FOR t IN SELECT * FROM ledger_transactions WHERE status='posted' AND currency='AIC' ORDER BY posted_at,transaction_id LOOP
  PERFORM apply_ai_point_funding(t);
 END LOOP;
 INSERT INTO ai_point_refund_usage(tenant_id,entry_id,held_micros)
 SELECT tenant_id,entry_id,SUM(point_micros)::bigint FROM ai_point_refunds WHERE status IN ('requested','approved') GROUP BY tenant_id,entry_id;
 INSERT INTO ai_point_funding_version(version) VALUES(1) ON CONFLICT(version) DO UPDATE SET rebuilt_at=NOW();
END $$;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM ai_point_funding_version WHERE version=1) THEN
 PERFORM rebuild_ai_point_funding_projection();END IF;END $$;
`;
