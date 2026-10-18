/** Reviewed owner-only install for history, presentation and durable timing.
 * No feature switch, model/native/provider call, tenant consent or seed writes.
 * Startup still only verifies the individual expanded component receipts. */
import type {Pool,PoolClient} from 'pg';
import {schemaFingerprint} from './database-runtime.js';
import {receptionPersonalizationDatabaseComponent,receptionPersonalizationRuntimeAcl} from './reception-personalization-component.js';
import {historyKnowledgeDatabaseComponent} from './reception-history-knowledge-component.js';
import {historyKnowledgeRuntimeAcl} from './reception-history-knowledge.js';
import {automaticPresentationDatabaseComponent} from './reception-automatic-presentation-component.js';
import {automaticPresentationRuntimeAcl} from './reception-automatic-presentation.js';
import {automaticReplyWaitDatabaseComponent} from './automatic-reply-wait-component.js';
import {automaticReplyWaitRuntimeAcl} from './automatic-reply-wait-store.js';

type Receipt={component:string;sql_sha256:string};
export type ReceptionPersonalizationMigrationPlan={ownerRole:string;migratorRole:string;runtimeRole:string;database:string;
 before:Receipt[];target:Receipt[];aclSha256:string;executionClosed:boolean};
const identifier=(s:unknown):s is string=>typeof s==='string'&&/^[a-z][a-z0-9_]{0,62}$/.test(s);
const exact=(v:object,keys:string[])=>Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const stable=(v:Receipt[])=>JSON.stringify([...v].sort((a,b)=>a.component.localeCompare(b.component)));
export function receptionPersonalizationReleaseComponents(){return [receptionPersonalizationDatabaseComponent(),historyKnowledgeDatabaseComponent(),
 automaticPresentationDatabaseComponent(),automaticReplyWaitDatabaseComponent()];}
export function receptionPersonalizationReleaseAcl(runtime:string){
 if(!identifier(runtime))throw Error('invalid_reception_release_runtime_role');
 return [receptionPersonalizationRuntimeAcl(runtime),historyKnowledgeRuntimeAcl(runtime),
  automaticPresentationRuntimeAcl(runtime),automaticReplyWaitRuntimeAcl(runtime)].join('\n');
}
const tableUpdates:Record<string,true|readonly string[]|false>={
 reception_personalization_settings:true,reception_history_grants:true,reception_personalization_rate:true,reception_learned_styles:true,
 reception_personalization_audit:false,reception_history_knowledge_jobs:true,automatic_reception_presentations:false,
 automatic_reply_waits:['state','dispatch_token','claimed_at','finished_at','reason']};
