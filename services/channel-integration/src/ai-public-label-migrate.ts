import type {Pool,PoolClient} from 'pg';
import {schemaFingerprint} from './database-runtime.js';
import {publicAiLabelDatabaseComponent,publicAiLabelRuntimeAcl} from './ai-public-label.js';
type Receipt={component:string;sql_sha256:string};
export type PublicAiLabelMigrationPlan={ownerRole:string;migratorRole:string;runtimeRole:string;database:string;
 before:Receipt[];target:Receipt;aclSha256:string;executionClosed:boolean};
const identifier=(s:unknown):s is string=>typeof s==='string'&&/^[a-z][a-z0-9_]{0,62}$/.test(s);
const stable=(v:Receipt[])=>JSON.stringify([...v].sort((a,b)=>a.component.localeCompare(b.component)));
const component=publicAiLabelDatabaseComponent();
const target={component:component.name,sql_sha256:schemaFingerprint(component.sql)};
async function verify(c:PoolClient,p:PublicAiLabelMigrationPlan){
 const runtime=(await c.query(`SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
  EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) memberships,
  has_schema_privilege(r.oid,'public','CREATE') schema_create,has_database_privilege(r.oid,current_database(),'CREATE') database_create,
  (EXISTS(SELECT 1 FROM pg_class x JOIN pg_namespace n ON n.oid=x.relnamespace WHERE n.nspname='public' AND x.relowner=r.oid)
   OR EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='public' AND f.proowner=r.oid)) owns_objects
  FROM pg_roles r WHERE rolname=$1`,[p.runtimeRole])).rows[0];
 if(!runtime||Object.values(runtime).some(v=>v!==false))throw Error('ai_public_label_runtime_not_restricted');
 const row=(await c.query(`SELECT t.relkind,pg_get_userbyid(t.relowner) owner,
  has_table_privilege($1,t.oid,'SELECT') r,has_table_privilege($1,t.oid,'INSERT') i,has_table_privilege($1,t.oid,'UPDATE') u,
  has_table_privilege($1,t.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER') destructive,
  EXISTS(SELECT 1 FROM aclexplode(coalesce(t.relacl,acldefault('r',t.relowner))) a
   WHERE a.grantee NOT IN(t.relowner,(SELECT oid FROM pg_roles WHERE rolname=$1))) extra
  FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname='ai_public_label_settings'`,[p.runtimeRole])).rows[0];
 if(!row||row.owner!==p.ownerRole||row.relkind!=='r'||!row.r||!row.i||!row.u||row.destructive||row.extra)throw Error('ai_public_label_acl_mismatch');
 const fn=(await c.query(`SELECT f.prosrc,f.prosecdef,f.proconfig,pg_get_userbyid(f.proowner) owner,f.pronargs,
  f.prorettype='trigger'::regtype trigger,l.lanname,has_function_privilege($1,f.oid,'EXECUTE') runtime_execute,
  EXISTS(SELECT 1 FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a
   WHERE a.grantee NOT IN(f.proowner,(SELECT oid FROM pg_roles WHERE rolname=$1))) extra
  FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace JOIN pg_language l ON l.oid=f.prolang
  WHERE n.nspname='public' AND f.proname='guard_ai_public_label_revision'`,[p.runtimeRole])).rows;
 const body=component.sql.match(/AS \$\$([\s\S]*?)\$\$ LANGUAGE plpgsql/)![1];
 if(fn.length!==1||fn[0].owner!==p.ownerRole||fn[0].prosrc!==body||fn[0].prosecdef||fn[0].proconfig||fn[0].pronargs!==0||
  !fn[0].trigger||fn[0].lanname!=='plpgsql'||!fn[0].runtime_execute||fn[0].extra)throw Error('ai_public_label_guard_mismatch');
 const trigger=(await c.query(`SELECT g.tgenabled,g.tgtype,g.tgnargs,f.proname,t.relname,
  g.tgqual IS NULL no_condition FROM pg_trigger g JOIN pg_class t ON t.oid=g.tgrelid
  JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_proc f ON f.oid=g.tgfoid
  WHERE n.nspname='public' AND g.tgname='ai_public_label_revision'`)).rows[0];
 if(!trigger||trigger.relname!=='ai_public_label_settings'||trigger.proname!=='guard_ai_public_label_revision'||
  trigger.tgenabled!=='O'||trigger.tgtype!==23||trigger.tgnargs!==0||!trigger.no_condition)throw Error('ai_public_label_trigger_mismatch');
}
/** Explicit, frozen owner migration only. Caller separately observes closed execution;
 * this plan is not a live switch observation. No grant/model/send or tenant seed writes. */
