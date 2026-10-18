/** Disposable full current business DB; no model, native HTTP or production. */
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {pool,businessSchemaSql} from './database.js';
import {automaticReceptionSchemaSql} from './automatic-reception-migrate.js';
import {automaticSemanticSchemaSql} from './automatic-knowledge-migrate.js';
import {schemaFingerprint,verifyDatabaseRuntime} from './database-runtime.js';
import {receptionPersonalizationReleaseComponents,receptionPersonalizationReleaseAcl,migrateReceptionPersonalizationRelease,type ReceptionPersonalizationMigrationPlan} from './reception-personalization-migrate.js';
import {stageAutomaticReception,claimAutomaticReception,saveAutomaticDraft} from './automatic-reception-store.js';
import {claimDueAutomaticReply,finishAutomaticReplyWait} from './automatic-reply-wait-store.js';

assert.equal(process.env.RECEPTION_PERSONALIZATION_MIGRATION_FIXTURE,'isolated-personalization-migration');
assert.equal(process.env.POSTGRES_HOST,'fixture-db');assert.equal(process.env.POSTGRES_DATABASE,'personalization_release_fixture');
assert.equal(process.env.POSTGRES_USERNAME,'persona_release_runtime');
const connection={host:'fixture-db',database:'personalization_release_fixture'};
const root=new Pool({...connection,user:'postgres',password:'isolated-persona-release-root',max:2});
const owner=new Pool({...connection,user:'postgres',password:'isolated-persona-release-root',options:'-c role=persona_release_owner',max:1});
const migrator=new Pool({...connection,user:'persona_release_migrator',password:'isolated-persona-release-migrator',max:1});
const db=pool;
const migration={connect:async()=>{const c=await migrator.connect();await c.query('SET ROLE persona_release_owner');return c;}};
const components=receptionPersonalizationReleaseComponents(),tables=['reception_personalization_settings','reception_history_grants','reception_personalization_rate',
 'reception_learned_styles','reception_personalization_audit','reception_history_knowledge_jobs','automatic_reception_presentations','automatic_reply_waits'];
let checks=0,stage='initial';const check=(v:unknown)=>{assert.ok(v,'persona_migration_check_'+checks);checks++;};
const denied=async(sql:string)=>{await assert.rejects(()=>db.query(sql),e=>(e as any).code==='42501');checks++;};
const before=[{component:'business',sql_sha256:schemaFingerprint(businessSchemaSql())},
 {component:'automatic_reception',sql_sha256:schemaFingerprint(automaticReceptionSchemaSql())},
 {component:'automatic_knowledge_semantic',sql_sha256:schemaFingerprint(automaticSemanticSchemaSql())}];
const plan:ReceptionPersonalizationMigrationPlan={ownerRole:'persona_release_owner',migratorRole:'persona_release_migrator',runtimeRole:'persona_release_runtime',
 database:connection.database,before,target:components.map(c=>({component:c.name,sql_sha256:schemaFingerprint(c.sql)})),
 aclSha256:schemaFingerprint(receptionPersonalizationReleaseAcl('persona_release_runtime')),executionClosed:true};
