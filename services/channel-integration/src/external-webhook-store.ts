import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {DatabaseComponent} from './database-runtime.js';

// Separate owned component: do not change the shared business schema fingerprint
// of deployed knowledge/status images. Runtime startup only verifies its receipt.
export const externalWebhookLeaseSchema=`
ALTER TABLE external_app_events ADD COLUMN IF NOT EXISTS lease_token UUID;
ALTER TABLE external_app_events ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS external_app_events_leased_pending
 ON external_app_events(lease_until) WHERE status='pending' AND lease_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS external_app_events_due_order
 ON external_app_events(next_attempt_at,created_at,event_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS external_app_events_app_due
 ON external_app_events(tenant_id,app_id,next_attempt_at,created_at,event_id) WHERE status='pending';
`;
export function externalWebhookLeaseComponent():DatabaseComponent{
 return {name:'external_webhook_leases',sql:externalWebhookLeaseSchema,
  migrate:async()=>{throw Error('external_webhook_owner_migration_required');}};
}
type Database=Pick<Pool,'connect'|'query'>;
export type ExternalWebhookClaim={tenant:string;app:string;event:string;lease:string;attempts:number;
 payload:unknown;urlCipher:string;secretCipher:string};
const activeApp=`a.revoked_at IS NULL AND a.expires_at>NOW() AND t.status IN ('active','test')`;

/** App → event lock order matches revocation. No caller may hold this connection
 * through network I/O. Increment on claim so process crashes are also bounded. */
export async function claimExternalWebhook(db:Database):Promise<ExternalWebhookClaim|'terminal'|null>{
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  await c.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'");
  const app=(await c.query(`SELECT a.* FROM external_app_events e JOIN external_apps a USING(tenant_id,app_id)
   JOIN tenants t USING(tenant_id)
   WHERE ${activeApp} AND a.webhook_url_cipher IS NOT NULL AND a.webhook_secret_cipher IS NOT NULL
    AND e.status='pending' AND e.next_attempt_at<=NOW() AND (e.lease_until IS NULL OR e.lease_until<=NOW())
   ORDER BY e.next_attempt_at,e.created_at,e.event_id LIMIT 1 FOR UPDATE OF a SKIP LOCKED`)).rows[0];
  if(!app){await c.query('COMMIT');return null;}
  const event=(await c.query(`SELECT * FROM external_app_events WHERE tenant_id=$1 AND app_id=$2
   AND status='pending' AND next_attempt_at<=NOW() AND (lease_until IS NULL OR lease_until<=NOW())
   ORDER BY next_attempt_at,created_at,event_id LIMIT 1 FOR UPDATE SKIP LOCKED`,[app.tenant_id,app.app_id])).rows[0];
  if(!event){await c.query('COMMIT');return null;}
  if(event.attempts>=8){
   await c.query(`UPDATE external_app_events SET status='failed',lease_token=NULL,lease_until=NULL
    WHERE tenant_id=$1 AND app_id=$2 AND event_id=$3`,[app.tenant_id,app.app_id,event.event_id]);
   await c.query('COMMIT');return 'terminal';
  }
  const lease=randomUUID();
  // 60 seconds exceeds existing bounded DNS + HTTP transport budgets. Setting
  // next_attempt_at also prevents an old worker from claiming a live lease.
  await c.query(`UPDATE external_app_events SET attempts=attempts+1,lease_token=$4,
   lease_until=NOW()+INTERVAL '60 seconds',next_attempt_at=NOW()+INTERVAL '60 seconds'
   WHERE tenant_id=$1 AND app_id=$2 AND event_id=$3`,[app.tenant_id,app.app_id,event.event_id,lease]);
  await c.query('COMMIT');
  return {tenant:app.tenant_id,app:app.app_id,event:event.event_id,lease,attempts:event.attempts+1,
   payload:event.payload,urlCipher:app.webhook_url_cipher,secretCipher:app.webhook_secret_cipher};
 }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}
}

/** Recheck immediately before transport. Revocation after this point cannot
 * recall an already submitted HTTP request; consumers must deduplicate event ID. */
export async function externalWebhookClaimActive(db:Database,claim:ExternalWebhookClaim){
 return (await db.query(`SELECT 1 FROM external_app_events e JOIN external_apps a USING(tenant_id,app_id)
  JOIN tenants t USING(tenant_id) WHERE e.tenant_id=$1 AND e.app_id=$2 AND e.event_id=$3
   AND e.status='pending' AND e.lease_token=$4 AND e.lease_until>NOW() AND ${activeApp}`,
  [claim.tenant,claim.app,claim.event,claim.lease])).rowCount===1;
}

/** Fenced result write. An expired/replaced lease or revoked event cannot be
 * revived by a late success. Completion always takes app then event locks. */
export async function finishExternalWebhook(db:Database,claim:ExternalWebhookClaim,succeeded:boolean){
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  await c.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'");
  const app=(await c.query(`SELECT (${activeApp}) AS active FROM external_apps a JOIN tenants t USING(tenant_id)
   WHERE a.tenant_id=$1 AND a.app_id=$2 FOR UPDATE OF a`,[claim.tenant,claim.app])).rows[0];
  const status=app?.active?(succeeded?'delivered':claim.attempts>=8?'failed':'pending'):'cancelled';
  const result=await c.query(`UPDATE external_app_events SET status=$5,lease_token=NULL,lease_until=NULL,
   next_attempt_at=NOW()+($6*INTERVAL '1 second') WHERE tenant_id=$1 AND app_id=$2 AND event_id=$3
    AND status='pending' AND lease_token=$4 AND lease_until>NOW()`,
   [claim.tenant,claim.app,claim.event,claim.lease,status,Math.min(3600,30*2**(claim.attempts-1))]);
  await c.query('COMMIT');return result.rowCount===1;
 }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}
}
