import {createHash} from 'node:crypto';
import type {Pool} from 'pg';

export type DatabaseComponent={name:string;sql:string;migrate:()=>Promise<unknown>};
export const schemaFingerprint=(sql:string)=>createHash('sha256').update(sql).digest('hex');
export function databaseStartupMode(env:NodeJS.ProcessEnv):'legacy'|'verify'{
 const value=env.DATABASE_STARTUP_MODE??'legacy';
 if(value!=='legacy'&&value!=='verify')throw Error('invalid_database_startup_mode');
 return value;
}

/** No DDL, seed writes, or owner fallback. Receipts are written only by the
 * release migrator, and bind to expanded SQL (including imported sub-schemas).
 * This is a release freshness check, not a proof against all schema tampering. */
export async function verifyDatabaseRuntime(db:Pick<Pool,'connect'>,components:DatabaseComponent[]){
 const c=await db.connect();
 try{
  await c.query('BEGIN READ ONLY');
  await c.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='2s'");
  const role=(await c.query(`SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
    has_schema_privilege(current_user,'public','CREATE') AS schema_create,
    has_database_privilege(current_user,current_database(),'CREATE') AS database_create,
    EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS memberships,
    (EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relowner=r.oid)
     OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proowner=r.oid)
     OR EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typowner=r.oid)) AS owns_objects
    FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
  if(!role||Object.values(role).some(value=>value!==false))throw Error('database_runtime_role_not_restricted');
  const receipt=(await c.query(`SELECT t.relkind,
    has_table_privilege(current_user,t.oid,'SELECT') AS can_read,
    has_table_privilege(current_user,t.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS can_write
    FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' AND t.relname='replynest_schema_receipts'`)).rows[0];
  if(!receipt||receipt.relkind!=='r'||receipt.can_read!==true||receipt.can_write!==false)throw Error('database_schema_receipt_not_protected');
  const rows=(await c.query('SELECT component,sql_sha256 FROM public.replynest_schema_receipts WHERE component=ANY($1::text[])',[components.map(s=>s.name)])).rows;
  if(components.some(s=>!rows.some(r=>r.component===s.name&&r.sql_sha256===schemaFingerprint(s.sql))))throw Error('database_schema_receipt_mismatch');
  await c.query('COMMIT');
 }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}
}

export async function bootstrapDatabaseRuntime(db:Pick<Pool,'connect'>,components:DatabaseComponent[],env:NodeJS.ProcessEnv,legacySeed?:()=>Promise<unknown>){
 if(databaseStartupMode(env)==='verify')return verifyDatabaseRuntime(db,components);
 if(components.some(c=>c.name==='studio_workflows'))throw Error('studio_owner_migration_required');
 if(components.some(c=>c.name==='external_webhook_leases'))throw Error('external_webhook_owner_migration_required');
 if(components.some(c=>c.name==='automatic_knowledge_semantic'))throw Error('semantic_owner_migration_required');
 for(const component of components)await component.migrate();
 await legacySeed?.();
}
