/** One-off owner job. Never import gateway/worker or attach owner credentials
 * to a long-running service. Role transfer/grants are a separate release step. */
import {pool,seedBusinessLayer} from './database.js';
import {databaseComponents} from './database-components.js';
import {schemaFingerprint} from './database-runtime.js';

async function main(){
 if(process.env.DATABASE_MIGRATION_ACK!=='owner-only')throw Error('explicit_owner_migration_ack_required');
 const runtime=process.env.DATABASE_RUNTIME_ROLE;
 if(!runtime||!/^[a-z][a-z0-9_]{0,62}$/.test(runtime))throw Error('database_runtime_role_required');
 if(!['true','false'].includes(process.env.DATABASE_MIGRATION_SEED??'false'))throw Error('invalid_database_migration_seed');
 const c=await pool.connect();
 try{
  const found=(await c.query('SELECT rolname FROM pg_roles WHERE rolname=$1 AND rolname<>current_user',[runtime])).rows[0];
  if(!found)throw Error('separate_runtime_role_required');
  await c.query("SET statement_timeout='120s'; SET lock_timeout='3s'");
  await c.query('SELECT pg_advisory_lock(714201,17)');
  const components=databaseComponents(process.env);
  // Semantic journals require the scoped atomic DDL/ACL/receipt release step,
  // not broad startup/seed migration or historical default table grants.
  if(components.some(c=>c.name==='automatic_knowledge_semantic'))throw Error('scoped_semantic_owner_migration_required');
  // DDL uses the locked, bounded owner connection, not an unbounded pool query.
  await c.query('BEGIN');
  for(const component of components)await c.query(component.sql);
  await c.query('COMMIT');
  if(process.env.DATABASE_MIGRATION_SEED==='true')await seedBusinessLayer();
  await c.query('BEGIN');
  await c.query(`CREATE TABLE IF NOT EXISTS public.replynest_schema_receipts(
    component text PRIMARY KEY,sql_sha256 text NOT NULL CHECK(sql_sha256~'^[0-9a-f]{64}$'),migrated_at timestamptz NOT NULL DEFAULT now());
    REVOKE ALL ON public.replynest_schema_receipts FROM PUBLIC;`);
  // Identifier is strictly validated above; never interpolate secrets.
  await c.query(`REVOKE ALL ON public.replynest_schema_receipts FROM "${runtime}"; GRANT SELECT ON public.replynest_schema_receipts TO "${runtime}"`);
  for(const component of components)await c.query(`INSERT INTO public.replynest_schema_receipts(component,sql_sha256) VALUES($1,$2)
    ON CONFLICT(component) DO UPDATE SET sql_sha256=EXCLUDED.sql_sha256,migrated_at=now()`,[component.name,schemaFingerprint(component.sql)]);
  await c.query('COMMIT');
  console.info(JSON.stringify({event:'owner_database_migration_completed',components:components.map(s=>s.name),seeded:process.env.DATABASE_MIGRATION_SEED==='true'}));
 }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}
 finally{await c.query('SELECT pg_advisory_unlock(714201,17)').catch(()=>{});c.release();}
}
try{await main();}catch{console.error('owner_database_migration_failed');process.exitCode=1;}finally{await pool.end();}
