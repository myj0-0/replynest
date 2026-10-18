import type {Pool,PoolClient} from 'pg';
import {automaticReceptionSchema} from './automatic-reception-store.js';
import {automaticEvidenceSchema} from './automatic-reception-evidence-store.js';
import {automaticManagementSchema} from './automatic-reception-management.js';
import {automaticGenerationSchema} from './automatic-reception-generation.js';
import {automaticQueueSchema} from './automatic-reception-queue.js';

const schemas=[automaticReceptionSchema,automaticEvidenceSchema,automaticManagementSchema,automaticGenerationSchema,automaticQueueSchema];
export function automaticReceptionSchemaSql(): string {return schemas.join('\n');}

/** Called AFTER the base migration; default-off performs no database operations.
 * All experimental DDL is one transaction, serialized across gateway instances. */
export async function migrateAutomaticReception(db:Pick<Pool,'connect'>,enabled=false){
 if(!enabled)return;
 let c:PoolClient|undefined;try{
  c=await db.connect();
  await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='3s'");
  await c.query('SELECT pg_advisory_xact_lock(714201,3)');
  for(const schema of schemas)await c.query(schema);
  await c.query('COMMIT');
 }catch{if(c)await c.query('ROLLBACK').catch(()=>{});throw Error('automatic_reception_migration_failed');}finally{c?.release();}
}
