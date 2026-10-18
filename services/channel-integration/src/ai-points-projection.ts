// Projections are disposable; ai_usage_calls remains the immutable audit source.
// Database triggers cover every writer, including expiry releases and old application images.
export const aiPointsProjectionSchema=`
CREATE TABLE IF NOT EXISTS ai_point_month_usage(
 tenant_id TEXT NOT NULL,period_start TIMESTAMPTZ NOT NULL,
 used_micros BIGINT NOT NULL DEFAULT 0 CHECK(used_micros>=0),PRIMARY KEY(tenant_id,period_start)
);
CREATE TABLE IF NOT EXISTS ai_point_lot_usage(
 tenant_id TEXT NOT NULL,entry_id UUID NOT NULL,
 used_micros BIGINT NOT NULL DEFAULT 0 CHECK(used_micros>=0),PRIMARY KEY(tenant_id,entry_id)
);
CREATE TABLE IF NOT EXISTS ai_point_projection_version(
 version INTEGER PRIMARY KEY CHECK(version=1),rebuilt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ai_usage_reserved_expiry_idx ON ai_usage_calls(tenant_id,created_at) WHERE status='reserved';

CREATE OR REPLACE FUNCTION ai_point_call_lots(parts JSONB,total BIGINT)
RETURNS TABLE(entry_id UUID,used_micros BIGINT) LANGUAGE SQL IMMUTABLE AS $$
 SELECT (part->>'entry_id')::uuid,
  LEAST((part->>'amount_minor')::bigint,GREATEST(0,total-COALESCE(
   SUM((part->>'amount_minor')::bigint) OVER(ORDER BY ord ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)))::bigint
 FROM jsonb_array_elements(parts) WITH ORDINALITY AS p(part,ord)
$$;

CREATE OR REPLACE FUNCTION apply_ai_point_usage(r ai_usage_calls,signum BIGINT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE monthly BIGINT;credit BIGINT;part RECORD;
BEGIN
 monthly:=CASE WHEN r.status='reserved' THEN r.monthly_reserved_micros ELSE r.monthly_charged_micros END;
 IF monthly<>0 THEN
  INSERT INTO ai_point_month_usage(tenant_id,period_start) VALUES(r.tenant_id,r.period_start) ON CONFLICT DO NOTHING;
  UPDATE ai_point_month_usage SET used_micros=used_micros+signum*monthly WHERE tenant_id=r.tenant_id AND period_start=r.period_start;
 END IF;
 IF r.status NOT IN ('reserved','succeeded') THEN RETURN; END IF;
 credit:=CASE WHEN r.status='reserved' THEN r.reserved_micros-r.monthly_reserved_micros ELSE r.charged_micros-r.monthly_charged_micros END;
 FOR part IN SELECT entry_id,SUM(used_micros)::bigint used_micros FROM ai_point_call_lots(r.credit_allocations,credit)
  GROUP BY entry_id HAVING SUM(used_micros)>0 ORDER BY entry_id LOOP
  INSERT INTO ai_point_lot_usage(tenant_id,entry_id) VALUES(r.tenant_id,part.entry_id) ON CONFLICT DO NOTHING;
  UPDATE ai_point_lot_usage SET used_micros=used_micros+signum*part.used_micros WHERE tenant_id=r.tenant_id AND entry_id=part.entry_id;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION sync_ai_point_usage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN PERFORM apply_ai_point_usage(OLD,-1); END IF;
 PERFORM apply_ai_point_usage(NEW,1);RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ai_point_usage_projection ON ai_usage_calls;
CREATE TRIGGER ai_point_usage_projection AFTER INSERT OR UPDATE ON ai_usage_calls FOR EACH ROW EXECUTE FUNCTION sync_ai_point_usage();

-- Maintenance only. Source-table lock blocks usage writes for an atomic rebuild.
-- Reads retain the previous committed projection until the transaction commits.
CREATE OR REPLACE FUNCTION rebuild_ai_point_usage_projection() RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
 LOCK TABLE ai_usage_calls IN SHARE ROW EXCLUSIVE MODE;
 DELETE FROM ai_point_month_usage;
 DELETE FROM ai_point_lot_usage;
 INSERT INTO ai_point_month_usage(tenant_id,period_start,used_micros)
 SELECT tenant_id,period_start,SUM(CASE WHEN status='reserved' THEN monthly_reserved_micros ELSE monthly_charged_micros END)::bigint
 FROM ai_usage_calls GROUP BY tenant_id,period_start;
 INSERT INTO ai_point_lot_usage(tenant_id,entry_id,used_micros)
 SELECT c.tenant_id,p.entry_id,SUM(p.used_micros)::bigint FROM ai_usage_calls c
 CROSS JOIN LATERAL ai_point_call_lots(c.credit_allocations,
  CASE WHEN c.status='reserved' THEN c.reserved_micros-c.monthly_reserved_micros ELSE c.charged_micros-c.monthly_charged_micros END) p
 WHERE c.status IN ('reserved','succeeded') GROUP BY c.tenant_id,p.entry_id HAVING SUM(p.used_micros)>0;
 INSERT INTO ai_point_projection_version(version) VALUES(1)
 ON CONFLICT(version) DO UPDATE SET rebuilt_at=NOW();
END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM ai_point_projection_version WHERE version=1) THEN
  PERFORM rebuild_ai_point_usage_projection();
 END IF;
END $$;
`;