try{
 stage='owner-bootstrap';await root.query(`CREATE EXTENSION pgcrypto;CREATE EXTENSION vector;CREATE EXTENSION pg_trgm;
 CREATE ROLE persona_release_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
 CREATE ROLE persona_release_migrator LOGIN PASSWORD 'isolated-persona-release-migrator' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
 CREATE ROLE persona_release_runtime LOGIN PASSWORD 'isolated-persona-release-runtime' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
 GRANT persona_release_owner TO persona_release_migrator;
 REVOKE CREATE ON SCHEMA public FROM PUBLIC;REVOKE CREATE ON DATABASE personalization_release_fixture FROM PUBLIC;
 GRANT USAGE,CREATE ON SCHEMA public TO persona_release_owner;GRANT USAGE ON SCHEMA public TO persona_release_runtime;`);
 await owner.query(businessSchemaSql());await owner.query(automaticReceptionSchemaSql());await owner.query(automaticSemanticSchemaSql());
 await owner.query(`CREATE TABLE replynest_schema_receipts(component TEXT PRIMARY KEY,sql_sha256 TEXT NOT NULL,migrated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp());
 REVOKE ALL ON replynest_schema_receipts FROM PUBLIC,persona_release_runtime;GRANT SELECT ON replynest_schema_receipts TO persona_release_runtime;
 -- Deliberately broad future defaults: reviewed ACL must override these for all new component tables.
 ALTER DEFAULT PRIVILEGES FOR ROLE persona_release_owner IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO persona_release_runtime;`);
 for(const row of before)await owner.query('INSERT INTO replynest_schema_receipts(component,sql_sha256) VALUES($1,$2)',[row.component,row.sql_sha256]);
 const objects=async()=>Number((await root.query("SELECT count(*) n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[])",[tables])).rows[0].n);
 const receipts=async()=>(await owner.query('SELECT component,sql_sha256,migrated_at FROM replynest_schema_receipts ORDER BY component')).rows;
 stage='deny-implicit-runtime';await assert.rejects(()=>verifyDatabaseRuntime(db,components),/receipt_mismatch/);checks++;
 for(const wrong of [db,root,owner]){await assert.rejects(()=>migrateReceptionPersonalizationRelease(wrong,plan),/owner_identity_mismatch/);checks++;}
 stage='atomic-receipt-failure';await owner.query(`CREATE FUNCTION fixture_fail_persona_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'isolated_persona_receipt_failure';END;$$;
 CREATE TRIGGER fixture_fail_persona_receipt BEFORE INSERT ON replynest_schema_receipts FOR EACH ROW WHEN(NEW.component='automatic_reply_wait') EXECUTE FUNCTION fixture_fail_persona_receipt();`);
 await assert.rejects(()=>migrateReceptionPersonalizationRelease(migration,plan),/isolated_persona_receipt_failure/);checks++;
 check(await objects()===0&&(await receipts()).length===3);
 check((await owner.query("SELECT 1 FROM pg_trigger WHERE tgname='automatic_reply_wait_submission_guard'")).rowCount===0);
 check((await owner.query("SELECT 1 FROM pg_class WHERE relname='reception_history_customer_contacts'")).rowCount===0);
 await owner.query('DROP TRIGGER fixture_fail_persona_receipt ON replynest_schema_receipts;DROP FUNCTION fixture_fail_persona_receipt()');
 stage='migration-lock';const blocker=await root.connect();await blocker.query('SELECT pg_advisory_lock(714201,17)');
 try{await assert.rejects(()=>migrateReceptionPersonalizationRelease(migration,plan),/other_migration_in_progress/);check(await objects()===0);}finally{await blocker.query('SELECT pg_advisory_unlock(714201,17)');blocker.release();}
 stage='exact-receipts';await owner.query("UPDATE replynest_schema_receipts SET sql_sha256=repeat('b',64) WHERE component='business'");
 await assert.rejects(()=>migrateReceptionPersonalizationRelease(migration,plan),/previous_receipt_conflict/);check(await objects()===0);
 await owner.query('UPDATE replynest_schema_receipts SET sql_sha256=$1 WHERE component=$2',[before[0].sql_sha256,'business']);
 stage='orphan-schema';await owner.query('CREATE TABLE automatic_reply_waits(unreviewed INTEGER)');
 await assert.rejects(()=>migrateReceptionPersonalizationRelease(migration,plan),/unreceipted_schema_requires_review/);check(await objects()===1);
 await owner.query('DROP TABLE automatic_reply_waits');
 stage='install';const installed=await migrateReceptionPersonalizationRelease(migration,plan);
 check(installed.atomicDdlAclReceipt&&!installed.repeated&&!installed.executionEnabled&&installed.components.length===4&&await objects()===8);
 await verifyDatabaseRuntime(db,components);checks++;
 const frozen=JSON.stringify(await receipts());check((await migrateReceptionPersonalizationRelease(migration,plan)).repeated&&JSON.stringify(await receipts())===frozen);
 stage='runtime-negative-acl';for(const table of tables){check((await db.query(`SELECT * FROM ${table} LIMIT 1`)).rowCount===0);
  await denied(`DELETE FROM ${table}`);await denied(`TRUNCATE ${table}`);await denied(`ALTER TABLE ${table} ADD COLUMN unsafe INTEGER`);}
 await denied("UPDATE replynest_schema_receipts SET sql_sha256=repeat('c',64)");await denied('CREATE TABLE unsafe_runtime_schema(id INTEGER)');
 await denied("UPDATE automatic_reply_waits SET due_at=clock_timestamp()");await denied("UPDATE automatic_reply_waits SET draft_hash=repeat('c',64)");
 await denied("UPDATE automatic_reception_presentations SET tone='concise'");await denied("UPDATE reception_personalization_audit SET action='settings.saved'");
 stage='drift';await owner.query('GRANT DELETE ON automatic_reply_waits TO persona_release_runtime');
 await assert.rejects(()=>migrateReceptionPersonalizationRelease(migration,plan),/table_acl_mismatch/);checks++;
 await owner.query('REVOKE DELETE ON automatic_reply_waits FROM persona_release_runtime');
 await owner.query('GRANT UPDATE(due_at) ON automatic_reply_waits TO persona_release_runtime');
 await assert.rejects(()=>migrateReceptionPersonalizationRelease(migration,plan),/column_acl_mismatch/);checks++;
 await owner.query('REVOKE UPDATE(due_at) ON automatic_reply_waits FROM persona_release_runtime');
 await owner.query('ALTER FUNCTION guard_automatic_reply_wait() SECURITY DEFINER');
 await assert.rejects(()=>migrateReceptionPersonalizationRelease(migration,plan),/guard_mismatch/);checks++;
 await owner.query('ALTER FUNCTION guard_automatic_reply_wait() SECURITY INVOKER');
 await owner.query("ALTER FUNCTION guard_automatic_reply_wait() SET search_path='pg_catalog'");
 await assert.rejects(()=>migrateReceptionPersonalizationRelease(migration,plan),/guard_mismatch/);checks++;
 await owner.query('ALTER FUNCTION guard_automatic_reply_wait() RESET ALL');
 await owner.query('ALTER TABLE automatic_reception_jobs DISABLE TRIGGER automatic_reply_wait_submission_guard');
 await assert.rejects(()=>migrateReceptionPersonalizationRelease(migration,plan),/trigger_mismatch/);checks++;
 await owner.query('ALTER TABLE automatic_reception_jobs ENABLE TRIGGER automatic_reply_wait_submission_guard');
 await owner.query(`DROP TRIGGER automatic_reply_wait_submission_guard ON automatic_reception_jobs;
  CREATE TRIGGER automatic_reply_wait_submission_guard BEFORE UPDATE OF state ON automatic_reception_jobs FOR EACH ROW
  WHEN(false) EXECUTE FUNCTION guard_automatic_reply_wait_submission();`);
 await assert.rejects(()=>migrateReceptionPersonalizationRelease(migration,plan),/trigger_mismatch/);checks++;
 await owner.query(`DROP TRIGGER automatic_reply_wait_submission_guard ON automatic_reception_jobs;
  CREATE TRIGGER automatic_reply_wait_submission_guard BEFORE UPDATE OF state ON automatic_reception_jobs FOR EACH ROW
  WHEN(OLD.state='processing' AND NEW.state='submitting') EXECUTE FUNCTION guard_automatic_reply_wait_submission();`);
 await owner.query('GRANT EXECUTE ON FUNCTION guard_history_knowledge_job() TO PUBLIC');
 await assert.rejects(()=>migrateReceptionPersonalizationRelease(migration,plan),/guard_mismatch/);checks++;
 await owner.query('REVOKE EXECUTE ON FUNCTION guard_history_knowledge_job() FROM PUBLIC');
 check(JSON.stringify(await receipts())===frozen);
 stage='restricted-dml';const actor=randomUUID(),session=randomUUID(),customer=randomUUID(),connectionId=randomUUID();
 await owner.query("INSERT INTO tenants(tenant_id,name,status,chatwoot_account_id) VALUES('persona-fixture','合成迁移企业','test',1)");
 await owner.query("INSERT INTO platform_users(platform_user_id,email,display_name) VALUES($1,'persona@example.invalid','合成人员')",[actor]);
 await owner.query("INSERT INTO console_sessions(session_id,token_hash,platform_user_id,selected_tenant_id,user_session_version,expires_at) VALUES($1,$2,$3,'persona-fixture',1,clock_timestamp()+interval '1 hour')",[session,createHash('sha256').update('synthetic-persona-session').digest('hex'),actor]);
 await db.query("INSERT INTO reception_personalization_settings(tenant_id,actor_id,timing_enabled) VALUES('persona-fixture',$1,false)",[actor]);
 await db.query("UPDATE reception_personalization_settings SET automatic_tone='friendly_detailed' WHERE tenant_id='persona-fixture'");
 check((await db.query("SELECT revision FROM reception_personalization_settings WHERE tenant_id='persona-fixture'")).rows[0].revision==='2');
 await db.query("INSERT INTO reception_personalization_audit(audit_id,tenant_id,actor_id,session_id,action,metadata) VALUES($1,'persona-fixture',$2,$3,'settings.saved','{}')",[randomUUID(),actor,session]);
 await db.query("INSERT INTO reception_history_knowledge_jobs(job_id,tenant_id,request_id,account_id,grant_id,actor_id,session_id,request_key) VALUES($1::uuid,'persona-fixture',$2,1,$3,$4,$5,'history-knowledge:'||($1::uuid)::text)",[randomUUID(),randomUUID(),randomUUID(),actor,session]);
 check((await db.query('SELECT state FROM reception_history_knowledge_jobs')).rows[0].state==='queued');
 await owner.query("INSERT INTO customers(customer_id,tenant_id,name) VALUES($1,'persona-fixture','合成客户')",[customer]);
 await owner.query("INSERT INTO channel_connections(connection_id,tenant_id,channel_type,display_name,status) VALUES($1,'persona-fixture','web_chat','隔离渠道','ready')",[connectionId]);
 await owner.query("INSERT INTO tenant_ai_settings(tenant_id,ai_auto_reply_enabled,automatic_sending_enabled,automation_consent_version) VALUES('persona-fixture',true,true,'automatic-reply-v1')");
 await owner.query("INSERT INTO automatic_reception_grants(tenant_id,account_id,authorization_id,consent_version,enabled,actor_id) VALUES('persona-fixture','1',$1,'automatic-send-v1',true,'fixture-seed-only')",[randomUUID()]);
 await owner.query("INSERT INTO channel_identities(tenant_id,customer_id,channel,channel_connection_id,external_user_id,chatwoot_source_id,chatwoot_contact_id,chatwoot_conversation_id) VALUES('persona-fixture',$1,'web_chat',$2,'fixture-user','fixture-source',9,10)",[customer,connectionId]);
 const job=await stageAutomaticReception(owner,{tenantId:'persona-fixture',jobId:randomUUID(),accountId:'1',conversationId:'10',messageId:'500',customerId:customer,channel:'web_chat',connectionId});
 const lease=(await claimAutomaticReception(owner,job))!;check(!!lease);
 await saveAutomaticDraft(owner,lease,{text:'您好',generated:true,fallback:false,requiresHumanApproval:false,evidenceCandidate:true,confidencePercent:95});
 await owner.query("INSERT INTO automatic_reception_revisions(tenant_id,revision) VALUES('persona-fixture',0) ON CONFLICT DO NOTHING");
 // These exact old-component privileges are explicit fixture dependencies,
 // not a claim that all existing production/business ACL was certified here.
 await owner.query('GRANT SELECT ON automatic_reception_jobs,automatic_reception_revisions TO persona_release_runtime;GRANT UPDATE(state,locked_at,updated_at) ON automatic_reception_jobs TO persona_release_runtime');
 await db.query(`INSERT INTO automatic_reception_presentations(job_id,tenant_id,worker_token,account_id,customer_id,question_hash,presentation_hash,
  settings_revision,tone,source_revision,timing_enabled,minimum_seconds,maximum_seconds,binding_hash,context_enabled,style_enabled)
  VALUES($1,'persona-fixture',$2,'1',$3,repeat('a',64),repeat('b',64),2,'friendly_detailed',
  (SELECT revision::text FROM automatic_reception_revisions WHERE tenant_id='persona-fixture'),false,1,30,repeat('c',64),false,false)`,[lease.jobId,lease.workerToken,customer]);
 await db.query(`INSERT INTO automatic_reply_waits(job_id,tenant_id,worker_token,draft_hash,presentation_hash,characters,due_at,expires_at,ready_at)
  SELECT job_id,tenant_id,worker_token,draft_hash,repeat('b',64),2,clock_timestamp(),clock_timestamp()+interval '30 seconds',clock_timestamp()
  FROM automatic_reception_jobs WHERE job_id=$1`,[lease.jobId]);
 const claim=await claimDueAutomaticReply(db,'web');check(!!claim&&claim.lease.jobId===lease.jobId);
 // No submission, model or billing is attempted; prove allowed terminal DML only.
 await owner.query("UPDATE automatic_reception_jobs SET state='skipped',reason='fixture_no_send' WHERE job_id=$1",[lease.jobId]);
 await finishAutomaticReplyWait(db,claim!,'skipped');check((await db.query('SELECT state FROM automatic_reply_waits')).rows[0].state==='finished');
 check((await migrateReceptionPersonalizationRelease(migration,plan)).repeated&&JSON.stringify(await receipts())===frozen);
 stage='final';console.log(JSON.stringify({status:'personalization_release_migration_passed',checks,atomicOwnerMigration:true,components:4,
  newComponentAcl:'exact_table_and_column_non_owner_permissions',existingBusinessAcl:'fixture_dependencies_only_not_full_production_acl',
  runtimeDDL:false,featureOrConsentChanges:0,realModelCalls:0,customerSends:0,productionChanges:0}));
}catch(e){const code=(e as any)?.code;console.error(JSON.stringify({status:'fixture_failed',stage,checks,sqlstate:/^[A-Z0-9]{5}$/.test(code??'')?code:null,
  fixedReason:/^reception_release_[a-z_]+$/.test((e as any)?.message??'')?(e as any).message:null}));throw Error('persona_migration_fixture_failed');
}finally{await Promise.all([db.end(),owner.end(),root.end(),migrator.end()]);}