const tables=Object.keys(tableUpdates),components=receptionPersonalizationReleaseComponents();
const combinedSql=components.map(c=>c.sql).join('\n');
// Fixed source-derived catalog manifest, not SQL or object names supplied by a caller.
const functions=[...combinedSql.matchAll(/CREATE FUNCTION (\w+)\(\) RETURNS trigger AS \$\$([\s\S]*?)\$\$ LANGUAGE plpgsql;/g)].map(m=>({name:m[1],body:m[2]}));
const triggers=[...combinedSql.matchAll(/CREATE TRIGGER (\w+)[\s\S]*? ON (\w+)[\s\S]*?EXECUTE FUNCTION (\w+)\(\);/g)].map(m=>{
 const events=m[0].split(' ON ')[0],columns=events.match(/UPDATE OF (\w+)/)?.[1];
 return {name:m[1],table:m[2],fn:m[3],type:2+(/FOR EACH ROW/.test(m[0])?1:0)+(/\bINSERT\b/.test(events)?4:0)+
  (/\bDELETE\b/.test(events)?8:0)+(/\bUPDATE\b/.test(events)?16:0)+(/\bTRUNCATE\b/.test(events)?32:0),
  columns:columns?[columns]:[],condition:m[0].match(/WHEN\(([\s\S]*?)\)\s*EXECUTE FUNCTION/)?.[1]??null};
});
// Only the fixed schemas' simple AND predicate is compared here; not a general
// SQL normalizer. Catalog type/columns/namespace are independently checked.
const conditionKey=(s:string|null)=>s===null?null:s.toLowerCase().replace(/::text/g,'').replace(/[()\s]/g,'');
const indexes=[...combinedSql.matchAll(/CREATE (?:UNIQUE )?INDEX (\w+) ON/g)].map(m=>m[1]);
function validate(p:ReceptionPersonalizationMigrationPlan){
 const receipt=(r:Receipt)=>r&&exact(r,['component','sql_sha256'])&&identifier(r.component)&&typeof r.sql_sha256==='string'&&/^[a-f0-9]{64}$/.test(r.sql_sha256);
 if(!p||!exact(p,['ownerRole','migratorRole','runtimeRole','database','before','target','aclSha256','executionClosed'])||
  ![p.ownerRole,p.migratorRole,p.runtimeRole,p.database].every(identifier)||new Set([p.ownerRole,p.migratorRole,p.runtimeRole]).size!==3||
  p.executionClosed!==true||p.aclSha256!==schemaFingerprint(receptionPersonalizationReleaseAcl(p.runtimeRole)))throw Error('frozen_reception_release_plan_required');
 const target=components.map(c=>({component:c.name,sql_sha256:schemaFingerprint(c.sql)}));
 if(!Array.isArray(p.before)||!p.before.length||p.before.length>32||p.before.some(r=>!receipt(r))||new Set(p.before.map(r=>r.component)).size!==p.before.length||
  p.before.some(r=>target.some(t=>t.component===r.component))||!['business','automatic_reception','automatic_knowledge_semantic'].every(n=>p.before.some(r=>r.component===n))||
  !Array.isArray(p.target)||p.target.length!==target.length||p.target.some(r=>!receipt(r))||stable(p.target)!==stable(target))throw Error('exact_reception_release_receipts_required');
 return [...p.before,...target];
}
async function checkAcl(c:PoolClient,p:ReceptionPersonalizationMigrationPlan){
 const role=(await c.query(`SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
  EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) memberships,
  has_schema_privilege(r.oid,'public','CREATE') schema_create,has_database_privilege(r.oid,current_database(),'CREATE') database_create,
  (EXISTS(SELECT 1 FROM pg_class x JOIN pg_namespace n ON n.oid=x.relnamespace WHERE n.nspname='public' AND x.relowner=r.oid)
   OR EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='public' AND f.proowner=r.oid)
   OR EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typowner=r.oid)) owns_objects
  FROM pg_roles r WHERE rolname=$1`,[p.runtimeRole])).rows[0];
 if(!role||Object.values(role).some(v=>v!==false))throw Error('reception_release_runtime_not_restricted');
 const rows=(await c.query(`SELECT t.relname,t.relkind,pg_get_userbyid(t.relowner) owner,
  has_table_privilege($1,t.oid,'SELECT') r,has_table_privilege($1,t.oid,'INSERT') i,has_table_privilege($1,t.oid,'UPDATE') u,
  has_table_privilege($1,t.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER') destructive,
  EXISTS(SELECT 1 FROM aclexplode(coalesce(t.relacl,acldefault('r',t.relowner))) a WHERE a.grantee NOT IN(t.relowner,(SELECT oid FROM pg_roles WHERE rolname=$1))) extra_grantee
  FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname=ANY($2::text[])`,[p.runtimeRole,tables])).rows;
 if(rows.length!==tables.length||rows.some(r=>r.owner!==p.ownerRole||r.relkind!=='r'||!r.r||!r.i||r.destructive||r.extra_grantee||
  r.u!==(tableUpdates[r.relname]===true)))throw Error('reception_release_table_acl_mismatch');
 const columns=(await c.query(`SELECT t.relname,a.attname,has_column_privilege($1,t.oid,a.attnum,'UPDATE') u,
  EXISTS(SELECT 1 FROM aclexplode(a.attacl) x WHERE x.grantee NOT IN(t.relowner,(SELECT oid FROM pg_roles WHERE rolname=$1))) extra_grantee
  FROM pg_attribute a JOIN pg_class t ON t.oid=a.attrelid JOIN pg_namespace n ON n.oid=t.relnamespace
  WHERE n.nspname='public' AND t.relname=ANY($2::text[]) AND a.attnum>0 AND NOT a.attisdropped`,[p.runtimeRole,tables])).rows;
 if(columns.some(r=>{const allowed=tableUpdates[r.relname];return r.extra_grantee||r.u!==(allowed===true||Array.isArray(allowed)&&allowed.includes(r.attname));}))
  throw Error('reception_release_column_acl_mismatch');
 const guards=(await c.query(`SELECT f.proname,f.prosrc,f.prosecdef,f.proconfig,f.pronargs,f.prorettype='trigger'::regtype returns_trigger,
  pg_get_userbyid(f.proowner) owner,l.lanname,has_function_privilege($1,f.oid,'EXECUTE') runtime_execute,
  EXISTS(SELECT 1 FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a WHERE a.grantee NOT IN(f.proowner,(SELECT oid FROM pg_roles WHERE rolname=$1))) extra_grantee
  FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace JOIN pg_language l ON l.oid=f.prolang
  WHERE n.nspname='public' AND f.proname=ANY($2::text[])`,[p.runtimeRole,functions.map(f=>f.name)])).rows;
 if(guards.length!==functions.length||guards.some(f=>f.owner!==p.ownerRole||f.prosecdef||f.proconfig!==null||f.pronargs!==0||!f.returns_trigger||f.lanname!=='plpgsql'||
  !f.runtime_execute||f.extra_grantee||f.prosrc!==functions.find(x=>x.name===f.proname)?.body))throw Error('reception_release_guard_mismatch');
 const tg=(await c.query(`SELECT g.tgname,t.relname,f.proname,g.tgenabled,g.tgtype,g.tgnargs,fn.nspname function_schema,
  pg_get_triggerdef(g.oid) definition,
  coalesce((SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=t.oid AND a.attnum=ANY(g.tgattr::smallint[])),ARRAY[]::text[]) columns
  FROM pg_trigger g JOIN pg_class t ON t.oid=g.tgrelid JOIN pg_namespace n ON n.oid=t.relnamespace
  JOIN pg_proc f ON f.oid=g.tgfoid JOIN pg_namespace fn ON fn.oid=f.pronamespace
  WHERE n.nspname='public' AND g.tgname=ANY($1::text[])`,[triggers.map(t=>t.name)])).rows;
 if(tg.length!==triggers.length||triggers.some(t=>!tg.some(g=>g.tgname===t.name&&g.relname===t.table&&g.proname===t.fn&&g.tgenabled==='O'&&
  g.tgtype===t.type&&g.tgnargs===0&&g.function_schema==='public'&&JSON.stringify(g.columns)===JSON.stringify(t.columns)&&
  conditionKey(g.definition.match(/ WHEN \(([\s\S]*?)\) EXECUTE FUNCTION/)?.[1]??null)===conditionKey(t.condition))))
  throw Error('reception_release_trigger_mismatch');
 const ix=(await c.query(`SELECT c.relname,i.indisvalid,i.indisready FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_index i ON i.indexrelid=c.oid WHERE n.nspname='public' AND c.relname=ANY($1::text[])`,[indexes])).rows;
 if(ix.length!==indexes.length||ix.some(i=>!i.indisvalid||!i.indisready))throw Error('reception_release_index_mismatch');
}
/** Caller must separately freeze and observe closed execution in its release.
 * This plan flag is NOT a live configuration observation or tenant authorization. */
