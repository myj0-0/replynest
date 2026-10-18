import type {Pool,PoolClient} from 'pg';
import {schemaFingerprint,type DatabaseComponent} from './database-runtime.js';
import {automaticSemanticKnowledgeSchema} from './automatic-knowledge-semantic-store.js';
import {automaticSemanticVerificationSchema} from './automatic-knowledge-verification.js';

export const AUTOMATIC_SEMANTIC_COMPONENT='automatic_knowledge_semantic';
const tables=['automatic_reception_retrievals','automatic_reception_verifications'] as const;
const functions=['protect_automatic_retrieval','protect_automatic_verification'] as const;
export const automaticSemanticSchemaSql=()=>automaticSemanticKnowledgeSchema+'\n'+automaticSemanticVerificationSchema;
/** Runtime startup may verify this component, NEVER install it with a runtime credential. */
export function automaticSemanticDatabaseComponent():DatabaseComponent{
 return {name:AUTOMATIC_SEMANTIC_COMPONENT,sql:automaticSemanticSchemaSql(),migrate:async()=>{throw Error('semantic_owner_migration_required');}};
}
type Receipt={component:string;sql_sha256:string};
export type SemanticMigrationPlan={ownerRole:string;migratorRole:string;runtimeRole:string;database:string;
 before:Receipt[];sqlSha256:string;aclSha256:string;executionClosed:boolean};
const identifier=(s:unknown):s is string=>typeof s==='string'&&/^[a-z][a-z0-9_]{0,62}$/.test(s);
const stable=(rows:Receipt[])=>JSON.stringify([...rows].sort((a,b)=>a.component.localeCompare(b.component)));
/** Exact journal grants override broad historical default privileges. No definer functions. */
export function automaticSemanticRuntimeAcl(runtime:string){
 if(!identifier(runtime))throw Error('invalid_semantic_runtime_role');
 return tables.map(t=>`REVOKE ALL ON TABLE public.${t} FROM PUBLIC, "${runtime}";
 GRANT SELECT,INSERT,UPDATE ON TABLE public.${t} TO "${runtime}";`).join('\n')+'\n'+
 functions.map(f=>`REVOKE ALL ON FUNCTION public.${f}() FROM PUBLIC, "${runtime}";
 GRANT EXECUTE ON FUNCTION public.${f}() TO "${runtime}";`).join('\n');
}
function validate(p:SemanticMigrationPlan){
 if(!p||![p.ownerRole,p.migratorRole,p.runtimeRole,p.database].every(identifier)||
  new Set([p.ownerRole,p.migratorRole,p.runtimeRole]).size!==3||p.executionClosed!==true||
  p.sqlSha256!==schemaFingerprint(automaticSemanticSchemaSql())||p.aclSha256!==schemaFingerprint(automaticSemanticRuntimeAcl(p.runtimeRole)))
  throw Error('frozen_semantic_migration_plan_required');
 if(!Array.isArray(p.before)||!p.before.length||p.before.length>32||new Set(p.before.map(r=>r.component)).size!==p.before.length||
  p.before.some(r=>!r||Object.keys(r).sort().join(',')!=='component,sql_sha256'||!identifier(r.component)||
   !/^[a-f0-9]{64}$/.test(r.sql_sha256)||r.component===AUTOMATIC_SEMANTIC_COMPONENT))throw Error('exact_semantic_previous_receipts_required');
 return [...p.before,{component:AUTOMATIC_SEMANTIC_COMPONENT,sql_sha256:p.sqlSha256}];
}
async function checkAcl(c:PoolClient,p:SemanticMigrationPlan){
 const roles=(await c.query(`SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
  EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS memberships,
  has_schema_privilege(r.oid,'public','CREATE') AS schema_create,
  has_database_privilege(r.oid,current_database(),'CREATE') AS database_create,
  (EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relowner=r.oid)
   OR EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='public' AND f.proowner=r.oid)
   OR EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typowner=r.oid)) AS owns_objects
  FROM pg_roles r WHERE rolname=$1`,[p.runtimeRole])).rows;
 if(roles.length!==1||Object.entries(roles[0]).some(([k,v])=>k!=='rolname'&&v!==false))throw Error('semantic_runtime_role_not_restricted');
 const rows=(await c.query(`SELECT t.relname,pg_get_userbyid(t.relowner) AS owner,t.relkind,
  has_table_privilege($1,t.oid,'SELECT') AS r,has_table_privilege($1,t.oid,'INSERT') AS i,
  has_table_privilege($1,t.oid,'UPDATE') AS u,has_table_privilege($1,t.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER') AS destructive,
  EXISTS(SELECT 1 FROM aclexplode(coalesce(t.relacl,acldefault('r',t.relowner))) a WHERE a.grantee=0) AS public_access
  FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname=ANY($2::text[])`,[p.runtimeRole,tables])).rows;
 if(rows.length!==2||rows.some(r=>r.owner!==p.ownerRole||r.relkind!=='r'||!r.r||!r.i||!r.u||r.destructive||r.public_access))throw Error('semantic_journal_acl_mismatch');
 const guards=(await c.query(`SELECT pg_get_userbyid(f.proowner) AS owner,f.prosecdef,
  has_function_privilege($1,f.oid,'EXECUTE') AS runtime_execute,
  EXISTS(SELECT 1 FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
  FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='public' AND f.proname=ANY($2::text[])`,[p.runtimeRole,functions])).rows;
 if(guards.length!==2||guards.some(f=>f.owner!==p.ownerRole||f.prosecdef||!f.runtime_execute||f.public_execute))throw Error('semantic_guard_acl_mismatch');
}
/** One bounded owner transaction binds DDL + minimal ACL + read-only runtime receipt.
 * Fixed SQL only; no seed/provider calls, feature changes, audit rewrites or data removal.
 * The caller must independently establish closed execution and freeze this plan in its release.
 */
