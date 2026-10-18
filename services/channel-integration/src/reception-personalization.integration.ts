/** Executed ONLY inside the labelled, isolated fixture created by the runner. */
import {Pool} from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {manageReceptionPersonalization,validateReceptionPersonalizationAction,currentReceptionHistoryGrant,receptionPersonalizationSchema} from './reception-personalization.js';
import {receptionPersonalizationRuntimeAcl,receptionPersonalizationDatabaseComponent} from './reception-personalization-component.js';
import {schemaFingerprint,verifyDatabaseRuntime} from './database-runtime.js';
import {createReceptionPersonalizationApi} from './reception-personalization-api.js';
import {createServer} from 'node:http';
import {createAuthorizedReceptionHistoryReader} from './reception-history-reader.js';
import {createReceptionStyleLearningWorker,resolveReceptionTone} from './reception-style-learning-worker.js';
import {createHistoricalKnowledgeService,historyKnowledgeSchema,historyKnowledgeRuntimeAcl,recoverHistoryKnowledgeJobs} from './reception-history-knowledge.js';
import {manageKnowledgeDraft} from './knowledge-drafts.js';
import {priceAiUsage,initialAiPrices} from './ai-points-core.js';
import {historyKnowledgeDatabaseComponent} from './reception-history-knowledge-component.js';
import {listHistoricalKnowledgeJobs} from './reception-history-knowledge-status.js';
import {databaseComponents} from './database-components.js';
import {publicAiLabelSchema,publicAiLabelRuntimeAcl,publicAiLabelDatabaseComponent,readPublicAiLabel} from './ai-public-label.js';
import {migratePublicAiLabel,type PublicAiLabelMigrationPlan} from './ai-public-label-migrate.js';
assert.equal(process.env.RECEPTION_PERSONALIZATION_FIXTURE,'isolated-personalization');
const url=new URL(process.env.RECEPTION_PERSONALIZATION_FIXTURE_URL??'');
assert.equal(url.hostname,'fixture-db');assert.equal(url.pathname,'/persona_fixture');assert.equal(url.username,'fixture_runtime');
const owner=new Pool({host:'fixture-db',database:'persona_fixture',user:'postgres',password:'isolated-personalization-password',max:1});
const db=new Pool({connectionString:url.toString(),max:4});
// Failure diagnostics contain only PostgreSQL's finite SQLSTATE, never SQL,
// parameters, history, credentials or the server's potentially private message.
const styleDb={connect:async()=>{const c=await db.connect();return {release:()=>c.release(),query:async(...args:any[])=>{
 try{return await (c.query as any)(...args);}catch(e:any){if(/^[A-Z0-9]{5}$/.test(e?.code??''))console.error('fixture_sqlstate='+e.code);throw e;}
 }} as any;}};
