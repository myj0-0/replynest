import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {AUTOMATIC_REPLY_CONSENT_VERSION} from './automatic-reply-policy.js';

type Db=Pick<PoolClient,'query'>;
/** Static SQL, never accepts a client-selected identifier. Require BOTH persisted mode
 * and independent public-send consent, including during generation/final submission. */
export const automaticModeGuard=`s.ai_auto_reply_enabled AND s.automatic_sending_enabled
 AND s.automation_consent_version='${AUTOMATIC_REPLY_CONSENT_VERSION}'`;

/** Caller owns transaction and authentication. Share the management lock order:
 * advisory -> grant -> settings. Legacy installations need not have experimental tables. */
export async function revokeAutomaticGrantForMode(c:Db,tenant:string,actor:string){
 await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`automatic-management:${tenant}`]);
 const installed=(await c.query("SELECT to_regclass('automatic_reception_grants') IS NOT NULL installed")).rows[0]?.installed;
 if(!installed)return null;
 const old=(await c.query('SELECT authorization_id,enabled FROM automatic_reception_grants WHERE tenant_id=$1 FOR UPDATE',[tenant])).rows[0];
 if(!old?.enabled)return null;
 const id=randomUUID();
 await c.query(`UPDATE automatic_reception_grants SET enabled=false,authorization_id=$2,actor_id=$3,updated_at=clock_timestamp() WHERE tenant_id=$1`,[tenant,id,actor]);
 return {previous_authorization_id:old.authorization_id,authorization_id:id};
}

/** Independent, explicitly confirmed sending grant selects automatic mode in the
 * SAME transaction. Revoking it returns to manual; does not silently authorize drafts. */
export async function writeAutomaticReceptionMode(c:Db,tenant:string,actor:string,enabled:boolean){
 return (await c.query(`INSERT INTO tenant_ai_settings
  (tenant_id,updated_by,automatic_sending_enabled,ai_auto_reply_enabled,automation_updated_by,automation_updated_at,automation_consent_version)
  VALUES($1,$2::text,$3,$3,$2::uuid,clock_timestamp(),$4)
  ON CONFLICT(tenant_id) DO UPDATE SET automatic_sending_enabled=EXCLUDED.automatic_sending_enabled,
   ai_auto_reply_enabled=EXCLUDED.ai_auto_reply_enabled,automation_updated_by=EXCLUDED.automation_updated_by,
   automation_updated_at=EXCLUDED.automation_updated_at,automation_consent_version=EXCLUDED.automation_consent_version,
   updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()
  RETURNING automatic_sending_enabled,ai_auto_reply_enabled,automation_consent_version`,
 [tenant,actor,enabled,enabled?AUTOMATIC_REPLY_CONSENT_VERSION:null])).rows[0];
}