export async function migrateAutomaticSemanticComponent(db:Pick<Pool,'connect'>,p:SemanticMigrationPlan){
 const after=validate(p),c=await db.connect();let locked=false;
 try{
  await c.query("SET statement_timeout='30s'; SET lock_timeout='3s'");
  const identity=(await c.query(`SELECT current_user,session_user,current_database() AS database,
   EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) AS elevated`)).rows[0];
  if(identity?.current_user!==p.ownerRole||identity.session_user!==p.migratorRole||identity.database!==p.database||identity.elevated!==false)throw Error('semantic_owner_identity_mismatch');
  locked=(await c.query('SELECT pg_try_advisory_lock(714201,17) AS locked')).rows[0]?.locked===true;
  if(!locked)throw Error('other_migration_in_progress');
  await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(714201,3)');
  const receipt=(await c.query(`SELECT t.relkind,pg_get_userbyid(t.relowner) AS owner,
   has_table_privilege($1,t.oid,'SELECT') AS can_read,
   has_table_privilege($1,t.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS can_write
   FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname='replynest_schema_receipts'`,[p.runtimeRole])).rows[0];
  if(receipt?.relkind!=='r'||receipt.owner!==p.ownerRole||receipt.can_read!==true||receipt.can_write!==false)throw Error('semantic_protected_receipt_required');
  await c.query('LOCK TABLE public.replynest_schema_receipts IN SHARE ROW EXCLUSIVE MODE');
  const previous=(await c.query('SELECT component,sql_sha256 FROM public.replynest_schema_receipts ORDER BY component')).rows as Receipt[];
  const repeated=stable(previous)===stable(after);
  if(!repeated&&stable(previous)!==stable(p.before))throw Error('semantic_previous_receipt_conflict');
  // Refuse adoption of unexpected orphan tables: a prior failed atomic migration cannot leave them.
  if(!repeated&&(await c.query(`SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
   WHERE n.nspname='public' AND t.relname=ANY($1::text[])`,[tables])).rowCount)throw Error('semantic_unreceipted_schema_requires_review');
  if(!repeated){
   await c.query(automaticSemanticSchemaSql());await c.query(automaticSemanticRuntimeAcl(p.runtimeRole));
  }
  await checkAcl(c,p);
  if(!repeated)await c.query(`INSERT INTO public.replynest_schema_receipts(component,sql_sha256) VALUES($1,$2)`,[AUTOMATIC_SEMANTIC_COMPONENT,p.sqlSha256]);
  const actual=(await c.query('SELECT component,sql_sha256 FROM public.replynest_schema_receipts ORDER BY component')).rows as Receipt[];
  if(stable(actual)!==stable(after))throw Error('semantic_post_migration_receipt_mismatch');
  await c.query('COMMIT');
  return {component:AUTOMATIC_SEMANTIC_COMPONENT,repeated,atomicDdlAclReceipt:true,executionEnabled:false};
 }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}
 finally{if(locked)await c.query('SELECT pg_advisory_unlock(714201,17)').catch(()=>{});c.release();}
}
