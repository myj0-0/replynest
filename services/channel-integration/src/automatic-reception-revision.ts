import type {PoolClient} from 'pg';
type Db=Pick<PoolClient,'query'>;

/** Local-only migration. Install transactionally after all three source tables exist.
 * BEFORE row triggers serialize ALL source writes, including nonmatching/new rows.
 * Readers must not take source-row locks after this guard: writers may already own
 * source rows while waiting for the revision row, which would invert lock order.
 */
export const automaticRevisionSchema=`
 CREATE TABLE IF NOT EXISTS automatic_reception_revisions(
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(tenant_id),revision BIGINT NOT NULL DEFAULT 0 CHECK(revision>=0)
 );
 CREATE OR REPLACE FUNCTION protect_automatic_revision() RETURNS trigger AS $$
 BEGIN
  IF TG_OP='DELETE' OR TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'automatic revision history is immutable'; END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.revision<>OLD.revision+1 THEN
   RAISE EXCEPTION 'automatic revision must advance exactly once';
  END IF;
  RETURN NEW;
 END; $$ LANGUAGE plpgsql;
 DROP TRIGGER IF EXISTS automatic_revision_guard ON automatic_reception_revisions;
 CREATE TRIGGER automatic_revision_guard BEFORE UPDATE OR DELETE ON automatic_reception_revisions
  FOR EACH ROW EXECUTE FUNCTION protect_automatic_revision();
 DROP TRIGGER IF EXISTS automatic_revision_truncate_guard ON automatic_reception_revisions;
 CREATE TRIGGER automatic_revision_truncate_guard BEFORE TRUNCATE ON automatic_reception_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION protect_automatic_revision();
 CREATE OR REPLACE FUNCTION guard_automatic_evidence_write() RETURNS trigger AS $$
 DECLARE owner_id TEXT;
 BEGIN
  IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'automatic evidence truncate is forbidden'; END IF;
  IF TG_OP='UPDATE' AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
   RAISE EXCEPTION 'automatic evidence owner is immutable';
  END IF;
  IF TG_OP='DELETE' THEN owner_id:=OLD.tenant_id; ELSE owner_id:=NEW.tenant_id; END IF;
  IF owner_id IS NULL OR length(owner_id)=0 THEN RAISE EXCEPTION 'automatic evidence owner required'; END IF;
  INSERT INTO automatic_reception_revisions(tenant_id,revision) VALUES(owner_id,1)
   ON CONFLICT(tenant_id) DO UPDATE SET revision=automatic_reception_revisions.revision+1;
  IF TG_TABLE_NAME IN('automatic_reception_answers','knowledge_chunks') AND TG_OP<>'DELETE' THEN
   IF NOT EXISTS(SELECT 1 FROM knowledge_documents WHERE document_id=NEW.document_id AND tenant_id=owner_id)
    THEN RAISE EXCEPTION 'automatic answer source owner mismatch'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
 END; $$ LANGUAGE plpgsql;
 ${['knowledge_documents','temporary_policies','automatic_reception_answers'].map(table=>`
 DROP TRIGGER IF EXISTS automatic_evidence_write_guard ON ${table};
 CREATE TRIGGER automatic_evidence_write_guard BEFORE INSERT OR UPDATE OR DELETE ON ${table}
  FOR EACH ROW EXECUTE FUNCTION guard_automatic_evidence_write();
 DROP TRIGGER IF EXISTS automatic_evidence_truncate_guard ON ${table};
 CREATE TRIGGER automatic_evidence_truncate_guard BEFORE TRUNCATE ON ${table}
  FOR EACH STATEMENT EXECUTE FUNCTION guard_automatic_evidence_write();`).join('')}
`;

/** Caller owns a READ COMMITTED transaction when lock=true, until the submit barrier.
 * A diagnostic unlocked read is NOT an authorization snapshot.
 */
export async function automaticEvidenceRevision(db:Db,tenantId:string,lock:boolean):Promise<string>{
 if(typeof tenantId!=='string'||!tenantId.trim()||tenantId.length>200)throw Error('invalid_automatic_evidence_tenant');
 if(lock){
  // PostgreSQL rejects SAVEPOINT outside an explicit transaction; otherwise a
  // FOR SHARE issued in autocommit would silently release the guard too early.
  await db.query('SAVEPOINT automatic_evidence_transaction_guard; RELEASE SAVEPOINT automatic_evidence_transaction_guard');
  const isolation=await db.query("SELECT current_setting('transaction_isolation') isolation");
  if(isolation.rows[0]?.isolation!=='read committed')throw Error('automatic_evidence_requires_read_committed');
 }
 await db.query('INSERT INTO automatic_reception_revisions(tenant_id,revision) VALUES($1,0) ON CONFLICT(tenant_id) DO NOTHING',[tenantId]);
 const row=await db.query(`SELECT revision::text revision FROM automatic_reception_revisions WHERE tenant_id=$1 ${lock?'FOR SHARE':''}`,[tenantId]);
 const revision=row.rows[0]?.revision;
 if(typeof revision!=='string'||!/^\d{1,19}$/.test(revision))throw Error('automatic_evidence_revision_unavailable');
 return revision; // Keep BIGINT as text, never lose precision through a JS number.
}