export async function migratePublicAiLabel(db:Pick<Pool,'connect'>,requested:PublicAiLabelMigrationPlan){
 if(!requested||Object.keys(requested).sort().join(',')!=='aclSha256,before,database,executionClosed,migratorRole,ownerRole,runtimeRole,target'||
  ![requested.ownerRole,requested.migratorRole,requested.runtimeRole,requested.database].every(identifier)||
  new Set([requested.ownerRole,requested.migratorRole,requested.runtimeRole]).size!==3||requested.executionClosed!==true||
  !requested.target||Object.keys(requested.target).sort().join(',')!=='component,sql_sha256'||requested.target.component!==target.component||
  requested.target.sql_sha256!==target.sql_sha256||requested.aclSha256!==schemaFingerprint(publicAiLabelRuntimeAcl(requested.runtimeRole))||
  !Array.isArray(requested.before)||!requested.before.length||requested.before.length>32||
  requested.before.some(r=>!r||Object.keys(r).sort().join(',')!=='component,sql_sha256'||!identifier(r.component)||!/^[a-f0-9]{64}$/.test(r.sql_sha256)||r.component===component.name)||
  new Set(requested.before.map(r=>r.component)).size!==requested.before.length||!requested.before.some(r=>r.component==='reception_personalization'))
  throw Error('frozen_ai_public_label_plan_required');
 const p=structuredClone(requested),after=[...p.before,p.target],c=await db.connect();let locked=false;
 try{
  await c.query("SET statement_timeout='30s'; SET lock_timeout='3s'");
  const identity=(await c.query(`SELECT current_user,session_user,current_database() database,
   EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) elevated,
   EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) owner_elevated`)).rows[0];
  if(identity.current_user!==p.ownerRole||identity.session_user!==p.migratorRole||identity.database!==p.database||identity.elevated||identity.owner_elevated)
   throw Error('ai_public_label_owner_identity_mismatch');
  locked=(await c.query('SELECT pg_try_advisory_lock(714201,17) locked')).rows[0].locked===true;
  if(!locked)throw Error('other_migration_in_progress');
  await c.query('BEGIN');
  const receipt=(await c.query(`SELECT pg_get_userbyid(relowner) owner,
   has_table_privilege($1,oid,'SELECT') r,has_table_privilege($1,oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') w,
   has_any_column_privilege($1,oid,'INSERT,UPDATE,REFERENCES') cw,
   EXISTS(SELECT 1 FROM aclexplode(coalesce(relacl,acldefault('r',relowner))) a WHERE a.grantee=0) public_access
   FROM pg_class WHERE oid='public.replynest_schema_receipts'::regclass`,[p.runtimeRole])).rows[0];
  if(!receipt||receipt.owner!==p.ownerRole||!receipt.r||receipt.w||receipt.cw||receipt.public_access)throw Error('ai_public_label_protected_receipt_required');
  await c.query('LOCK TABLE public.replynest_schema_receipts IN SHARE ROW EXCLUSIVE MODE');
  const before=(await c.query('SELECT component,sql_sha256 FROM public.replynest_schema_receipts ORDER BY component')).rows;
  const repeated=stable(before)===stable(after);
  if(!repeated&&stable(before)!==stable(p.before))throw Error('ai_public_label_previous_receipt_conflict');
  if(!repeated){
   const orphan=(await c.query(`SELECT 1 FROM pg_class WHERE oid=to_regclass('public.ai_public_label_settings')
    UNION ALL SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace
    WHERE n.nspname='public' AND f.proname='guard_ai_public_label_revision'`)).rowCount;
   if(orphan)throw Error('ai_public_label_unreceipted_schema');
   await c.query(component.sql);await c.query(publicAiLabelRuntimeAcl(p.runtimeRole));
  }
  await verify(c,p);
  if(!repeated)await c.query('INSERT INTO public.replynest_schema_receipts(component,sql_sha256) VALUES($1,$2)',[p.target.component,p.target.sql_sha256]);
  await c.query('COMMIT');return {repeated,atomicDdlAclReceipt:true,executionEnabled:false};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
 finally{if(locked)await c.query('SELECT pg_advisory_unlock(714201,17)').catch(()=>{});
  await c.query('RESET statement_timeout; RESET lock_timeout').catch(()=>{});c.release();}
}