export async function migrateReceptionPersonalizationRelease(db:Pick<Pool,'connect'>,requested:ReceptionPersonalizationMigrationPlan){
 const after=validate(requested),p={...requested,before:requested.before.map(r=>({...r})),target:requested.target.map(r=>({...r}))};
 const c=await db.connect();let locked=false;
 try{
  await c.query("SET statement_timeout='30s'; SET lock_timeout='3s'");
  const identity=(await c.query(`SELECT current_user,session_user,current_database() database,
   EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) elevated,
   EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) elevated_owner`)).rows[0];
  if(identity?.current_user!==p.ownerRole||identity.session_user!==p.migratorRole||identity.database!==p.database||identity.elevated!==false||identity.elevated_owner!==false)
   throw Error('reception_release_owner_identity_mismatch');
  locked=(await c.query('SELECT pg_try_advisory_lock(714201,17) locked')).rows[0]?.locked===true;
  if(!locked)throw Error('other_migration_in_progress');
  await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(714201,3)');
  const receipt=(await c.query(`SELECT t.relkind,pg_get_userbyid(t.relowner) owner,
   has_table_privilege($1,t.oid,'SELECT') can_read,has_table_privilege($1,t.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') can_write,
   has_any_column_privilege($1,t.oid,'INSERT,UPDATE,REFERENCES') column_write,
   EXISTS(SELECT 1 FROM aclexplode(coalesce(t.relacl,acldefault('r',t.relowner))) a WHERE a.grantee=0) public_access
   FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname='replynest_schema_receipts'`,[p.runtimeRole])).rows[0];
  if(receipt?.relkind!=='r'||receipt.owner!==p.ownerRole||receipt.can_read!==true||receipt.can_write!==false||receipt.column_write!==false||receipt.public_access!==false)
   throw Error('reception_release_protected_receipt_required');
  await c.query('LOCK TABLE public.replynest_schema_receipts IN SHARE ROW EXCLUSIVE MODE');
  const previous=(await c.query('SELECT component,sql_sha256 FROM public.replynest_schema_receipts ORDER BY component')).rows as Receipt[];
  const repeated=stable(previous)===stable(after);
  if(!repeated&&stable(previous)!==stable(p.before))throw Error('reception_release_previous_receipt_conflict');
  if(!repeated){
   const orphan=(await c.query(`SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname=ANY($1::text[])
    UNION ALL SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='public' AND f.proname=ANY($2::text[])`,
    [[...tables,...indexes],functions.map(f=>f.name)])).rowCount;
   if(orphan)throw Error('reception_release_unreceipted_schema_requires_review');
   for(const component of components)await c.query(component.sql);
   await c.query(receptionPersonalizationReleaseAcl(p.runtimeRole));
  }
  await checkAcl(c,p);
  if(!repeated)for(const row of p.target)await c.query('INSERT INTO public.replynest_schema_receipts(component,sql_sha256) VALUES($1,$2)',[row.component,row.sql_sha256]);
  const actual=(await c.query('SELECT component,sql_sha256 FROM public.replynest_schema_receipts ORDER BY component')).rows as Receipt[];
  if(stable(actual)!==stable(after))throw Error('reception_release_post_receipt_mismatch');
  await c.query('COMMIT');return {components:p.target.map(r=>r.component),repeated,atomicDdlAclReceipt:true,executionEnabled:false};
 }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}
 finally{if(locked)await c.query('SELECT pg_advisory_unlock(714201,17)').catch(()=>{});
  await c.query('RESET statement_timeout; RESET lock_timeout').catch(()=>{});c.release();}
}
