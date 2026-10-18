import type {Pool,PoolClient} from 'pg';
import {automaticWechatLookupSchema} from './automatic-wechat-target.js';
import {automaticWechatManagementSchema} from './automatic-wechat-management.js';
import {automaticWechatIntakeSchema} from './automatic-wechat-intake.js';
import {automaticWechatOutcomeSchema} from './automatic-wechat-outcome.js';
import {automaticWechatHistoryEnvelopeSchema} from './automatic-wechat-history-envelope.js';
import {automaticWechatHistoryWorkerSchema} from './automatic-wechat-history-worker.js';

const schemas=[automaticWechatLookupSchema,automaticWechatManagementSchema,automaticWechatIntakeSchema,automaticWechatOutcomeSchema,automaticWechatHistoryEnvelopeSchema,automaticWechatHistoryWorkerSchema];
/** Separate receipt from the frozen website component. Requires existing base,
 * automatic-reception, shared-store and shared-delivery schemas. Owner release
 * tooling only; startup in verify mode never calls this migration. */
export function automaticWechatSchemaSql(){return schemas.join('\n');}
export async function migrateAutomaticWeChat(db:Pick<Pool,'connect'>,enabled=false){
 if(!enabled)return;
 let c:PoolClient|undefined;
 try{
  c=await db.connect();await c.query('BEGIN');
  await c.query("SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='3s'");
  await c.query('SELECT pg_advisory_xact_lock(714201,3)');
  for(const schema of schemas)await c.query(schema);
  await c.query('COMMIT');
 }catch{if(c)await c.query('ROLLBACK').catch(()=>{});throw Error('automatic_wechat_migration_failed');}
 finally{c?.release();}
}