let checks=0;const check=(value:unknown)=>{assert.ok(value);checks++;};
const actor=randomUUID(),actorB=randomUUID(),agent=randomUUID();
const tokens={admin:'a'.repeat(64),other:'b'.repeat(64),agent:'c'.repeat(64),impersonated:'d'.repeat(64),embedded:'e'.repeat(64)};
const sessions:Record<string,string>={};
const settings={expectedRevision:'0',draftTone:'neutral',automaticTone:'concise',learnFromHuman:false,timing:{enabled:true,minimumSeconds:1,maximumSeconds:30}};
const action=(kind:'settings'|'history-grant'|'public-label',value:unknown)=>validateReceptionPersonalizationAction(kind,value);
const manage=(value?:ReturnType<typeof action>,token=tokens.admin,tenant='a')=>manageReceptionPersonalization(db,token,tenant,value);
let server:ReturnType<typeof createServer>|undefined;
try{
 await owner.query(`CREATE ROLE fixture_owner NOLOGIN; CREATE ROLE fixture_runtime LOGIN PASSWORD 'isolated-runtime-password';
  CREATE ROLE fixture_status LOGIN PASSWORD 'isolated-status-password';
  REVOKE CREATE ON SCHEMA public FROM PUBLIC; REVOKE CREATE ON DATABASE persona_fixture FROM PUBLIC;
  GRANT USAGE,CREATE ON SCHEMA public TO fixture_owner; GRANT USAGE ON SCHEMA public TO fixture_runtime;
  SET ROLE fixture_owner;
  CREATE TABLE tenants(tenant_id TEXT PRIMARY KEY,status TEXT NOT NULL,chatwoot_account_id BIGINT);
  CREATE TABLE platform_users(platform_user_id UUID PRIMARY KEY,status TEXT,session_version INTEGER);
  CREATE TABLE tenant_memberships(tenant_id TEXT REFERENCES tenants,platform_user_id UUID REFERENCES platform_users,role TEXT,status TEXT,
   chatwoot_account_id BIGINT,chatwoot_sync_status TEXT,PRIMARY KEY(tenant_id,platform_user_id));
  CREATE TABLE console_sessions(session_id UUID PRIMARY KEY,token_hash TEXT UNIQUE,platform_user_id UUID REFERENCES platform_users,selected_tenant_id TEXT REFERENCES tenants,
   revoked_at TIMESTAMPTZ,expires_at TIMESTAMPTZ,last_seen_at TIMESTAMPTZ,user_session_version INTEGER,session_scope TEXT,impersonation_id UUID,impersonated_by_admin_id UUID);
  CREATE TABLE replynest_schema_receipts(component TEXT PRIMARY KEY,sql_sha256 TEXT);
  CREATE TABLE customers(customer_id UUID PRIMARY KEY,tenant_id TEXT REFERENCES tenants,name TEXT,phone TEXT,email TEXT);
  CREATE TABLE channel_identities(tenant_id TEXT REFERENCES tenants,customer_id UUID REFERENCES customers,channel TEXT,chatwoot_contact_id BIGINT,sync_status TEXT);
  CREATE TABLE ai_usage_calls(call_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT REFERENCES tenants,request_key TEXT,feature TEXT,
   model TEXT,status TEXT DEFAULT 'reserved',input_tokens BIGINT,output_tokens BIGINT,cached_input_tokens BIGINT,charged_micros BIGINT DEFAULT 0,
   reserved_micros BIGINT DEFAULT 200000,cost_nano_cny BIGINT,
   created_at TIMESTAMPTZ DEFAULT clock_timestamp(),UNIQUE(tenant_id,request_key));
  CREATE TABLE knowledge_documents(document_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT REFERENCES tenants,title TEXT,source_type TEXT,
   status TEXT,content TEXT,content_format TEXT DEFAULT 'text',content_checksum TEXT,file_size BIGINT,ingestion_status TEXT,scan_status TEXT DEFAULT 'not_required',
   parse_status TEXT DEFAULT 'ready',storage_key TEXT,version INTEGER DEFAULT 1,updated_at TIMESTAMPTZ DEFAULT clock_timestamp());
  CREATE TABLE template_market_imports(order_id UUID PRIMARY KEY,tenant_id TEXT REFERENCES tenants,imported_ids JSONB,license_text TEXT,source_note TEXT);
  CREATE TABLE knowledge_chunks(chunk_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT REFERENCES tenants,document_id UUID REFERENCES knowledge_documents,
   document_version INTEGER,chunk_index INTEGER,content TEXT,embedding_status TEXT);
  CREATE TABLE knowledge_jobs(job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT REFERENCES tenants,document_id UUID REFERENCES knowledge_documents,
   job_type TEXT,status TEXT DEFAULT 'queued',created_at TIMESTAMPTZ DEFAULT clock_timestamp());
  CREATE TABLE audit_logs(tenant_id TEXT REFERENCES tenants,actor_type TEXT,actor_id TEXT,action TEXT,resource_type TEXT,resource_id UUID,after_data JSONB,request_id TEXT);
  GRANT SELECT,INSERT,UPDATE ON ai_usage_calls,knowledge_documents TO fixture_runtime;
  GRANT SELECT ON template_market_imports TO fixture_runtime;GRANT SELECT,INSERT ON knowledge_chunks,knowledge_jobs,audit_logs TO fixture_runtime;
  GRANT SELECT ON customers,channel_identities TO fixture_runtime;
  GRANT SELECT ON tenants,platform_users,tenant_memberships,console_sessions,replynest_schema_receipts TO fixture_runtime;
  -- PostgreSQL row-share locks require UPDATE privilege; grant only one existing
  -- identity column, not DELETE, DDL, or unrestricted writes on these fixtures.
  GRANT UPDATE(tenant_id) ON tenants TO fixture_runtime;
  GRANT UPDATE(platform_user_id) ON platform_users TO fixture_runtime;
  GRANT UPDATE(tenant_id) ON tenant_memberships TO fixture_runtime;
  GRANT UPDATE(session_id) ON console_sessions TO fixture_runtime;`);
 await owner.query("INSERT INTO tenants VALUES('a','test',2),('b','test',3)");
 await owner.query("INSERT INTO platform_users VALUES($1,'active',1),($2,'active',1),($3,'active',1)",[actor,actorB,agent]);
 await owner.query("INSERT INTO tenant_memberships VALUES('a',$1,'tenant_admin','active',2,'synced'),('b',$2,'tenant_admin','active',3,'synced'),('a',$3,'agent','active',2,'synced')",[actor,actorB,agent]);
 for(const [kind,token] of Object.entries(tokens)){
  const id=randomUUID();sessions[kind]=id;
  await owner.query(`INSERT INTO console_sessions VALUES($1,$2,$3,$4,NULL,clock_timestamp()+INTERVAL '1 day',clock_timestamp(),1,$5,$6,$7)`,
   [id,createHash('sha256').update(token).digest('hex'),kind==='other'?actorB:kind==='agent'?agent:actor,kind==='other'?'b':'a',kind==='embedded'?'embedded':'console',kind==='impersonated'?randomUUID():null,kind==='impersonated'?actorB:null]);
 }
 // Simulate a failure before receipt commit: exact new DDL and grants roll back.
 await owner.query('BEGIN');await owner.query(receptionPersonalizationSchema);await owner.query(receptionPersonalizationRuntimeAcl('fixture_runtime'));
 await assert.rejects(()=>owner.query('SELECT missing_fixture_migration_guard()'));await owner.query('ROLLBACK');
 check((await owner.query("SELECT to_regclass('public.reception_history_grants') AS t")).rows[0].t===null);
 await owner.query('BEGIN');await owner.query(receptionPersonalizationSchema);await owner.query(receptionPersonalizationRuntimeAcl('fixture_runtime'));
 await owner.query('INSERT INTO replynest_schema_receipts VALUES($1,$2)',['reception_personalization',schemaFingerprint(receptionPersonalizationSchema)]);await owner.query('COMMIT');
 await owner.query('BEGIN');await owner.query(historyKnowledgeSchema);await owner.query(historyKnowledgeRuntimeAcl('fixture_runtime'));
 await owner.query('INSERT INTO replynest_schema_receipts VALUES($1,$2)',['reception_history_knowledge',schemaFingerprint(historyKnowledgeSchema)]);await owner.query('COMMIT');
 await verifyDatabaseRuntime(db,[receptionPersonalizationDatabaseComponent()]);checks++;
 await verifyDatabaseRuntime(db,[historyKnowledgeDatabaseComponent()]);checks++;
 assert.throws(()=>databaseComponents({AI_HISTORY_KNOWLEDGE_DRAFTS_ENABLED:'true'}),/verified_personalization_required/);checks++;
 const selectedComponents=databaseComponents({AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED:'true',AI_RECEPTION_PERSONALIZATION_MANAGEMENT_ENABLED:'true',
  DATABASE_STARTUP_MODE:'verify',AI_HISTORY_KNOWLEDGE_DRAFTS_ENABLED:'true'});
 check(selectedComponents.filter(c=>c.name==='reception_history_knowledge').length===1);
 const role=(await db.query("SELECT current_user,has_schema_privilege(current_user,'public','CREATE') c,has_database_privilege(current_user,current_database(),'CREATE') d")).rows[0];
 check(role.current_user==='fixture_runtime'&&role.c===false&&role.d===false);
 const count=async(table:string)=>Number((await owner.query(`SELECT count(*) n FROM ${table}`)).rows[0].n);
 const initial=await manage();check(initial.settings.revision==='0'&&initial.grants.length===0&&!initial.availability.presentation&&!initial.availability.history);
 check(await count('reception_personalization_settings')===0);
 let saved=await manage(action('settings',settings));check(saved.settings.revision==='1'&&saved.settings.automaticTone==='concise');
 check(await count('reception_personalization_audit')===1);
 await assert.rejects(()=>manage(action('settings',settings)),(e:any)=>e.code==='personalization_revision_conflict');checks++;
 check(await count('reception_personalization_audit')===1);
 await assert.rejects(()=>manage(undefined,tokens.other,'a'),(e:any)=>e.code==='workspace_changed');checks++;
 const other=await manage(undefined,tokens.other,'b');check(other.settings.revision==='0'&&other.grants.length===0);
 for(const token of [tokens.agent,tokens.impersonated,tokens.embedded,'f'.repeat(64)]){
  await assert.rejects(()=>manage(undefined,token),(e:any)=>e.code==='administrator_session_required');checks++;
 }
 await assert.rejects(()=>manage(action('settings',{...settings,expectedRevision:'1',learnFromHuman:true})),(e:any)=>e.code==='history_style_authorization_required');checks++;
 const style={expectedRevision:'0',purpose:'style',enabled:true,confirmed:true,disclosureVersion:'reception-history-style-v1'};
 saved=await manage(action('history-grant',style));check(saved.grants.length===1&&saved.grants[0].enabled===true&&saved.grants[0].revision==='1');
 let g=(await owner.query("SELECT grant_id FROM reception_history_grants WHERE tenant_id='a' AND purpose='style'")).rows[0].grant_id;
 check(await currentReceptionHistoryGrant(db,'a','2','style',g));check(!await currentReceptionHistoryGrant(db,'a','3','style',g));
 check(!await currentReceptionHistoryGrant(db,'b','2','style',g));check(!await currentReceptionHistoryGrant(db,'a','2','context',g));
 await owner.query("UPDATE tenants SET chatwoot_account_id=3 WHERE tenant_id='a'");
 check(!await currentReceptionHistoryGrant(db,'a','3','style',g));check(!await currentReceptionHistoryGrant(db,'a','2','style',g));
 await owner.query("UPDATE tenants SET chatwoot_account_id=2 WHERE tenant_id='a'");
 await owner.query("UPDATE tenant_memberships SET chatwoot_sync_status='pending' WHERE tenant_id='a' AND platform_user_id=$1",[actor]);
 await assert.rejects(()=>manage(action('history-grant',{expectedRevision:'0',purpose:'context',enabled:true,confirmed:true,disclosureVersion:'reception-history-context-v1'})),(e:any)=>e.code==='history_channel_unavailable');checks++;
 await owner.query("UPDATE tenant_memberships SET chatwoot_sync_status='synced' WHERE tenant_id='a' AND platform_user_id=$1",[actor]);
 saved=await manage(action('settings',{...settings,expectedRevision:'1',learnFromHuman:true}));check(saved.settings.revision==='2'&&saved.settings.learnFromHuman);
 saved=await manage(action('history-grant',{purpose:'style',enabled:false,expectedRevision:'1'}));
 check(saved.settings.revision==='3'&&!saved.settings.learnFromHuman&&saved.grants[0].revision==='2'&&!saved.grants[0].enabled);
 check(!await currentReceptionHistoryGrant(db,'a','2','style',g));
 saved=await manage(action('history-grant',{...style,expectedRevision:'2'}));
 const next=(await owner.query("SELECT grant_id FROM reception_history_grants WHERE tenant_id='a' AND purpose='style'")).rows[0].grant_id;
 check(next!==g&&!await currentReceptionHistoryGrant(db,'a','2','style',g));g=next;
 check(await currentReceptionHistoryGrant(db,'a','2','style',g));
 await owner.query("UPDATE platform_users SET status='disabled' WHERE platform_user_id=$1",[actor]);
 check(!await currentReceptionHistoryGrant(db,'a','2','style',g));
 await assert.rejects(()=>manage(),(e:any)=>e.code==='administrator_session_required');checks++;
 await owner.query("UPDATE platform_users SET status='active' WHERE platform_user_id=$1",[actor]);
 for(const [p,v] of [['context','reception-history-context-v1'],['knowledgeDraft','reception-history-knowledge-draft-v1']]){
  saved=await manage(action('history-grant',{expectedRevision:'0',purpose:p,enabled:true,confirmed:true,disclosureVersion:v}));
  check(saved.grants.filter(row=>row.purpose===p&&row.enabled).length===1);
 }
 const customer=randomUUID();await owner.query("INSERT INTO customers VALUES($1,'a','Synthetic Name','13800138000','synthetic@example.invalid')",[customer]);
 await owner.query("INSERT INTO channel_identities VALUES('a',$1,'shared_wechat',41,'synced')",[customer]);
 const historyGrant=(await owner.query("SELECT grant_id FROM reception_history_grants WHERE tenant_id='a' AND purpose='context'")).rows[0].grant_id;
 const historyScope={tenantId:'a',accountId:'2',purpose:'context' as const,grantId:historyGrant,customerId:customer};
 let nativeReads=0,mutateMapping=false;
 const reader=createAuthorizedReceptionHistoryReader(db,{page:async request=>{
  check(db.totalCount===db.idleCount);nativeReads++;
  if(mutateMapping)await owner.query("UPDATE channel_identities SET chatwoot_contact_id=42 WHERE tenant_id='a'");
  return {outcome:'ready',page:{scanned:1,next_cursor:null,rows:[{account_id:'2',contact_id:'41',inbox_id:'3',conversation_id:'1',message_id:'1',
   created_at:new Date(Date.parse(request.as_of)-1000).toISOString(),direction:'incoming',author_kind:'customer',text:'Synthetic Name synthetic@example.invalid 13800138000'}]}};
 }},{enabled:()=>true});
 const history=await reader.read(historyScope);check(history.purpose==='context'&&history.messages.length===1&&history.privacyPolicy==='history-redaction-v1');
 check(history.purpose==='context'&&!history.messages[0].text.includes('synthetic@example.invalid')&&!history.messages[0].text.includes('Synthetic Name')&&!history.messages[0].text.includes('13800138000'));
 const historyBefore=nativeReads;
 await assert.rejects(()=>reader.read({...historyScope,tenantId:'b'}),/history_authorization_unavailable/);checks++;check(nativeReads===historyBefore);
 mutateMapping=true;await assert.rejects(()=>reader.read(historyScope),/history_scope_unavailable/);checks++;mutateMapping=false;
 await owner.query("UPDATE channel_identities SET chatwoot_contact_id=41 WHERE tenant_id='a'");
 await manage(action('history-grant',{purpose:'context',enabled:false,expectedRevision:'1'}));
 const revokedBefore=nativeReads;await assert.rejects(()=>reader.read(historyScope),/history_authorization_unavailable/);checks++;check(nativeReads===revokedBefore);
 // Reader's two query families have scoped indexes, not a tenant-wide scan.
 check((await owner.query("SELECT count(*)::int n FROM pg_indexes WHERE indexname IN('reception_history_customer_contacts','reception_history_contact_customers')")).rows[0].n===2);
 const beforeAudit=await count('reception_personalization_audit');
 // A real audit insert failure cannot leave settings committed without evidence.
 await owner.query('REVOKE INSERT ON reception_personalization_audit FROM fixture_runtime');
 await assert.rejects(()=>manage(action('settings',{...settings,expectedRevision:'3',automaticTone:'friendly_detailed'})),(e:any)=>e.code==='personalization_result_uncertain');checks++;
 check((await manage()).settings.revision==='3');check(await count('reception_personalization_audit')===beforeAudit);
 await owner.query('GRANT INSERT ON reception_personalization_audit TO fixture_runtime');
 for(const sql of ['DELETE FROM reception_personalization_audit','TRUNCATE reception_personalization_audit','CREATE TABLE should_not_exist(id int)']){
  await assert.rejects(()=>db.query(sql));checks++;
 }
 await assert.rejects(()=>owner.query('DELETE FROM reception_personalization_audit'));checks++;
 check(await count('reception_personalization_audit')===beforeAudit);
 check((await owner.query("SELECT has_table_privilege('fixture_status','reception_history_grants','SELECT') p")).rows[0].p===false);
 let api=createReceptionPersonalizationApi(db,{enabled:()=>true});server=createServer((req,res)=>{void api(req,res,new URL(req.url!,'http://fixture')).then(v=>{if(!v){res.writeHead(404);res.end();}});});
 await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 const response=await fetch(origin+'/api/v1/reception-personalization',{headers:{authorization:'Bearer '+tokens.admin,'x-replynest-workspace':'a'}});
 check(response.status===200);check((await response.json()).data.settings.revision==='3');
 const invalid=await fetch(origin+'/api/v1/reception-personalization/history-grant',{method:'POST',headers:{authorization:'Bearer '+tokens.admin,'x-replynest-workspace':'a','content-type':'application/json'},
  body:JSON.stringify({...style,expectedRevision:'3',disclosureVersion:'web-chat-knowledge-semantic-v3'})});check(invalid.status===400);
 const cross=await fetch(origin+'/api/v1/reception-personalization',{headers:{authorization:'Bearer '+tokens.other,'x-replynest-workspace':'a'}});check(cross.status===409);
 await owner.query("UPDATE reception_personalization_rate SET reads=120,bucket=date_trunc('minute',clock_timestamp()) WHERE session_id=$1",[sessions.admin]);
 await assert.rejects(()=>manage(),(e:any)=>e.code==='rate_limited'&&e.status===429);checks++;
 check((await owner.query('SELECT reads FROM reception_personalization_rate WHERE session_id=$1',[sessions.admin])).rows[0].reads===121);
 // Independent transactions race for the same tenant/revision: exactly one wins.
 const race=await Promise.allSettled([manage(action('settings',{...settings,expectedRevision:'3',draftTone:'concise'})),manage(action('settings',{...settings,expectedRevision:'3',draftTone:'friendly_detailed'}))]);
 check(race.filter(r=>r.status==='fulfilled').length===1);
 check(race.filter(r=>r.status==='rejected'&&r.reason.code==='personalization_revision_conflict').length===1);
 check(await count('reception_personalization_audit')===beforeAudit+1);
 // The earlier rate-limit case intentionally exhausted this fixture session.
 // Reset only its synthetic counter before the independent style scenarios.
 await owner.query('UPDATE reception_personalization_rate SET reads=0,writes=0 WHERE session_id=$1',[sessions.admin]);
 // Persistent style refresh uses the actual restricted runtime and a synthetic
 // aggregate port. It never reads real native history or calls a model.
 let current=await manage();
 await manage(action('settings',{...settings,expectedRevision:current.settings.revision,learnFromHuman:true,draftTone:'concise'}));
 let styleReads=0;
 const aggregate={status:'suggestion' as const,tone:'friendly_detailed' as const,sampleMessages:9,sampleConversations:3,
  medianReplyCharacters:20,politeGreetingRate:1,friendlyMarkerRate:1,emojiRate:0};
 const sample=async()=>({purpose:'style' as const,style:aggregate,sampleDigest:'a'.repeat(64),scanned:9,pages:1,
  asOf:(await owner.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at`)).rows[0].at});
 const styleWorker=createReceptionStyleLearningWorker(styleDb,{read:async()=>{styleReads++;check(db.totalCount===db.idleCount);return sample();}},{enabled:()=>true});
 let refreshed=await styleWorker.batch();check(refreshed.refreshed===1&&refreshed.scanned===1&&refreshed.nextTenant==='a');
 check(await resolveReceptionTone(db,'a','draft',{enabled:()=>true})==='friendly_detailed');
 check(await resolveReceptionTone(db,'b','draft',{enabled:()=>true})==='neutral');
 check((await styleWorker.batch()).scanned===0&&styleReads===1);
 let profile=(await owner.query("SELECT * FROM reception_learned_styles WHERE tenant_id='a'")).rows[0];
 check(profile.lease_id===null&&profile.style.sampleMessages===9&&profile.sample_digest==='a'.repeat(64));
 check(!JSON.stringify(profile.style).includes('messages')&&Object.keys(profile.style).length===8);
 check(profile.next_attempt_at.getTime()>Date.now()+23*3600000&&profile.expires_at.getTime()>Date.now()+6*86400000);
 const makeDue=()=>owner.query("UPDATE reception_learned_styles SET next_attempt_at=clock_timestamp()-INTERVAL '1 second' WHERE tenant_id='a'");
 // Two workers race; only the owned, unexpired lease may persist the result.
 await makeDue();let announce!:()=>void,releaseRead!:()=>void;
 const entered=new Promise<void>(r=>{announce=r;}),released=new Promise<void>(r=>{releaseRead=r;});
 const slow=createReceptionStyleLearningWorker(db,{read:async()=>{announce();await released;return sample();}},{enabled:()=>true});
 const pending=slow.batch();await entered;
 check((await styleWorker.batch()).scanned===0);releaseRead();check((await pending).refreshed===1);
 // Uncertain read: one attempt, no raw error, a persistent fifteen-minute retry
 // boundary; last valid aggregate remains usable only while its grant is fresh.
 await makeDue();let failures=0;
 const broken=createReceptionStyleLearningWorker(db,{read:async()=>{failures++;throw Error('synthetic_private_marker');}},{enabled:()=>true});
 const failure=await broken.batch();check(failure.failed===1&&failures===1&&!JSON.stringify(failure).includes('synthetic_private_marker'));
 profile=(await owner.query("SELECT * FROM reception_learned_styles WHERE tenant_id='a'")).rows[0];
 check(profile.lease_id===null&&profile.next_attempt_at.getTime()>Date.now()+14*60000);
 // Explicit configuration changes invalidate the old learned profile instantly.
 current=await manage();await manage(action('settings',{...settings,expectedRevision:current.settings.revision,learnFromHuman:true,draftTone:'concise'}));
 check(await resolveReceptionTone(db,'a','draft',{enabled:()=>true})==='concise');
 await makeDue();check((await styleWorker.batch()).refreshed===1);
 await owner.query("UPDATE reception_learned_styles SET observed_at=clock_timestamp()-INTERVAL '8 days',expires_at=clock_timestamp()-INTERVAL '1 day' WHERE tenant_id='a'");
 check(await resolveReceptionTone(db,'a','draft',{enabled:()=>true})==='concise');
 // Insufficient recent history does not perpetuate a previous learned tone.
 await makeDue();const insufficient=createReceptionStyleLearningWorker(db,{read:async()=>({...await sample(),style:{...aggregate,status:'insufficient_history',tone:'neutral',sampleMessages:2,sampleConversations:1}})},{enabled:()=>true});
 check((await insufficient.batch()).refreshed===1);check(await resolveReceptionTone(db,'a','draft',{enabled:()=>true})==='concise');
 // Revocation while history is in flight discards the result and owned lease.
 await makeDue();const revokeWorker=createReceptionStyleLearningWorker(db,{read:async()=>{
  const grant=(await manage()).grants.find(row=>row.purpose==='style')!;
  await manage(action('history-grant',{purpose:'style',enabled:false,expectedRevision:grant.revision}));return sample();
 }},{enabled:()=>true});
 check((await revokeWorker.batch()).refreshed===0);check(await resolveReceptionTone(db,'a','draft',{enabled:()=>true})==='concise');
 check((await owner.query("SELECT lease_id FROM reception_learned_styles WHERE tenant_id='a'")).rows[0].lease_id===null);
 // Finite DB and privilege boundaries, not only mock assertions.
 await assert.rejects(()=>db.query("DELETE FROM reception_learned_styles"));checks++;
 await assert.rejects(()=>owner.query("UPDATE reception_learned_styles SET profile_account_id=NULL WHERE tenant_id='a'"));checks++;
 // A bounded after-tenant cursor selects the next eligible tenant, never all.
 await manage(action('history-grant',style),tokens.other,'b');
 await manage(action('settings',{...settings,learnFromHuman:true}),tokens.other,'b');
 const second=await styleWorker.batch({afterTenant:'a',limit:1});check(second.scanned===1&&second.refreshed===1&&second.nextTenant==='b');
 check(await resolveReceptionTone(db,'b','automatic',{enabled:()=>true})==='friendly_detailed');
 // Actual persisted history jobs and ordinary KB review/publish pipeline.
 // Model/reservation/settlement ports are synthetic; receipts use the real DB.
 let modelCalls=0,reservations=0,settlements=0,capacityChecks=0;
 let behavior='success',historyChanged=false;
 const historyMessageTimes=new Map<string,number>();
 const historyPorts={enabled:()=>true,pointsEnabled:()=>true,configured:()=>true,
  reserve:async(tenant:string,key:string)=>{reservations++;if(behavior==='insufficient')throw Object.assign(Error('synthetic'),{code:'ai_points_insufficient'});
   return (await owner.query("INSERT INTO ai_usage_calls(tenant_id,request_key,feature,model) VALUES($1,$2,'studio',$3) RETURNING call_id",[tenant,key,initialAiPrices.text.model])).rows[0].call_id;},
  settle:async(tenant:string,call:string,usage:any,success:boolean)=>{settlements++;if(behavior==='missing_receipt')return;
   await owner.query('UPDATE ai_usage_calls SET status=$3,input_tokens=$4,output_tokens=$5,cached_input_tokens=$6,charged_micros=$7,cost_nano_cny=CASE WHEN $4::bigint IS NULL THEN NULL ELSE $7::bigint END WHERE tenant_id=$1 AND call_id=$2',
    [tenant,call,success?'succeeded':'failed',usage?.input_tokens??null,usage?.output_tokens??null,usage?.cached_input_tokens??null,usage?priceAiUsage(usage,initialAiPrices.text).point_micros:0]);},
  model:async()=>{check(db.totalCount===db.idleCount);modelCalls++;
   if(behavior==='changed_source')historyChanged=true;
   if(behavior==='revoke'){
    const v=(await manage()).grants.find(row=>row.purpose==='knowledgeDraft')!;
    await manage(action('history-grant',{purpose:'knowledgeDraft',enabled:false,expectedRevision:v.revision}));
   }
   if(behavior==='timeout')throw Error('synthetic_unknown_cost');
   return {model:initialAiPrices.text.model,usage:{input_tokens:100,output_tokens:30,cached_input_tokens:0},
    text:JSON.stringify({drafts:[{question:'一般多久发货？',answer:behavior==='private'?'邮箱 a@example.invalid':'通常两个工作日内发货。',sourceMessageIds:['1','2']}]})};},
  capacity:async()=>{capacityChecks++;}
 };
 const knowledgeReader={read:async(scope:any)=>{check(db.totalCount===db.idleCount);const clock=(await owner.query(`SELECT clock_timestamp() at`)).rows[0].at;
  if(!historyMessageTimes.has(scope.tenantId))historyMessageTimes.set(scope.tenantId,clock.getTime());
  const at=historyMessageTimes.get(scope.tenantId)!;
  const base={tenantId:scope.tenantId,accountId:scope.accountId,customerId:'41',conversationId:'1',private:false,deleted:false};
  return {purpose:'knowledgeDraft' as const,privacyPolicy:'history-redaction-v1' as const,sampleDigest:'b'.repeat(64),asOf:clock.toISOString(),scanned:2,pages:1,
   messages:[{...base,messageId:'1',createdAtMs:at-2000,direction:'incoming' as const,authorKind:'customer' as const,text:'一般多久发货？'},
    {...base,messageId:'2',createdAtMs:at-1000,direction:'outgoing' as const,authorKind:'human' as const,text:historyChanged?'更新后不能承诺时限。':'通常两个工作日内发货。'}]};}};
 const knowledge=createHistoricalKnowledgeService(db,knowledgeReader,historyPorts);
 const requestId=randomUUID();const request=()=>knowledge.request(tokens.admin,'a',{requestId,confirmed:true});
 const requested=await Promise.all([request(),request()]);check(requested[0].job_id===requested[1].job_id);
 await assert.rejects(()=>knowledge.request(tokens.other,'a',{requestId:randomUUID(),confirmed:true}),/administrator_required/);checks++;
 await assert.rejects(()=>knowledge.request(tokens.admin,'a',{requestId:randomUUID(),confirmed:true}),/rate_limited/);checks++;
 const generated=await knowledge.runOne();check(generated.state==='succeeded');
 const historyJob=(await owner.query('SELECT * FROM reception_history_knowledge_jobs WHERE job_id=$1',[requested[0].job_id])).rows[0];
 check(historyJob.state==='succeeded'&&historyJob.call_id&&historyJob.usage.input_tokens===100&&historyJob.source_proofs.length===1);
 check(await count('knowledge_chunks')===0&&await count('knowledge_jobs')===0);
 const draftId=historyJob.document_id;
 check((await owner.query('SELECT status FROM knowledge_documents WHERE document_id=$1',[draftId])).rows[0].status==='draft');
 const receipt=(await owner.query('SELECT charged_micros FROM ai_usage_calls WHERE call_id=$1',[historyJob.call_id])).rows[0];
 check(Number(receipt.charged_micros)===161000);check(modelCalls===1&&reservations===1&&settlements===1);
 check((await request()).job_id===historyJob.job_id&&modelCalls===1);check((await knowledge.runOne()).state==='idle');
 const listed=await listHistoricalKnowledgeJobs(db,tokens.admin,'a',{requestId});
 check(listed.items.length===1&&!listed.canGenerate&&listed.items[0].documentId===draftId);
 check(listed.items[0].billing.state==='charged'&&listed.items[0].billing.chargedMicros==='161000');
 for(const [token,tenant] of [[tokens.other,'a'],[tokens.agent,'a'],[tokens.impersonated,'a'],[tokens.embedded,'a']]){
  await assert.rejects(()=>listHistoricalKnowledgeJobs(db,token,tenant),/administrator_required/);checks++;
 }
 api=createReceptionPersonalizationApi(db,{enabled:()=>true,historyEnabled:()=>true,historyService:knowledge});
 const jobHeaders={authorization:'Bearer '+tokens.admin,'x-replynest-workspace':'a','content-type':'application/json'};
 const jobResponse=await fetch(origin+'/api/v1/reception-personalization/knowledge-jobs?requestId='+requestId,{headers:jobHeaders});
 check(jobResponse.status===200&&!((await jobResponse.json()).data.canGenerate));
 const disabledGeneration=await fetch(origin+'/api/v1/reception-personalization/knowledge-jobs',{method:'POST',headers:jobHeaders,body:JSON.stringify({requestId,confirmed:true})});
 check(disabledGeneration.status===409&&modelCalls===1);
 api=createReceptionPersonalizationApi(db,{enabled:()=>true,historyEnabled:()=>true,generationEnabled:()=>true,historyService:knowledge});
 const replayGeneration=await fetch(origin+'/api/v1/reception-personalization/knowledge-jobs',{method:'POST',headers:jobHeaders,body:JSON.stringify({requestId,confirmed:true})});
 check(replayGeneration.status===200&&(await replayGeneration.json()).data.items[0].jobId===historyJob.job_id&&modelCalls===1);
 const invalidJobQuery=await fetch(origin+'/api/v1/reception-personalization/knowledge-jobs?tenant=b',{headers:jobHeaders});check(invalidJobQuery.status===400);
 const crossJobQuery=await fetch(origin+'/api/v1/reception-personalization/knowledge-jobs',{headers:{...jobHeaders,authorization:'Bearer '+tokens.other}});check(crossJobQuery.status===409);
 const auth={tenant_id:'a',role:'tenant_admin',auth_kind:'console_session',actor_id:actor,session_scope:'console'};
 const reviewOptions={db,historyEnabled:true,capacity:historyPorts.capacity};
 const reviewed=await manageKnowledgeDraft(auth,draftId,null,'fixture-read',reviewOptions);check(reviewed.status==='draft'&&reviewed.source_note.includes('核对'));
 await assert.rejects(()=>manageKnowledgeDraft(auth,draftId,null,'fixture-history-off',{...reviewOptions,historyEnabled:false}),/draft_not_found/);checks++;
 for(const blocked of [{...auth,role:'agent'},{...auth,impersonation_id:randomUUID()},{...auth,session_scope:'copilot_embed'}]){
  await assert.rejects(()=>manageKnowledgeDraft(blocked,draftId,null,'fixture-blocked',reviewOptions),/draft_forbidden/);checks++;
 }
 await assert.rejects(()=>manageKnowledgeDraft({...auth,tenant_id:'b',actor_id:actorB},draftId,null,'fixture-cross',reviewOptions),/draft_not_found/);checks++;
 await assert.rejects(()=>manageKnowledgeDraft(auth,draftId,{action:'publish',expected_version:1},'fixture-no-confirm',reviewOptions),/confirmation_required/);checks++;
 check(await count('knowledge_chunks')===0);
 const edited=await manageKnowledgeDraft(auth,draftId,{action:'save',expected_version:1,content:'问题：发货时间？\n答复：一般在两个工作日内发货。'},'fixture-save',reviewOptions);check(edited.version===2&&edited.status==='draft');
 await assert.rejects(()=>manageKnowledgeDraft(auth,draftId,{action:'publish',expected_version:1,confirmed:true},'fixture-stale',reviewOptions),/draft_conflict/);checks++;
 const published=await manageKnowledgeDraft(auth,draftId,{action:'publish',expected_version:2,confirmed:true},'fixture-publish',reviewOptions);check(published.status==='active');
 check(await count('knowledge_chunks')===1&&await count('knowledge_jobs')===1&&capacityChecks===3);
 check((await manageKnowledgeDraft(auth,draftId,{action:'publish',expected_version:2,confirmed:true},'fixture-replay',reviewOptions)).idempotent_replay===true);
 check(await count('knowledge_jobs')===1);
 await assert.rejects(()=>db.query('DELETE FROM reception_history_knowledge_jobs'));checks++;
 await assert.rejects(()=>owner.query("UPDATE reception_history_knowledge_jobs SET state='queued' WHERE job_id=$1",[historyJob.job_id]));checks++;
 // Charged generation with revoked authority must not create a draft.
 behavior='revoke';await knowledge.request(tokens.admin,'a',{requestId:randomUUID(),confirmed:true});
 const revokedGeneration=await knowledge.runOne();check(revokedGeneration.state==='failed');check(await count('knowledge_documents')===1);
 check(modelCalls===2&&settlements===2);check((await knowledge.runOne()).state==='idle');
 let kg=(await manage()).grants.find(row=>row.purpose==='knowledgeDraft')!;
 await manage(action('history-grant',{purpose:'knowledgeDraft',expectedRevision:kg.revision,enabled:true,confirmed:true,disclosureVersion:'reception-history-knowledge-draft-v1'}));
 behavior='private';await knowledge.request(tokens.admin,'a',{requestId:randomUUID(),confirmed:true});check((await knowledge.runOne()).state==='failed');
 check(await count('knowledge_documents')===1&&modelCalls===3&&settlements===3);
 behavior='timeout';await knowledge.request(tokens.admin,'a',{requestId:randomUUID(),confirmed:true});check((await knowledge.runOne()).state==='uncertain');
 check(await count('knowledge_documents')===1&&modelCalls===4);
 behavior='missing_receipt';await knowledge.request(tokens.admin,'a',{requestId:randomUUID(),confirmed:true});check((await knowledge.runOne()).state==='uncertain');
 check(await count('knowledge_documents')===1&&modelCalls===5);
 await assert.rejects(()=>knowledge.request(tokens.admin,'a',{requestId:randomUUID(),confirmed:true}),/rate_limited/);checks++;
 // Another tenant needs its own history authorization; insufficient points do
 // not invoke a model and cannot use a foreign billing receipt.
 await manage(action('history-grant',{purpose:'knowledgeDraft',expectedRevision:'0',enabled:true,confirmed:true,disclosureVersion:'reception-history-knowledge-draft-v1'}),tokens.other,'b');
 behavior='insufficient';await knowledge.request(tokens.other,'b',{requestId:randomUUID(),confirmed:true});
 check((await knowledge.runOne()).state==='failed'&&modelCalls===5);
 check((await owner.query("SELECT reason FROM reception_history_knowledge_jobs WHERE tenant_id='b'")).rows[0].reason==='points_insufficient');
 // A synthetic interrupted worker is terminalized, never retried. No model,
 // reservation or billing side effect occurs in maintenance.
 behavior='success';const interrupted=await knowledge.request(tokens.other,'b',{requestId:randomUUID(),confirmed:true});
 await owner.query("UPDATE reception_history_knowledge_jobs SET state='reading',worker_token=$2,lease_until=clock_timestamp()-INTERVAL '6 minutes',updated_at=clock_timestamp()-INTERVAL '6 minutes' WHERE job_id=$1",[interrupted.job_id,randomUUID()]);
 const beforeRecovery={modelCalls,reservations,settlements};
 await assert.rejects(()=>recoverHistoryKnowledgeJobs(db,new Date()),/invalid_history_recovery/);checks++;
 const recovered=await recoverHistoryKnowledgeJobs(db,new Date(Date.now()-300000),1);check(recovered.length===1&&recovered[0]===interrupted.job_id);
 check((await knowledge.runOne()).state==='idle');check(JSON.stringify(beforeRecovery)===JSON.stringify({modelCalls,reservations,settlements}));
 check((await recoverHistoryKnowledgeJobs(db,new Date(Date.now()-300000),1)).length===0);
 const documentsBeforeChange=await count('knowledge_documents');
 behavior='changed_source';await knowledge.request(tokens.other,'b',{requestId:randomUUID(),confirmed:true});
 check((await knowledge.runOne()).state==='failed');check(await count('knowledge_documents')===documentsBeforeChange);
 check((await owner.query("SELECT reason FROM reception_history_knowledge_jobs WHERE tenant_id='b' ORDER BY created_at DESC LIMIT 1")).rows[0].reason==='draft_rejected');
 // Original marketplace source still follows the same editor when history is
 // disabled. The new join does not open unrelated or ordinary uploaded drafts.
 const imported=(await owner.query("INSERT INTO knowledge_documents(tenant_id,title,source_type,status,content,ingestion_status) VALUES('a','synthetic marketplace','knowledge','draft','Synthetic FAQ','ready') RETURNING document_id")).rows[0].document_id;
 await owner.query("INSERT INTO template_market_imports VALUES($1,'a',$2,'synthetic free license','synthetic official source')",[randomUUID(),JSON.stringify([imported])]);
 const oldReviewed=await manageKnowledgeDraft(auth,imported,null,'fixture-existing-market',{...reviewOptions,historyEnabled:false});check(oldReviewed.license_text==='synthetic free license');
 const marketPublished=await manageKnowledgeDraft(auth,imported,{action:'publish',expected_version:1,confirmed:true},'fixture-market-publish',{...reviewOptions,historyEnabled:false});
 check(marketPublished.status==='active'&&await count('knowledge_jobs')===2);
 const unrelated=(await owner.query("INSERT INTO knowledge_documents(tenant_id,title,source_type,status,content,ingestion_status) VALUES('a','synthetic unrelated','knowledge','draft','Not admitted','ready') RETURNING document_id")).rows[0].document_id;
 await assert.rejects(()=>manageKnowledgeDraft(auth,unrelated,null,'fixture-unrelated',reviewOptions),/draft_not_found/);checks++;
 const allA=await listHistoricalKnowledgeJobs(db,tokens.admin,'a');
 check(allA.items.some(j=>j.state==='failed'&&j.billing.state==='charged'));
 check(allA.items.some(j=>j.state==='uncertain'&&j.billing.state==='review_required'));
 check(!JSON.stringify(allA).includes('source_proofs')&&!JSON.stringify(allA).includes('input_tokens'));
 // More than one page, same microsecond timestamp: job UUID tie-breaks prevent
 // repeats/skips, and tenant B never observes tenant A's documents/receipts.
 for(let i=0;i<32;i++){
  const id=randomUUID();await owner.query(`INSERT INTO reception_history_knowledge_jobs(job_id,tenant_id,request_id,account_id,grant_id,actor_id,session_id,request_key,created_at)
   VALUES($1,'b',$2,3,$3,$4,$5,$6,'2026-01-01T00:00:00.123456Z'::timestamptz)`,[id,randomUUID(),randomUUID(),actorB,sessions.other,'history-knowledge:'+id]);
  await owner.query("UPDATE reception_history_knowledge_jobs SET state='failed' WHERE job_id=$1",[id]);
 }
 const first=await listHistoricalKnowledgeJobs(db,tokens.other,'b');check(first.items.length===25&&first.nextCursor!==null);
 const secondPage=await listHistoricalKnowledgeJobs(db,tokens.other,'b',{cursor:first.nextCursor!});check(secondPage.items.length===10&&secondPage.nextCursor===null);
 check(new Set([...first.items,...secondPage.items].map(j=>j.jobId)).size===35);
 check([...first.items,...secondPage.items].every(j=>j.documentId===null&&!allA.items.some(a=>a.jobId===j.jobId)));
 // New visitor setting uses a separate tenant PK; no conversation/consent rewrite.
 await owner.query(`RESET ROLE;CREATE ROLE fixture_label_migrator LOGIN PASSWORD 'isolated-label-migrator' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  GRANT fixture_owner TO fixture_label_migrator;SET ROLE fixture_owner;`);
 const labelPool=new Pool({host:'fixture-db',database:'persona_fixture',user:'fixture_label_migrator',password:'isolated-label-migrator',max:1});
 const labelDb={connect:async()=>{const c=await labelPool.connect();await c.query('SET ROLE fixture_owner');return c;}};
 const labelPlan:PublicAiLabelMigrationPlan={ownerRole:'fixture_owner',migratorRole:'fixture_label_migrator',runtimeRole:'fixture_runtime',database:'persona_fixture',
  before:(await owner.query('SELECT component,sql_sha256 FROM replynest_schema_receipts ORDER BY component')).rows,
  target:{component:'ai_public_label',sql_sha256:schemaFingerprint(publicAiLabelSchema)},aclSha256:schemaFingerprint(publicAiLabelRuntimeAcl('fixture_runtime')),executionClosed:true};
 try{
  for(const wrong of [owner,db]){await assert.rejects(()=>migratePublicAiLabel(wrong,labelPlan),/owner_identity_mismatch/);checks++;}
  await assert.rejects(()=>migratePublicAiLabel(labelDb,{...labelPlan,executionClosed:false}),/frozen_ai_public_label_plan_required/);checks++;
  await owner.query(`CREATE FUNCTION fixture_label_receipt_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'label_receipt_fixture_failed'; END; $$;
   CREATE TRIGGER fixture_label_receipt_fail BEFORE INSERT ON replynest_schema_receipts FOR EACH ROW WHEN(NEW.component='ai_public_label') EXECUTE FUNCTION fixture_label_receipt_fail();`);
  await assert.rejects(()=>migratePublicAiLabel(labelDb,labelPlan),/label_receipt_fixture_failed/);checks++;
  check((await owner.query("SELECT to_regclass('public.ai_public_label_settings') t")).rows[0].t===null);
  await owner.query('DROP TRIGGER fixture_label_receipt_fail ON replynest_schema_receipts;DROP FUNCTION fixture_label_receipt_fail()');
  const installed=await migratePublicAiLabel(labelDb,labelPlan);check(installed.atomicDdlAclReceipt&&!installed.repeated&&!installed.executionEnabled);
  check((await migratePublicAiLabel(labelDb,labelPlan)).repeated);
  await owner.query('GRANT DELETE ON ai_public_label_settings TO fixture_runtime');
  await assert.rejects(()=>migratePublicAiLabel(labelDb,labelPlan),/acl_mismatch/);checks++;
  await owner.query('REVOKE DELETE ON ai_public_label_settings FROM fixture_runtime');
  await owner.query('ALTER TABLE ai_public_label_settings DISABLE TRIGGER ai_public_label_revision');
  await assert.rejects(()=>migratePublicAiLabel(labelDb,labelPlan),/trigger_mismatch/);checks++;
  await owner.query('ALTER TABLE ai_public_label_settings ENABLE TRIGGER ai_public_label_revision');
 }finally{await labelPool.end();await owner.query('RESET ROLE');}
 await verifyDatabaseRuntime(db,[publicAiLabelDatabaseComponent()]);checks++;
 process.env.AI_PUBLIC_LABEL_SETTINGS_ENABLED='true';process.env.AI_PUBLIC_LABEL_DEFAULT='false';
 check((await manage()).publicLabel?.effective===false&&(await manage()).publicLabel?.override===null);
 const labelAuditBefore=await count('reception_personalization_audit');
 const labelAction=action('public-label',{expectedRevision:'0',override:true});
 check((await manage(labelAction)).publicLabel?.effective===true&&await count('reception_personalization_audit')===labelAuditBefore+1);
 check((await manage(undefined,tokens.other,'b')).publicLabel?.effective===false);
 await assert.rejects(()=>manage(labelAction),(e:any)=>e.code==='personalization_revision_conflict');checks++;
 for(const token of [tokens.agent,tokens.impersonated,tokens.embedded]){
  await assert.rejects(()=>manage(action('public-label',{expectedRevision:'1',override:false}),token),(e:any)=>e.code==='administrator_session_required');checks++;
 }
 await assert.rejects(()=>manage(labelAction,tokens.other,'a'),(e:any)=>e.code==='workspace_changed');checks++;
 check((await manage(action('public-label',{expectedRevision:'1',override:null}))).publicLabel?.effective===false);
 process.env.AI_PUBLIC_LABEL_DEFAULT='true';check((await readPublicAiLabel(db,'a')).effective===true&&(await readPublicAiLabel(db,'b')).effective===true);
 check((await manage(action('public-label',{expectedRevision:'2',override:false}))).publicLabel?.effective===false);
 check((await readPublicAiLabel(db,'b')).effective===true);
 await assert.rejects(()=>db.query('DELETE FROM ai_public_label_settings'),(e:any)=>e.code==='42501');checks++;
 await assert.rejects(()=>db.query('ALTER TABLE ai_public_label_settings ADD COLUMN unsafe BOOLEAN'),(e:any)=>e.code==='42501');checks++;
 await assert.rejects(()=>db.query("UPDATE ai_public_label_settings SET revision=99 WHERE tenant_id='a'"));checks++;
 check((await owner.query("SELECT metadata FROM reception_personalization_audit WHERE metadata->>'scope'='visitor_display_only' ORDER BY created_at DESC LIMIT 1")).rows[0].metadata.publicAiLabel.override===false);
 console.log(JSON.stringify({status:'personalization_real_database_passed',checks,role:'non_owner_runtime',publicAiLabelTenantIsolation:true,atomicAudit:true,historyReads:'synthetic_port_only',
  syntheticModelCalls:modelCalls,syntheticReservations:reservations,syntheticSettlements:settlements,modelCalls:0,customerSends:0,productionChanges:0}));
}finally{
 if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}
 await db.end();await owner.end();
}
