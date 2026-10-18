/** Full business schema and actual live history-draft composition. Provider
 * responses are synthetic; native may be synthetic or actual SELECT-only HTTP.
 * No production connection, credentials, model, send or automatic publication. */
import {Pool} from 'pg';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pool,businessSchemaSql} from './database.js';
import {receptionPersonalizationSchema,manageReceptionPersonalization,validateReceptionPersonalizationAction} from './reception-personalization.js';
import {receptionPersonalizationRuntimeAcl} from './reception-personalization-component.js';
import {historyKnowledgeSchema,historyKnowledgeRuntimeAcl} from './reception-history-knowledge.js';
import {createAuthorizedReceptionHistoryReader} from './reception-history-reader.js';
import {createReceptionHistoryNativeClient} from './reception-history-native-client.js';
import {createLiveHistoryKnowledgeService} from './reception-history-knowledge-live.js';
import {aiPointsOverview,settleAiPoints,reserveAiPoints} from './ai-points.js';
import {listHistoricalKnowledgeJobs} from './reception-history-knowledge-status.js';
import {manageKnowledgeDraft} from './knowledge-drafts.js';
import {createReceptionHistoryQueueRuntime} from './reception-history-runtime.js';
import {createReceptionStyleLearningWorker,resolveReceptionTone} from './reception-style-learning-worker.js';
import {createReceptionDraftPreparation} from './reception-draft-preparation.js';
import {generateReplyDraft} from './llm-provider.js';
import type {StoredReceptionJob} from './reception-store.js';
import {getTenantAiSettings} from './tenant-ai-settings.js';
import {automaticReceptionSchemaSql} from './automatic-reception-migrate.js';
import {automaticPresentationSchema,automaticPresentationRuntimeAcl,createAutomaticPresentationPreparation,currentStoredAutomaticPresentation} from './reception-automatic-presentation.js';
import {saveAutomaticDraft,finishAutomaticReception,type AutomaticReceptionLease} from './automatic-reception-store.js';
import {automaticReplyWaitSchema,automaticReplyWaitRuntimeAcl,persistAutomaticReplyWait,claimDueAutomaticReply,finishAutomaticReplyWait,expireAutomaticReplyWaits} from './automatic-reply-wait-store.js';
import {createAutomaticReplyWaitRuntime} from './automatic-reply-wait-runtime.js';
import {resumeStoredAutomaticReception,type AutomaticReceptionAdapter} from './automatic-reception-runtime.js';
import {planReceptionSendTiming} from './reception-presentation.js';
import {AUTOMATIC_REPLY_CONSENT_VERSION,AUTOMATIC_SEND_CONSENT_VERSION,type AutomaticReplyFacts} from './automatic-reply-policy.js';
import {createMeteredAutomaticGenerator} from './automatic-reception-generation.js';
import {automaticSemanticVerificationSchema,createMeteredAutomaticSemanticVerifier} from './automatic-knowledge-verification.js';
import {assessStoredAutomaticEvidence} from './automatic-reception-evidence-store.js';
import {qwenText} from './qwen-runtime.js';
import {testReplyWaitNative,type ReplyWaitNativeSeed} from './reception-reply-wait-native.integration.js';
import {automaticSemanticSchemaSql,automaticSemanticRuntimeAcl} from './automatic-knowledge-migrate.js';
import {testWechatWaitNative,type WechatWaitSeed} from './reception-wechat-wait-native.integration.js';
import {testSharedWaitNative,type SharedWaitSeed} from './reception-shared-wait-native.integration.js';
import {testSemanticWaitNative} from './reception-semantic-wait-native.integration.js';
import {receptionFixtureSqlGuards,waitForFixtureDatabaseDue} from './reception-fixture-sql-guards.js';
const fixture=process.env.RECEPTION_HISTORY_BILLING_FIXTURE;
assert.equal(fixture,'isolated-history-billing');assert.equal(process.env.POSTGRES_HOST,'fixture-db');
assert.equal(process.env.POSTGRES_DATABASE,'history_billing_fixture');assert.equal(process.env.POSTGRES_USERNAME,'history_runtime');
assert.equal(process.env.QWEN_API_KEY,'synthetic-history-provider-key');assert.equal(process.env.AI_POINTS_ENABLED,'true');
const root=new Pool({host:'fixture-db',database:'history_billing_fixture',user:'postgres',password:'isolated-history-billing-password',max:1});
const owner=new Pool({host:'fixture-db',database:'history_billing_fixture',user:'postgres',password:'isolated-history-billing-password',options:'-c role=history_owner',max:1});
const realNative=process.env.RECEPTION_HISTORY_NATIVE_HTTP==='isolated-history-http';
const nativeWait=process.env.RECEPTION_REPLY_WAIT_NATIVE_HTTP==='isolated-reply-wait-native';
assert.ok(!nativeWait||realNative);
let nativeWaitStarted=false,automaticNativeWaitChecks=0,automaticNativePublicMessages=0,automaticNativeSubmitCalls=0;
let concurrentGenerationProbe=false,concurrentGlobalSqlObservationsOmitted=0;
let wechatNativeWaitChecks=0,wechatSimulatedProviderRequests=0,wechatNativePermitCalls=0,wechatNativeHistoryMessages=0;
let sharedNativeWaitChecks=0,sharedSimulatedProviderRequests=0,sharedNativePermitCalls=0,sharedNativeHistoryMessages=0;
let semanticNativeWaitChecks=0,semanticEmbeddingCalls=0,semanticGenerationCalls=0,semanticVerificationCalls=0,semanticNativePublicMessages=0,semanticChargedMicros=0;
type Seed={account:string;contact:string;human:string;question:string;answer:string};
const seeds:Record<string,Seed>=realNative?JSON.parse(readFileSync('/fixture/history-seed.json','utf8')):{};
if(realNative){assert.deepEqual(Object.keys(seeds),['monthly','credits','insufficient','capacity']);
 for(const seed of Object.values(seeds)){assert.deepEqual(Object.keys(seed),['account','contact','human','question','answer']);
  for(const value of Object.values(seed))assert.match(value,/^[1-9]\d{0,18}$/);}}
const nativeDb=realNative?new Pool({host:'fixture-native-db',database:'history_fixture',user:'postgres',password:'isolated-history-password',max:1}):undefined;
let checks=0,providerCalls=0,nativeCalls=0,stage='schema';
const check=(v:unknown)=>{if(!v)console.error(JSON.stringify({status:'fixture_assertion_diagnostic',stage,checkIndex:checks}));assert.ok(v);checks++;};
const actors:Record<string,string>={},tokens:Record<string,string>={},sessions:Record<string,string>={};
let behavior='success',currentTenant='monthly',enabled=true,draftProviderCalls=0,draftChecks=0,sourceChanged=false,automaticPreparationChecks=0,automaticGenerationChecks=0,automaticProviderCalls=0,automaticWaitChecks=0,syntheticDispatchCalls=0;
const texts={question:'一般多久发货？',answer:'通常两个工作日内发货。'};
const historyAt=Date.now()-60000,secret='synthetic-history-signing-key-'+'0'.repeat(40);
const native=createReceptionHistoryNativeClient({origin:realNative?'http://fixture-native:3000':'http://synthetic-native.invalid',secret,enabled:()=>enabled,
 fetcher:async(url,init)=>{
  nativeCalls++;
  // A global pool/transaction observation cannot attribute a concurrent peer's
  // SQL to this RPC. Keep the guard in serial phases; separately prove atomic
  // generation/verifier/charge cardinality in the deliberate two-caller race.
  if(concurrentGenerationProbe)concurrentGlobalSqlObservationsOmitted++;
  else if(nativeWaitStarted)check(Number((await root.query(receptionFixtureSqlGuards)).rows[0].n)===0);
  else check(pool.totalCount===pool.idleCount);
  const path='/internal/saas_sso/reception_history/page';check(url===(realNative?'http://fixture-native:3000':'http://synthetic-native.invalid')+path&&init?.redirect==='error');
  const body=String(init?.body),v=JSON.parse(body),h=new Headers(init?.headers);
  check(h.get('x-automatic-signature')===createHmac('sha256',secret).update(`${path}\n${h.get('x-automatic-timestamp')}\n${h.get('x-automatic-nonce')}\n${body}`).digest('hex'));
  check(['knowledgeDraft','context',...(realNative?['style']:[])].includes(v.purpose)&&v.cursor===null);
  check(v.purpose==='context'?v.contact_ids.length===1&&v.contact_ids[0]===(realNative?seeds.monthly.contact:'41'):v.contact_ids.length===0);
  if(realNative){
   const response=await fetch(url,init);check(response.status===200);
   const envelope=await response.clone().json() as any,seed=Object.values(seeds).find(s=>s.account===v.account_id)!;
   const ids=v.purpose==='style'?[seed.answer]:[seed.answer,seed.question];
   const expanded=nativeWaitStarted&&seed===seeds.monthly&&v.purpose==='context';
   check((expanded?envelope.rows.length>=ids.length&&envelope.rows.length<=80:envelope.rows.length===ids.length)&&envelope.rows.every((r:any)=>r.account_id===seed.account&&r.contact_id===seed.contact));
   if(expanded){
    const actual=await nativeDb!.query("SELECT id::text FROM messages WHERE account_id=$1 AND (conversation_id=$2 OR inbox_id IN($3,$4)) AND NOT private AND sender_type IN('Contact','User') AND message_type IN(0,1)",
     [seed.account,JSON.parse(readFileSync('/fixture/reply-wait-seed.json','utf8')).conversation,JSON.parse(readFileSync('/fixture/wechat-wait-seed.json','utf8')).inbox,
      JSON.parse(readFileSync('/fixture/shared-wait-seed.json','utf8'))[0].inbox]);
    const allowed=new Set([...ids,...actual.rows.map(r=>r.id)]);check(envelope.rows.every((r:any)=>allowed.has(r.message_id))&&ids.every(id=>envelope.rows.some((r:any)=>r.message_id===id)));
   }else check(envelope.rows.map((r:any)=>r.message_id).join(',')===ids.join(','));
   check(!JSON.stringify(envelope.rows).includes('PRIVATE_')&&!JSON.stringify(envelope.rows).includes('AI_'));
   return response;
  }
  const stamp=(at:number)=>new Date(at).toISOString().replace('Z','000Z');
  const base={account_id:v.account_id,contact_id:'41',inbox_id:'1',conversation_id:'1'};
  return Response.json({state:'ready',request_sha256:createHash('sha256').update(body).digest('hex'),account_id:v.account_id,purpose:v.purpose,grant_id:v.grant_id,as_of:v.as_of,scanned:2,next_cursor:null,
   rows:[{...base,message_id:'2',created_at:stamp(historyAt+1000),direction:'outgoing',author_kind:'human',text:texts.answer},
    {...base,message_id:'1',created_at:stamp(historyAt),direction:'incoming',author_kind:'customer',text:sourceChanged?'历史问题已修改':
     v.purpose==='context'?texts.question+' Synthetic masked customer masked@example.invalid 13800138000':texts.question}]});
 }});
const reader=createAuthorizedReceptionHistoryReader(pool,native,{enabled:()=>enabled});
const service=createLiveHistoryKnowledgeService(reader,{enabled:()=>enabled,fetcher:async(url,init)=>{
 providerCalls++;check(pool.totalCount===pool.idleCount);
 check(url==='https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions'&&init?.redirect==='error');
 const body=JSON.parse(String(init?.body));check(body.model==='qwen3.8-flash'&&body.response_format.type==='json_object'&&body.max_tokens===4000);
 check(new Headers(init?.headers).get('authorization')==='Bearer synthetic-history-provider-key');
 check(!String(init?.body).includes(actors[currentTenant])&&!String(init?.body).includes(sessions[currentTenant]));
 const hold=await aiPointsOverview(currentTenant);check(hold.monthly_used_micros>0||hold.credit_available_micros<100000000);
 if(behavior==='revoke'){
  const view=await manageReceptionPersonalization(pool,tokens[currentTenant],currentTenant),grant=view.grants.find(g=>g.purpose==='knowledgeDraft')!;
  await manageReceptionPersonalization(pool,tokens[currentTenant],currentTenant,validateReceptionPersonalizationAction('history-grant',{purpose:'knowledgeDraft',enabled:false,expectedRevision:grant.revision}));
 }
 if(behavior==='edit_source')await nativeDb!.query("UPDATE messages SET content='Source changed during synthetic model call' WHERE id=$1 AND account_id=$2",[seeds[currentTenant].answer,seeds[currentTenant].account]);
 const ids=realNative?[seeds[currentTenant].question,seeds[currentTenant].answer]:['1','2'];
 return Response.json({choices:[{message:{content:behavior==='invalid'?'not-json':JSON.stringify({drafts:[{question:texts.question,answer:texts.answer,sourceMessageIds:ids}]})},finish_reason:'stop'}],
  ...(behavior==='missing_usage'?{}:{usage:{prompt_tokens:100,completion_tokens:30,prompt_tokens_details:{cached_tokens:0}}})});
}});
try{
 await root.query(`CREATE EXTENSION pgcrypto;CREATE EXTENSION vector;CREATE EXTENSION pg_trgm;
  CREATE ROLE history_owner NOLOGIN;CREATE ROLE history_runtime LOGIN PASSWORD 'isolated-history-runtime-password';
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;REVOKE CREATE ON DATABASE history_billing_fixture FROM PUBLIC;
  GRANT USAGE,CREATE ON SCHEMA public TO history_owner;GRANT USAGE ON SCHEMA public TO history_runtime;`);
 stage='full-business-schema';await owner.query(businessSchemaSql());stage='personalization-schema';
 await owner.query(receptionPersonalizationSchema);await owner.query(historyKnowledgeSchema);
 await owner.query(receptionPersonalizationRuntimeAcl('history_runtime'));await owner.query(historyKnowledgeRuntimeAcl('history_runtime'));
 await owner.query(`GRANT SELECT ON tenants,platform_users,tenant_memberships,console_sessions,plan_catalog_versions,tenant_subscriptions,
  trial_entitlements,usage_events,ai_point_pack_versions,ai_point_funding_lots,ai_point_refund_usage,template_market_imports TO history_runtime;
  GRANT UPDATE(tenant_id) ON tenants,tenant_memberships TO history_runtime;
  GRANT UPDATE(platform_user_id) ON platform_users TO history_runtime;GRANT UPDATE(session_id) ON console_sessions TO history_runtime;
  GRANT SELECT,INSERT,UPDATE ON ai_usage_calls,ai_point_month_usage,ai_point_lot_usage,knowledge_documents TO history_runtime;
  GRANT SELECT,INSERT ON knowledge_chunks,knowledge_jobs,audit_logs TO history_runtime;
  GRANT SELECT ON customers,channel_identities,reception_jobs,tenant_ai_settings TO history_runtime;
  GRANT UPDATE(state,draft,reason,updated_at) ON reception_jobs TO history_runtime;
  REVOKE EXECUTE ON FUNCTION rebuild_ai_point_usage_projection(),rebuild_ai_point_funding_projection() FROM PUBLIC;`);
 const role=(await pool.query("SELECT current_user,has_schema_privilege(current_user,'public','CREATE') ddl,has_table_privilege(current_user,'ai_usage_calls','DELETE') del")).rows[0];
 check(role.current_user==='history_runtime'&&!role.ddl&&!role.del);
 await assert.rejects(()=>pool.query('SELECT rebuild_ai_point_usage_projection()'));checks++;
 const rules=(await owner.query("SELECT entitlement_rules FROM plan_catalog_versions WHERE plan_code='free' AND status='active'")).rows[0].entitlement_rules;
 let account=1;
 for(const tenant of ['monthly','credits','insufficient','capacity']){
  stage='seed-'+tenant+'-tenant';
  actors[tenant]=randomUUID();tokens[tenant]=String(account).repeat(64);sessions[tenant]=randomUUID();
  const nativeAccount=realNative?seeds[tenant].account:account;
  await owner.query("INSERT INTO tenants(tenant_id,name,status,chatwoot_account_id) VALUES($1,$1,'test',$2)",[tenant,nativeAccount]);
  stage='seed-'+tenant+'-actor';
  await owner.query("INSERT INTO platform_users(platform_user_id,email,display_name) VALUES($1,$2,'Synthetic history administrator')",[actors[tenant],tenant+'@example.invalid']);
  stage='seed-'+tenant+'-membership';
  await owner.query(`INSERT INTO tenant_memberships(tenant_id,platform_user_id,role,chatwoot_user_id,chatwoot_user_email,chatwoot_account_id)
   VALUES($1,$2,'tenant_admin',$3,$4,$5)`,[tenant,actors[tenant],realNative?seeds[tenant].human:account,tenant+'@example.invalid',nativeAccount]);
  stage='seed-'+tenant+'-session';
  await owner.query(`INSERT INTO console_sessions(session_id,token_hash,platform_user_id,selected_tenant_id,user_session_version,expires_at)
   VALUES($1,$2,$3,$4,1,clock_timestamp()+INTERVAL '1 day')`,[sessions[tenant],createHash('sha256').update(tokens[tenant]).digest('hex'),actors[tenant],tenant]);
  const entitlement={...rules,ai_actions_monthly:['credits','insufficient'].includes(tenant)?0:100,knowledge_bytes:tenant==='capacity'?0:100000};
  stage='seed-'+tenant+'-subscription';
  await owner.query(`INSERT INTO tenant_subscriptions(tenant_id,plan_version_id,status,source,current_period_start,entitlement_snapshot)
   SELECT $1,plan_version_id,'active','synthetic',clock_timestamp(),$2::jsonb FROM plan_catalog_versions WHERE plan_code='free' AND status='active'`,[tenant,JSON.stringify(entitlement)]);
  stage='seed-'+tenant+'-grant';await manageReceptionPersonalization(pool,tokens[tenant],tenant,validateReceptionPersonalizationAction('history-grant',{
   purpose:'knowledgeDraft',enabled:true,expectedRevision:'0',confirmed:true,disclosureVersion:'reception-history-knowledge-draft-v1'}));account++;
 }
 // A balanced synthetic grant enters the actual immutable ledger, posting and
 // funding projection triggers; it is not a manually edited spendable balance.
 stage='seed-funding';const fundingTx=randomUUID();await owner.query('BEGIN');
 await owner.query(`INSERT INTO ledger_transactions(transaction_id,tenant_id,currency,transaction_type,idempotency_key,request_hash,source_type,source_id,occurred_at,created_by)
  VALUES($1::uuid,'credits','AIC','ai_credit_grant',$1::text,$2,'history_fixture',$1::text,clock_timestamp(),'fixture_owner')`,[fundingTx,'0'.repeat(64)]);
 await owner.query(`INSERT INTO ledger_entries(transaction_id,tenant_id,account,direction,amount_minor,currency)
  VALUES($1,'credits','clearing','debit',10000,'AIC'),($1,'credits','ai_credit','credit',10000,'AIC')`,[fundingTx]);
 await owner.query("UPDATE ledger_transactions SET status='posted',posted_at=clock_timestamp() WHERE transaction_id=$1",[fundingTx]);await owner.query('COMMIT');
 check((await aiPointsOverview('credits')).credit_available_micros===100000000);
 const request=async(tenant:string)=>{currentTenant=tenant;return service.request(tokens[tenant],tenant,{requestId:randomUUID(),confirmed:true});};
 const noDrafts=async(tenant:string)=>Number((await owner.query('SELECT count(*) n FROM knowledge_documents WHERE tenant_id=$1',[tenant])).rows[0].n)===0;
 stage='monthly-success';const before=await aiPointsOverview('monthly'),job=await request('monthly');
 if(realNative){
  const ticks:Array<()=>void>=[],reports:Array<{worker:string;state:string;count:number}>=[];
  const queue=createReceptionHistoryQueueRuntime({knowledge:service,enabled:()=>enabled,
   schedule:callback=>{ticks.push(callback);return ()=>{};},report:(worker,state,count)=>reports.push({worker,state,count})});
  queue.start();check(ticks.length===1);ticks[0]!();await new Promise<void>(resolve=>setImmediate(resolve));
  await queue.stop();check(reports.length===1&&reports[0]!.state==='processed'&&reports[0]!.count===1);
  check((await owner.query('SELECT state FROM reception_history_knowledge_jobs WHERE job_id=$1',[job.job_id])).rows[0].state==='succeeded');
  const afterStop=providerCalls;ticks[0]!();await new Promise<void>(resolve=>setImmediate(resolve));check(providerCalls===afterStop);
 }else check((await service.runOne()).state==='succeeded');
 const after=await aiPointsOverview('monthly');check(after.monthly_used_micros-before.monthly_used_micros===161000);
 const receipt=(await listHistoricalKnowledgeJobs(pool,tokens.monthly,'monthly')).items[0];check(receipt.billing.chargedMicros==='161000'&&receipt.documentId!==null);
 check(Number((await owner.query('SELECT count(*) n FROM knowledge_chunks')).rows[0].n)===0&&Number((await owner.query('SELECT count(*) n FROM knowledge_jobs')).rows[0].n)===0);
 const call=(await owner.query('SELECT call_id FROM reception_history_knowledge_jobs WHERE job_id=$1',[job.job_id])).rows[0].call_id;
 await settleAiPoints('monthly',call,{input_tokens:100,output_tokens:30,cached_input_tokens:0},true);
 check((await aiPointsOverview('monthly')).monthly_used_micros===after.monthly_used_micros);
 await assert.rejects(()=>settleAiPoints('credits',call,undefined,false),/not_found/);checks++;
 await assert.rejects(()=>pool.query('UPDATE ai_usage_calls SET charged_micros=0 WHERE call_id=$1',[call]),/immutable/);checks++;
 const auth={tenant_id:'monthly',role:'tenant_admin',auth_kind:'console_session',actor_id:actors.monthly,session_scope:'console'};
 await assert.rejects(()=>manageKnowledgeDraft(auth,receipt.documentId!,{action:'publish',expected_version:1},randomUUID(),{historyEnabled:true}),/confirmation_required/);checks++;
 check((await manageKnowledgeDraft(auth,receipt.documentId!,{action:'publish',expected_version:1,confirmed:true},randomUUID(),{historyEnabled:true})).status==='active');
 check(Number((await owner.query('SELECT count(*) n FROM knowledge_jobs')).rows[0].n)===1);
 stage='credit-success';const creditBefore=await aiPointsOverview('credits');await request('credits');check((await service.runOne()).state==='succeeded');
 const creditAfter=await aiPointsOverview('credits');check(creditAfter.monthly_used_micros===0&&creditBefore.credit_available_micros-creditAfter.credit_available_micros===161000);
 check((await owner.query("SELECT used_micros::text FROM ai_point_lot_usage WHERE tenant_id='credits'")).rows[0].used_micros==='161000');
 stage='insufficient';const attemptedBefore=providerCalls;await request('insufficient');check((await service.runOne()).state==='failed');
 check(providerCalls===attemptedBefore&&await noDrafts('insufficient'));check((await aiPointsOverview('insufficient')).monthly_used_micros===0);
 check(Number((await owner.query("SELECT count(*) n FROM ai_usage_calls WHERE tenant_id='insufficient'")).rows[0].n)===0);
 stage='capacity';await request('capacity');check((await service.runOne()).state==='failed'&&await noDrafts('capacity'));
 check((await aiPointsOverview('capacity')).monthly_used_micros===161000);
 check((await owner.query("SELECT reason FROM reception_history_knowledge_jobs WHERE tenant_id='capacity'")).rows[0].reason==='knowledge_capacity_exceeded_billed');
 stage='invalid-output';behavior='invalid';await request('monthly');check((await service.runOne()).state==='failed');
 check((await aiPointsOverview('monthly')).monthly_used_micros===322000);
 stage='unknown-usage';behavior='missing_usage';await request('monthly');check((await service.runOne()).state==='uncertain');
 check((await aiPointsOverview('monthly')).monthly_used_micros===322000);
 const unknown=(await listHistoricalKnowledgeJobs(pool,tokens.monthly,'monthly')).items[0];check(unknown.state==='uncertain'&&unknown.billing.state==='review_required');
 const beforeIdle=providerCalls;check((await service.runOne()).state==='idle'&&providerCalls===beforeIdle);
 stage='revoke';behavior='revoke';await request('monthly');check((await service.runOne()).state==='failed');
 check((await aiPointsOverview('monthly')).monthly_used_micros===483000);
 check(Number((await owner.query("SELECT count(*) n FROM knowledge_documents WHERE tenant_id='monthly'")).rows[0].n)===1);
 const revokedJob=(await listHistoricalKnowledgeJobs(pool,tokens.monthly,'monthly')).items[0];check(revokedJob.state==='failed'&&revokedJob.billing.chargedMicros==='161000');
 const beforeRevokedRequest=providerCalls;
 await assert.rejects(()=>request('monthly'),/history_authorization_required/);checks++;
 check(providerCalls===beforeRevokedRequest&&(await service.runOne()).state==='idle');
 if(realNative){
  stage='source-edit';behavior='edit_source';await request('credits');check((await service.runOne()).state==='failed');
  check((await aiPointsOverview('credits')).credit_available_micros===100000000-322000);
  check(Number((await owner.query("SELECT count(*) n FROM knowledge_documents WHERE tenant_id='credits'")).rows[0].n)===1);
  const changed=(await listHistoricalKnowledgeJobs(pool,tokens.credits,'credits')).items[0];check(changed.state==='failed'&&changed.billing.chargedMicros==='161000'&&changed.documentId===null);
  stage='signed-http-guards';
  const path='/internal/saas_sso/reception_history/page',stamp=String(Date.now()),nonce=randomUUID().replaceAll('-','');
  const body=JSON.stringify({account_id:seeds.monthly.account,purpose:'context',grant_id:randomUUID(),as_of:new Date().toISOString().replace('Z','000Z'),contact_ids:[seeds.credits.contact],cursor:null});
  const headers={'content-type':'application/json','x-forwarded-proto':'https','x-automatic-timestamp':stamp,'x-automatic-nonce':nonce,
   'x-automatic-signature':createHmac('sha256',secret).update(`${path}\n${stamp}\n${nonce}\n${body}`).digest('hex')};
  const once=await fetch('http://fixture-native:3000'+path,{method:'POST',headers,body,signal:AbortSignal.timeout(2000),redirect:'error'});
  check(once.status===200);check((await once.json() as any).rows.length===0);
  check((await fetch('http://fixture-native:3000'+path,{method:'POST',headers,body,signal:AbortSignal.timeout(2000),redirect:'error'})).status===409);
  check((await fetch('http://fixture-native:3000'+path,{method:'POST',headers:{...headers,'x-automatic-signature':'0'.repeat(64)},body,signal:AbortSignal.timeout(2000),redirect:'error'})).status===401);
  const acl=(await nativeDb!.query("SELECT has_schema_privilege('history_http_runtime','public','CREATE') ddl,has_table_privilege('history_http_runtime','messages','INSERT') ins,has_table_privilege('history_http_runtime','messages','UPDATE') upd,has_table_privilege('history_http_runtime','messages','DELETE') del")).rows[0];
  check(!acl.ddl&&!acl.ins&&!acl.upd&&!acl.del);
  stage='actual-style-queue';
  await manageReceptionPersonalization(pool,tokens.monthly,'monthly',validateReceptionPersonalizationAction('history-grant',{
   purpose:'style',enabled:true,expectedRevision:'0',confirmed:true,disclosureVersion:'reception-history-style-v1'}));
  const settings=(await manageReceptionPersonalization(pool,tokens.monthly,'monthly')).settings;
  await manageReceptionPersonalization(pool,tokens.monthly,'monthly',validateReceptionPersonalizationAction('settings',{
   expectedRevision:settings.revision,draftTone:'concise',automaticTone:'friendly_detailed',learnFromHuman:true,timing:{enabled:true,minimumSeconds:1,maximumSeconds:30}}));
  const styleWorker=createReceptionStyleLearningWorker(pool,reader,{enabled:()=>enabled}),ticks:Array<()=>void>=[],reports:unknown[]=[];
  const styleQueue=createReceptionHistoryQueueRuntime({style:styleWorker,enabled:()=>enabled,
   schedule:callback=>{ticks.push(callback);return ()=>{};},report:(worker,state,count)=>reports.push({worker,state,count})});
  const beforeStyle={providerCalls,nativeCalls};styleQueue.start();check(ticks.length===1);ticks[0]!();
  await new Promise<void>(resolve=>setImmediate(resolve));await styleQueue.stop();
  check(providerCalls===beforeStyle.providerCalls&&nativeCalls===beforeStyle.nativeCalls+1);
  check(JSON.stringify(reports)===JSON.stringify([{worker:'style',state:'processed',count:1}]));
  const profile=(await owner.query("SELECT style,lease_id,expires_at>clock_timestamp() valid,next_attempt_at>clock_timestamp()+INTERVAL '23 hours' cooldown FROM reception_learned_styles WHERE tenant_id='monthly'")).rows[0];
  check(profile.style.status==='insufficient_history'&&profile.style.sampleMessages===1&&profile.style.sampleConversations===1&&profile.lease_id===null&&profile.valid&&profile.cooldown);
  check(!JSON.stringify(profile.style).includes(texts.answer)&&Object.keys(profile.style).sort().join(',')==='emojiRate,friendlyMarkerRate,medianReplyCharacters,politeGreetingRate,sampleConversations,sampleMessages,status,tone');
  check(await resolveReceptionTone(pool,'monthly','draft',{enabled:()=>enabled})==='concise');
  check(await resolveReceptionTone(pool,'monthly','automatic',{enabled:()=>enabled})==='friendly_detailed');
  check((await styleWorker.batch({limit:5})).scanned===0&&nativeCalls===beforeStyle.nativeCalls+1);
  const styleGrant=(await manageReceptionPersonalization(pool,tokens.monthly,'monthly')).grants.find(g=>g.purpose==='style')!;
  await manageReceptionPersonalization(pool,tokens.monthly,'monthly',validateReceptionPersonalizationAction('history-grant',{
   purpose:'style',enabled:false,expectedRevision:styleGrant.revision}));
  const revokedStyle=await manageReceptionPersonalization(pool,tokens.monthly,'monthly');
  check(!revokedStyle.settings.learnFromHuman&&!revokedStyle.grants.find(g=>g.purpose==='style')!.enabled);
  check(await resolveReceptionTone(pool,'monthly','draft',{enabled:()=>enabled})==='concise');
  check((await styleWorker.batch({limit:5})).scanned===0&&nativeCalls===beforeStyle.nativeCalls+1);
 }
 // Incremental projection may omit zero-only rows; rebuild may materialize
 // them. Compare every nonzero amount and all public balances, not row presence.
 stage='projection-rebuild';const balancesBefore=await Promise.all(['monthly','credits','insufficient','capacity'].map(t=>aiPointsOverview(t)));
 const originalMonth=(await owner.query('SELECT tenant_id,used_micros::text FROM ai_point_month_usage WHERE used_micros>0 ORDER BY tenant_id')).rows;
 const originalLot=(await owner.query('SELECT tenant_id,entry_id,used_micros::text FROM ai_point_lot_usage WHERE used_micros>0 ORDER BY tenant_id,entry_id')).rows;
 await owner.query('SELECT rebuild_ai_point_usage_projection()');
 check(JSON.stringify((await owner.query('SELECT tenant_id,used_micros::text FROM ai_point_month_usage WHERE used_micros>0 ORDER BY tenant_id')).rows)===JSON.stringify(originalMonth));
 check(JSON.stringify((await owner.query('SELECT tenant_id,entry_id,used_micros::text FROM ai_point_lot_usage WHERE used_micros>0 ORDER BY tenant_id,entry_id')).rows)===JSON.stringify(originalLot));
 check(JSON.stringify(await Promise.all(['monthly','credits','insufficient','capacity'].map(t=>aiPointsOverview(t))))===JSON.stringify(balancesBefore));
 stage='wallet-lock-timeout';const blocker=await owner.connect();const blockedKey='history-fixture-blocked-'+randomUUID();
 try{
  await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))',['wallet:monthly']);
  const start=Date.now();await assert.rejects(()=>reserveAiPoints('monthly',blockedKey,'studio',100,30),(e:any)=>e.code==='55P03');checks++;
  check(Date.now()-start>=350&&Date.now()-start<2500);
 }finally{await blocker.query('ROLLBACK');blocker.release();}
 check(Number((await owner.query('SELECT count(*) n FROM ai_usage_calls WHERE request_key=$1',[blockedKey])).rows[0].n)===0);
 check((await aiPointsOverview('monthly')).monthly_used_micros===483000&&pool.totalCount===pool.idleCount);
 // Actual generation preparation + Qwen parser/metering + atomic private-note
 // barrier. Native note projection itself is NOT exercised by this fixture.
 stage='draft-presentation-context';const draftCheck=(v:unknown)=>{check(v);draftChecks++;};
 const customer=randomUUID(),contact=realNative?seeds.monthly.contact:'41';
 const nativeAccount=String(realNative?seeds.monthly.account:'1'),conversation='1';
 await owner.query("INSERT INTO customers(customer_id,tenant_id,name,phone,email) VALUES($1,'monthly','Synthetic masked customer','13800138000','masked@example.invalid')",[customer]);
 await owner.query(`INSERT INTO channel_identities(tenant_id,customer_id,channel,external_user_id,chatwoot_contact_id,chatwoot_source_id,chatwoot_conversation_id)
  VALUES('monthly',$1,'shared_wechat','synthetic-context-customer',$2,'synthetic',1)`,[customer,contact]);
 await owner.query(`INSERT INTO tenant_ai_settings(tenant_id,llm_provider,llm_model,ai_auto_reply_enabled,automatic_sending_enabled,automation_consent_version,automation_updated_at)
  VALUES('monthly','deterministic','deterministic-phase4-sample',true,false,'automatic-reply-v1',date_trunc('milliseconds',clock_timestamp())+INTERVAL '123 microseconds')`);
 const settingsBefore=(await manageReceptionPersonalization(pool,tokens.monthly,'monthly')).settings;
 await manageReceptionPersonalization(pool,tokens.monthly,'monthly',validateReceptionPersonalizationAction('settings',{
  expectedRevision:settingsBefore.revision,draftTone:'friendly_detailed',automaticTone:'concise',learnFromHuman:false,timing:{enabled:true,minimumSeconds:1,maximumSeconds:30}}));
 const makeJob=async():Promise<StoredReceptionJob>=>{
  const id=randomUUID(),worker=randomUUID();
  return (await owner.query(`INSERT INTO reception_jobs(job_id,tenant_id,account_id,conversation_id,message_id,customer_id,channel,authorization_at,state,worker_token,locked_at)
   SELECT $1,'monthly',$3,$4,$5,$6,'shared_wechat',automation_updated_at,'processing',$2,clock_timestamp() FROM tenant_ai_settings WHERE tenant_id='monthly' RETURNING *`,
   [id,worker,nativeAccount,conversation,String(100+draftChecks),customer])).rows[0];
 };
 const prep=createReceptionDraftPreparation(pool,reader,{enabled:()=>enabled,contextEnabled:()=>enabled});
 if(realNative)await nativeDb!.query('UPDATE messages SET content=$3 WHERE account_id=$1 AND id=$2',
  [seeds.monthly.account,seeds.monthly.question,texts.question+' Synthetic masked customer masked@example.invalid 13800138000']);
 const noGrantJob=await makeJob(),noGrantReads=nativeCalls,noGrant=await prep.prepare(noGrantJob);
 draftCheck(noGrant.presentation.tone==='friendly_detailed'&&noGrant.presentation.context.length===0&&nativeCalls===noGrantReads);
 await manageReceptionPersonalization(pool,tokens.monthly,'monthly',validateReceptionPersonalizationAction('history-grant',{
  purpose:'context',enabled:true,expectedRevision:'0',confirmed:true,disclosureVersion:'reception-history-context-v1'}));
 draftCheck(!await prep.current(noGrant)); // new opt-in invalidates an in-flight old snapshot too
 const draftJob=await makeJob(),prepared=await prep.prepare(draftJob);
 draftCheck(prepared.presentation.tone==='friendly_detailed'&&prepared.presentation.context.length===2);
 draftCheck(!JSON.stringify(prepared).includes(customer)&&!JSON.stringify(prepared).includes(actors.monthly)&&!JSON.stringify(prepared).includes(contact+'"'));
 draftCheck(!JSON.stringify(prepared).includes('masked@example.invalid')&&!JSON.stringify(prepared).includes('13800138000')&&!JSON.stringify(prepared).includes('Synthetic masked customer'));
 draftCheck(JSON.stringify(prepared).includes('已隐藏'));
 const originalFetch=globalThis.fetch,balance=(await aiPointsOverview('monthly')).monthly_used_micros;
 let revokeDuringModel=false;
 try{
  globalThis.fetch=async(url,init)=>{
   if(!String(url).startsWith('https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions'))return originalFetch(url,init);
   draftProviderCalls++;draftCheck(pool.totalCount===pool.idleCount);
   const body=JSON.parse(String(init?.body)),data=JSON.parse(body.messages[1].content);
   draftCheck(body.model==='qwen3.8-flash'&&body.max_tokens===500);
   draftCheck(body.messages[0].content.includes('亲切详细')&&body.messages[0].content.includes('事实只能来自'));
   draftCheck(data.presentation.tone==='friendly_detailed'&&data.presentation.context.length===2);
   draftCheck(!String(init?.body).includes(customer)&&!String(init?.body).includes(actors.monthly)&&!String(init?.body).includes(sessions.monthly));
   if(revokeDuringModel){const grant=(await manageReceptionPersonalization(pool,tokens.monthly,'monthly')).grants.find(g=>g.purpose==='context')!;
    await manageReceptionPersonalization(pool,tokens.monthly,'monthly',validateReceptionPersonalizationAction('history-grant',{purpose:'context',enabled:false,expectedRevision:grant.revision}));}
   return Response.json({choices:[{message:{content:'您好，通常两个工作日内发货。'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:30,prompt_tokens_details:{cached_tokens:0}}});
  };
  // Exercise the current unified-model override, not an unsupported persisted
  // provider value or a relaxed business-schema constraint.
  process.env.QWEN_UNIFIED_ENABLED='true';const aiSettings=await getTenantAiSettings('monthly');
  draftCheck(aiSettings.llm_provider==='qwen'&&aiSettings.llm_model==='qwen3.8-flash');
  const input={question:texts.question,context:{channel:'shared_wechat'},policies:[],knowledge:[{title:'合成已核对知识',content:texts.answer}],history:[],businessData:[],deterministicText:'请人工核实。'};
  draftCheck(await prep.current(prepared));
  const draft=await generateReplyDraft(aiSettings,{...input,presentation:prepared.presentation});
  draftCheck(draft.provider==='qwen'&&draft.text==='您好，通常两个工作日内发货。');
  draftCheck(await prep.current(prepared,{rereadHistory:true}));
  draftCheck(await prep.commitProjection(prepared,{text:draft.text,model:draft.model}));
  const persisted=(await owner.query('SELECT state,draft FROM reception_jobs WHERE job_id=$1',[draftJob.job_id])).rows[0];
  draftCheck(persisted.state==='uncertain'&&JSON.stringify(persisted.draft)===JSON.stringify({text:draft.text,model:draft.model}));
  draftCheck(!await prep.current(prepared));
  const revokedJob=await makeJob(),revoked=await prep.prepare(revokedJob);revokeDuringModel=true;
  await generateReplyDraft(aiSettings,{...input,presentation:revoked.presentation});
  draftCheck(!await prep.current(revoked,{rereadHistory:true}));
  draftCheck(!await prep.commitProjection(revoked,{text:'must not persist'}));
  draftCheck((await owner.query('SELECT draft FROM reception_jobs WHERE job_id=$1',[revokedJob.job_id])).rows[0].draft===null);
  draftCheck((await aiPointsOverview('monthly')).monthly_used_micros-balance===322000);
 }finally{globalThis.fetch=originalFetch;}
 const contextGrant=(await manageReceptionPersonalization(pool,tokens.monthly,'monthly')).grants.find(g=>g.purpose==='context')!;
 await manageReceptionPersonalization(pool,tokens.monthly,'monthly',validateReceptionPersonalizationAction('history-grant',{
  purpose:'context',enabled:true,expectedRevision:contextGrant.revision,confirmed:true,disclosureVersion:'reception-history-context-v1'}));
 const changedJob=await makeJob(),changed=await prep.prepare(changedJob);
 if(realNative){await nativeDb!.query("UPDATE messages SET content='Historical question edited during draft generation' WHERE account_id=$1 AND id=$2",[seeds.monthly.account,seeds.monthly.question]);}
 else sourceChanged=true;
 draftCheck(!await prep.current(changed,{rereadHistory:true}));
 const configJob=await makeJob(),configPrepared=await prep.prepare(configJob),currentSettings=(await manageReceptionPersonalization(pool,tokens.monthly,'monthly')).settings;
 await manageReceptionPersonalization(pool,tokens.monthly,'monthly',validateReceptionPersonalizationAction('settings',{
  expectedRevision:currentSettings.revision,draftTone:'concise',automaticTone:'neutral',learnFromHuman:false,timing:{enabled:true,minimumSeconds:1,maximumSeconds:30}}));
 draftCheck(!await prep.current(configPrepared));draftCheck(!await prep.commitProjection(configPrepared,{}));
 await assert.rejects(()=>prep.prepare({...configJob,tenant_id:'credits'}),/unavailable/);draftChecks++;checks++;
 await assert.rejects(()=>prep.prepare({...configJob,customer_id:randomUUID()}),/unavailable/);draftChecks++;checks++;
 const microJob=await makeJob(),microPrepared=await prep.prepare(microJob);
 await owner.query('BEGIN');
 try{
  await owner.query("UPDATE tenant_ai_settings SET automation_updated_at=automation_updated_at+INTERVAL '1 microsecond' WHERE tenant_id='monthly'");
  await owner.query("UPDATE reception_jobs SET authorization_at=authorization_at+INTERVAL '1 microsecond' WHERE job_id=$1",[microJob.job_id]);
  await owner.query('COMMIT');
 }catch(e){await owner.query('ROLLBACK');throw e;}
 draftCheck(!await prep.current(microPrepared));draftCheck(!await prep.commitProjection(microPrepared,{}));
 const bindingJob=await makeJob(),bindingPrepared=await prep.prepare(bindingJob);
 await owner.query('UPDATE channel_identities SET chatwoot_contact_id=99999 WHERE tenant_id=\'monthly\' AND customer_id=$1',[customer]);
 draftCheck(!await prep.current(bindingPrepared));draftCheck(!await prep.commitProjection(bindingPrepared,{}));
 draftCheck(pool.totalCount===pool.idleCount&&draftProviderCalls===2);
 stage='automatic-presentation-journal';const autoCheck=(v:unknown)=>{check(v);automaticPreparationChecks++;};
 await owner.query(automaticReceptionSchemaSql());await owner.query(automaticPresentationSchema);await owner.query(automaticPresentationRuntimeAcl('history_runtime'));
 await owner.query(`GRANT SELECT ON automatic_reception_jobs,automatic_reception_grants TO history_runtime;
  GRANT UPDATE(job_id) ON automatic_reception_jobs TO history_runtime;
  GRANT SELECT,INSERT,UPDATE ON automatic_reception_revisions TO history_runtime;
  GRANT UPDATE(tenant_id) ON automatic_reception_grants,tenant_ai_settings TO history_runtime;`);
 const connection=randomUUID();let sendAuthorization=randomUUID();
 await owner.query("UPDATE channel_identities SET chatwoot_contact_id=$2 WHERE tenant_id='monthly' AND customer_id=$1",[customer,contact]);
 await owner.query("INSERT INTO channel_connections(connection_id,tenant_id,channel_type,display_name,status,configuration) VALUES($1,'monthly','web_chat','Synthetic automatic presentation','ready','{}')",[connection]);
 await owner.query(`INSERT INTO channel_identities(tenant_id,customer_id,channel,external_user_id,chatwoot_contact_id,chatwoot_source_id,chatwoot_conversation_id,channel_connection_id)
  VALUES('monthly',$1,'web_chat','synthetic-automatic-customer',$2,'synthetic',10,$3)`,[customer,contact,connection]);
 await owner.query("UPDATE tenant_ai_settings SET ai_auto_reply_enabled=true,automatic_sending_enabled=true,automation_consent_version='automatic-reply-v1' WHERE tenant_id='monthly'");
 // Synthetic owner-created sending grant. This stage tests presentation leases,
 // NOT real administrator sender setup, native ingress or delivery.
 await owner.query(`INSERT INTO automatic_reception_grants(tenant_id,account_id,authorization_id,consent_version,enabled,actor_id)
  VALUES('monthly',$1,$2,'automatic-send-v1',true,$3)`,[nativeAccount,sendAuthorization,actors.monthly]);
 let autoCounter=3000,contextGate=false,styleGate=false;
 const autoOptions={enabled:()=>enabled,contextEnabled:()=>contextGate,styleEnabled:()=>styleGate};
 const automaticPrep=createAutomaticPresentationPreparation(pool,reader,autoOptions);
 const autoLease=async(createdAt?:Date):Promise<AutomaticReceptionLease>=>{
  const jobId=randomUUID(),workerToken=randomUUID(),messageId=String(autoCounter++);
  await owner.query(`INSERT INTO automatic_reception_jobs(job_id,tenant_id,account_id,conversation_id,message_id,customer_id,channel,connection_id,authorization_id,consent_version,state,worker_token,locked_at,created_at)
   VALUES($1,'monthly',$2,'10',$3,$4,'web_chat',$5,$6,'automatic-send-v1','processing',$7,clock_timestamp(),COALESCE($8::timestamptz,clock_timestamp()))`,[jobId,nativeAccount,messageId,customer,connection,sendAuthorization,workerToken,createdAt??null]);
  return Object.freeze({jobId,tenantId:'monthly',accountId:nativeAccount,conversationId:'10',messageId,customerId:customer,channel:'web_chat',connectionId:connection,
   authorizationId:sendAuthorization,consentVersion:'automatic-send-v1',workerToken});
 };
 const storedCurrent=async(l:AutomaticReceptionLease,q=texts.question,phase:'generation'|'send'='generation')=>{
  const c=await pool.connect();try{await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='3s';SET LOCAL lock_timeout='500ms'");
   const ok=await currentStoredAutomaticPresentation(c,l,q,autoOptions,phase);await c.query('COMMIT');return ok;
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 };
 const presetView=(await manageReceptionPersonalization(pool,tokens.monthly,'monthly')).settings;
 await manageReceptionPersonalization(pool,tokens.monthly,'monthly',validateReceptionPersonalizationAction('settings',{
  expectedRevision:presetView.revision,draftTone:'concise',automaticTone:'friendly_detailed',learnFromHuman:false,timing:{enabled:true,minimumSeconds:2,maximumSeconds:30}}));
 const auto=await autoLease(),beforeAutomaticRead=nativeCalls,automaticPrepared=await automaticPrep.prepare(auto,texts.question);
 autoCheck(automaticPrepared.data.tone==='friendly_detailed'&&automaticPrepared.data.context.length===0&&nativeCalls===beforeAutomaticRead);
 autoCheck(automaticPrepared.timing.minimumSeconds===2&&automaticPrepared.timing.maximumSeconds===30&&automaticPrepared.timing.enabled);
 autoCheck(await automaticPrep.current(automaticPrepared)&&await storedCurrent(auto));
 autoCheck(!await storedCurrent(auto,'不同的问题')&&!await storedCurrent({...auto,customerId:randomUUID()}));
 autoCheck(!await storedCurrent({...auto,tenantId:'credits'})&&!await storedCurrent({...auto,workerToken:randomUUID()}));
 await assert.rejects(()=>automaticPrep.prepare(auto,texts.question),/^Error: automatic_presentation_unavailable$/);checks++;automaticPreparationChecks++;
 const journal=(await pool.query('SELECT * FROM automatic_reception_presentations WHERE job_id=$1',[auto.jobId])).rows[0];
 autoCheck(journal.settings_revision>0&&journal.context_grant_id===null&&journal.history_digest===null&&journal.style_grant_id===null);
 autoCheck(!JSON.stringify(journal).includes(texts.question)&&!JSON.stringify(journal).includes('masked@example.invalid')&&!JSON.stringify(journal).includes('Synthetic masked customer'));
 const acl=(await pool.query(`SELECT has_table_privilege(current_user,'automatic_reception_presentations','SELECT') r,
  has_table_privilege(current_user,'automatic_reception_presentations','INSERT') i,has_table_privilege(current_user,'automatic_reception_presentations','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') bad,
  has_schema_privilege(current_user,'public','CREATE') ddl`)).rows[0];autoCheck(acl.r&&acl.i&&!acl.bad&&!acl.ddl);
 for(const sql of ["UPDATE automatic_reception_presentations SET tone='concise' WHERE job_id=$1",'DELETE FROM automatic_reception_presentations WHERE job_id=$1']){
  await assert.rejects(()=>pool.query(sql,[auto.jobId]),(e:any)=>e.code==='42501');checks++;automaticPreparationChecks++;
  await assert.rejects(()=>owner.query(sql,[auto.jobId]),/immutable/);checks++;automaticPreparationChecks++;
 }
 await assert.rejects(()=>pool.query('TRUNCATE automatic_reception_presentations'),(e:any)=>e.code==='42501');checks++;automaticPreparationChecks++;
 await assert.rejects(()=>owner.query('TRUNCATE automatic_reception_presentations'),/immutable/);checks++;automaticPreparationChecks++;
 contextGate=true;autoCheck(!await automaticPrep.current(automaticPrepared)&&!await storedCurrent(auto));
 const contextLease=await autoLease(),automaticContext=await automaticPrep.prepare(contextLease,texts.question);
 autoCheck(automaticContext.data.context.length===2&&automaticContext.data.tone==='friendly_detailed');
 autoCheck(!JSON.stringify(automaticContext).includes(customer)&&!JSON.stringify(automaticContext).includes(actors.monthly));
 autoCheck(await automaticPrep.current(automaticContext,true)&&await storedCurrent(contextLease));
 if(realNative)await nativeDb!.query("UPDATE messages SET content='Changed historical answer during automatic preparation' WHERE account_id=$1 AND id=$2",[seeds.monthly.account,seeds.monthly.answer]);
 else sourceChanged=!sourceChanged;
 autoCheck(!await automaticPrep.current(automaticContext,true));
 const revokeLease=await autoLease(),revokePrepared=await automaticPrep.prepare(revokeLease,texts.question);
 const revokeContext=(await manageReceptionPersonalization(pool,tokens.monthly,'monthly')).grants.find(g=>g.purpose==='context')!;
 await manageReceptionPersonalization(pool,tokens.monthly,'monthly',validateReceptionPersonalizationAction('history-grant',{
  purpose:'context',enabled:false,expectedRevision:revokeContext.revision}));
 autoCheck(!await automaticPrep.current(revokePrepared)&&!await storedCurrent(revokeLease));
 contextGate=false;const finalLease=await autoLease(),finalPrepared=await automaticPrep.prepare(finalLease,texts.question);
 await owner.query(`UPDATE automatic_reception_jobs SET draft=$2,draft_hash=$3 WHERE job_id=$1`,[finalLease.jobId,JSON.stringify({text:'Synthetic not sent'}),'a'.repeat(64)]);
 await owner.query("UPDATE automatic_reception_jobs SET state='submitting' WHERE job_id=$1",[finalLease.jobId]);
 autoCheck(!await automaticPrep.current(finalPrepared)&&!await storedCurrent(finalLease)&&await storedCurrent(finalLease,texts.question,'send'));
 const revised=(await manageReceptionPersonalization(pool,tokens.monthly,'monthly')).settings;
 await manageReceptionPersonalization(pool,tokens.monthly,'monthly',validateReceptionPersonalizationAction('settings',{
  expectedRevision:revised.revision,draftTone:'neutral',automaticTone:'concise',learnFromHuman:false,timing:{enabled:false,minimumSeconds:1,maximumSeconds:30}}));
 autoCheck(!await storedCurrent(finalLease,texts.question,'send'));
 const beforeStyleView=await manageReceptionPersonalization(pool,tokens.monthly,'monthly'),oldStyle=beforeStyleView.grants.find(g=>g.purpose==='style');
 await manageReceptionPersonalization(pool,tokens.monthly,'monthly',validateReceptionPersonalizationAction('history-grant',{
  purpose:'style',enabled:true,expectedRevision:oldStyle?.revision??'0',confirmed:true,disclosureVersion:'reception-history-style-v1'}));
 await manageReceptionPersonalization(pool,tokens.monthly,'monthly',validateReceptionPersonalizationAction('settings',{
  expectedRevision:beforeStyleView.settings.revision,draftTone:'concise',automaticTone:'neutral',learnFromHuman:true,timing:{enabled:true,minimumSeconds:1,maximumSeconds:30}}));
 const styleState=(await pool.query(`SELECT s.revision::text,g.grant_id FROM reception_personalization_settings s JOIN reception_history_grants g USING(tenant_id)
  WHERE s.tenant_id='monthly' AND g.purpose='style'`)).rows[0];
 const finiteStyle={status:'suggestion',tone:'friendly_detailed',sampleMessages:9,sampleConversations:3,medianReplyCharacters:20,politeGreetingRate:1,friendlyMarkerRate:1,emojiRate:0};
 // Finite synthetic cache only: common style sampling is covered by its own
 // worker fixture. No fabricated raw human/agent transcript in this stage.
 await owner.query(`INSERT INTO reception_learned_styles(tenant_id,style,sample_digest,observed_at,expires_at,profile_grant_id,profile_account_id,profile_settings_revision,next_attempt_at)
  VALUES('monthly',$1,$2,clock_timestamp(),clock_timestamp()+INTERVAL '1 day',$3,$4,$5,clock_timestamp()+INTERVAL '1 day') ON CONFLICT(tenant_id) DO UPDATE
   SET style=EXCLUDED.style,sample_digest=EXCLUDED.sample_digest,observed_at=EXCLUDED.observed_at,expires_at=EXCLUDED.expires_at,
    profile_grant_id=EXCLUDED.profile_grant_id,profile_account_id=EXCLUDED.profile_account_id,profile_settings_revision=EXCLUDED.profile_settings_revision`,
  [finiteStyle,'b'.repeat(64),styleState.grant_id,nativeAccount,styleState.revision]);
 styleGate=true;const learnedLease=await autoLease(),learned=await automaticPrep.prepare(learnedLease,texts.question);
 autoCheck(learned.data.tone==='friendly_detailed'&&learned.data.context.length===0&&await storedCurrent(learnedLease));
 const finiteJournal=(await pool.query('SELECT style_grant_id,style_digest FROM automatic_reception_presentations WHERE job_id=$1',[learnedLease.jobId])).rows[0];
 autoCheck(finiteJournal.style_grant_id===styleState.grant_id&&/^[a-f0-9]{64}$/.test(finiteJournal.style_digest)&&!JSON.stringify(learned).includes(styleState.grant_id));
 await owner.query("UPDATE reception_learned_styles SET observed_at=clock_timestamp()-INTERVAL '2 days',expires_at=clock_timestamp()-INTERVAL '1 second' WHERE tenant_id='monthly'");
 autoCheck(!await automaticPrep.current(learned));
 const insufficientLease=await autoLease(),insufficient=await automaticPrep.prepare(insufficientLease,texts.question);
 autoCheck(insufficient.data.tone==='neutral'&&await automaticPrep.current(insufficient));
 const currentStyle=(await manageReceptionPersonalization(pool,tokens.monthly,'monthly')).grants.find(g=>g.purpose==='style')!;
 await manageReceptionPersonalization(pool,tokens.monthly,'monthly',validateReceptionPersonalizationAction('history-grant',{
  purpose:'style',enabled:false,expectedRevision:currentStyle.revision}));
 autoCheck(!await automaticPrep.current(insufficient));
 const staleLease=await autoLease(),stalePrepared=await automaticPrep.prepare(staleLease,texts.question);
 await owner.query("UPDATE automatic_reception_jobs SET locked_at=clock_timestamp()-INTERVAL '3 minutes' WHERE job_id=$1",[staleLease.jobId]);
 autoCheck(!await automaticPrep.current(stalePrepared));
 const lastLease=await autoLease(),lastPrepared=await automaticPrep.prepare(lastLease,texts.question);
 await owner.query("UPDATE automatic_reception_grants SET enabled=false WHERE tenant_id='monthly'");autoCheck(!await automaticPrep.current(lastPrepared));
 autoCheck(pool.totalCount===pool.idleCount);
 stage='automatic-presentation-generation';const generationCheck=(v:unknown)=>{check(v);automaticGenerationChecks++;};
 await owner.query(automaticSemanticVerificationSchema);
 await owner.query(`GRANT SELECT,INSERT,UPDATE ON automatic_reception_generations,automatic_reception_verifications TO history_runtime;
  GRANT SELECT ON automatic_reception_answers,temporary_policies TO history_runtime;
  GRANT SELECT,INSERT,UPDATE ON automatic_reception_revisions TO history_runtime;`);
 await owner.query("UPDATE automatic_reception_grants SET enabled=true WHERE tenant_id='monthly'");
 await owner.query(`UPDATE knowledge_documents SET ingestion_status='ready',parse_status='parsed',scan_status='not_required' WHERE document_id=$1`,[receipt.documentId]);
 const approvedAnswer=randomUUID();await owner.query(`INSERT INTO automatic_reception_answers(answer_id,tenant_id,document_id,document_version,topic,answer_text,keywords,question_texts,
  status,approval_version,approved_by,requires_human_approval,valid_from,valid_until) VALUES($1,'monthly',$2,1,'shipping_information',$3,ARRAY['发货'],ARRAY[$4],
  'approved','approved-exact-answer-v1',$5,false,clock_timestamp()-INTERVAL '1 hour',clock_timestamp()+INTERVAL '1 day')`,
  [approvedAnswer,receipt.documentId,texts.answer,texts.question,actors.monthly]);
 // No new production consent: these are the fixture's actual authenticated
 // synthetic admin/grant APIs, bound to its isolated account and customer.
 const restoreContext=async()=>{
  const g=(await manageReceptionPersonalization(pool,tokens.monthly,'monthly')).grants.find(g=>g.purpose==='context')!;
  if(!g.enabled)await manageReceptionPersonalization(pool,tokens.monthly,'monthly',validateReceptionPersonalizationAction('history-grant',{
   purpose:'context',enabled:true,expectedRevision:g.revision,confirmed:true,disclosureVersion:'reception-history-context-v1'}));
 };
 await restoreContext();contextGate=true;styleGate=false;
 process.env.AI_RECEPTION_AUTOMATIC_PRESENTATION_ENABLED='true';process.env.AI_RECEPTION_SEMANTIC_ANSWERS_ENABLED='true';
 process.env.AI_RECEPTION_HISTORY_READ_ENABLED='true';process.env.AI_RECEPTION_HISTORY_CONTEXT_ENABLED='true';
 let automaticBehavior='success';
 const automaticModel=async(messages:{role:'system'|'user';content:string}[],maxTokens:number,json=false)=>qwenText(messages,maxTokens,async(url,init)=>{
  automaticProviderCalls++;
  if(concurrentGenerationProbe)concurrentGlobalSqlObservationsOmitted++;
  else if(nativeWaitStarted)generationCheck(Number((await root.query(receptionFixtureSqlGuards)).rows[0].n)===0);
  else generationCheck(pool.totalCount===pool.idleCount);
  generationCheck(url==='https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions'&&init?.redirect==='error');
  const body=JSON.parse(String(init?.body)),data=JSON.parse(body.messages.at(-1).content),verifying=body.messages[0].content.includes('独立的客服来源核验器');
  generationCheck(body.model==='qwen3.8-flash'&&body.max_tokens===1500&&body.response_format.type==='json_object');
  generationCheck(!String(init?.body).includes(customer)&&!String(init?.body).includes(actors.monthly)&&!String(init?.body).includes(sessions.monthly));
  generationCheck(data.sources.length===1&&data.sources[0].text===texts.answer&&!String(init?.body).includes('chunkId'));
  let output:string;
  if(verifying){
   generationCheck(!('presentation' in data)&&!String(init?.body).includes('已隐藏')&&!String(init?.body).includes('Changed historical'));
   if(automaticBehavior==='source-change')await owner.query("UPDATE knowledge_documents SET version=version+1 WHERE document_id=$1",[receipt.documentId]);
   const passed=automaticBehavior!=='negative-verdict';
   output=JSON.stringify({question_answered:true,all_claims_supported:passed,conditions_preserved:true,no_conflict:true,
    claims:data.claims.map((p:any,n:number)=>({index:n,source_index:p.source_index,quote_hash:p.quote_hash,supported:passed}))});
  }else{
   generationCheck(body.messages.length===3&&(nativeWaitStarted?data.presentation.context.length>=2&&data.presentation.context.length<=12:data.presentation.context.length===2)&&data.presentation.tone==='neutral');
   generationCheck(!String(init?.body).includes('masked@example.invalid')&&!String(init?.body).includes('13800138000'));
   if(automaticBehavior==='revoke-context'){
    const g=(await manageReceptionPersonalization(pool,tokens.monthly,'monthly')).grants.find(g=>g.purpose==='context')!;
    await manageReceptionPersonalization(pool,tokens.monthly,'monthly',validateReceptionPersonalizationAction('history-grant',{
     purpose:'context',enabled:false,expectedRevision:g.revision}));
   }
   if(automaticBehavior==='change-config'){
    const s=(await manageReceptionPersonalization(pool,tokens.monthly,'monthly')).settings;
    await manageReceptionPersonalization(pool,tokens.monthly,'monthly',validateReceptionPersonalizationAction('settings',{
     expectedRevision:s.revision,draftTone:s.draftTone,automaticTone:s.automaticTone,learnFromHuman:false,
     timing:{enabled:false,minimumSeconds:2,maximumSeconds:30}}));
   }
   const text=automaticBehavior==='bad-number'?'您好，通常三个工作日内发货。':automaticBehavior==='verbatim'?texts.answer:'您好，'+texts.answer;
   output=JSON.stringify({answer:text,claims:[{text,source_index:0,quote:texts.answer}]});
  }
  return Response.json({choices:[{message:{content:output},finish_reason:'stop'}],
   ...(automaticBehavior==='missing-usage'?{}:{usage:{prompt_tokens:100,completion_tokens:30,prompt_tokens_details:{cached_tokens:0}}})});
 },json);
 const automaticPorts={enabled:()=>enabled,pointsEnabled:()=>true,configured:()=>true,
  reserve:(tenant:string,key:string,input:number,output:number)=>reserveAiPoints(tenant,key,'copilot',input,output),settle:settleAiPoints,model:automaticModel};
 const verify=createMeteredAutomaticSemanticVerifier(pool,automaticPorts,autoOptions);
 const generator=createMeteredAutomaticGenerator(pool,automaticPorts,{enabled:()=>enabled,retrieve:async()=>{throw Error('exact source must not invent a semantic retrieval');},verify},
  {enabled:()=>enabled,preparation:automaticPrep});
 const finalAssessment=async(l:AutomaticReceptionLease,d:any,phase:'generation'|'send'='generation')=>{
  const c=await pool.connect();try{await c.query('BEGIN');const a=await assessStoredAutomaticEvidence(c,l,d,texts.question,{lock:true,phase});await c.query('COMMIT');return a;
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 };
 const successLease=await autoLease(),automaticBalance=(await aiPointsOverview('monthly')).monthly_used_micros;
 const success=await generator(successLease,texts.question);
 generationCheck(success.generated&&success.evidenceCandidate&&!success.requiresHumanApproval&&success.text==='您好，'+texts.answer);
 generationCheck(automaticProviderCalls===2&&(await aiPointsOverview('monthly')).monthly_used_micros-automaticBalance===322000);
 const final=await finalAssessment(successLease,success);generationCheck(final.evidenceCandidate&&final.reason==='approved_grounded_presentation'&&final.answerIds.includes(approvedAnswer)&&final.documentIds.includes(receipt.documentId!));
 const generationJournal=(await pool.query('SELECT reason,state FROM automatic_reception_generations WHERE job_id=$1',[successLease.jobId])).rows[0];
 generationCheck(generationJournal.reason==='exact_styled_generated'&&generationJournal.state==='succeeded');
 const verifierJournal=(await pool.query('SELECT * FROM automatic_reception_verifications WHERE job_id=$1',[successLease.jobId])).rows[0];
 generationCheck(verifierJournal.state==='succeeded'&&verifierJournal.reason==='verified'&&!JSON.stringify(verifierJournal).includes(texts.answer));
 const beforeRepeat=automaticProviderCalls;generationCheck((await generator(successLease,texts.question)).fallback&&automaticProviderCalls===beforeRepeat);
 generationCheck(!(await finalAssessment({...successLease,tenantId:'credits'},success)).evidenceCandidate);
 await owner.query('UPDATE automatic_reception_jobs SET draft=$2,draft_hash=$3 WHERE job_id=$1',[successLease.jobId,JSON.stringify(success),createHash('sha256').update(success.text).digest('hex')]);
 await owner.query("UPDATE automatic_reception_jobs SET state='submitting' WHERE job_id=$1",[successLease.jobId]);
 generationCheck((await finalAssessment(successLease,success,'send')).evidenceCandidate);
 generationCheck(!(await finalAssessment(successLease,success)).evidenceCandidate);
 const beforeSubmitted=automaticProviderCalls;generationCheck((await generator(successLease,texts.question)).fallback&&automaticProviderCalls===beforeSubmitted);
 process.env.AI_RECEPTION_AUTOMATIC_PRESENTATION_ENABLED='false';generationCheck(!(await finalAssessment(successLease,success,'send')).evidenceCandidate);
 process.env.AI_RECEPTION_AUTOMATIC_PRESENTATION_ENABLED='true';
 for(const mode of ['bad-number','revoke-context','change-config','negative-verdict','missing-usage']){
  automaticBehavior=mode;await restoreContext();const l=await autoLease(),beforeCalls=automaticProviderCalls;
  const d=await generator(l,texts.question);generationCheck(d.requiresHumanApproval&&!d.evidenceCandidate);
  generationCheck(automaticProviderCalls-beforeCalls===(mode==='negative-verdict'?2:1));
  generationCheck(!(await finalAssessment(l,d)).evidenceCandidate);
  const prior=automaticProviderCalls;generationCheck((await generator(l,texts.question)).fallback&&automaticProviderCalls===prior);
  if(mode==='missing-usage'){
   const uncertain=(await pool.query(`SELECT g.state,b.status FROM automatic_reception_generations g JOIN ai_usage_calls b ON b.call_id=g.call_id WHERE g.job_id=$1`,[l.jobId])).rows[0];
   generationCheck(uncertain.state==='uncertain'&&uncertain.status!=='succeeded');
  }
 }
 await restoreContext();automaticBehavior='verbatim';const verbatimLease=await autoLease(),verbatim=await generator(verbatimLease,texts.question);
 generationCheck(verbatim.evidenceCandidate&&verbatim.text===texts.answer);
 const vgrant=(await manageReceptionPersonalization(pool,tokens.monthly,'monthly')).grants.find(g=>g.purpose==='context')!;
 await manageReceptionPersonalization(pool,tokens.monthly,'monthly',validateReceptionPersonalizationAction('history-grant',{
  purpose:'context',enabled:false,expectedRevision:vgrant.revision}));
 generationCheck(!(await finalAssessment(verbatimLease,verbatim)).evidenceCandidate); // exact-copy policy cannot bypass revocation
 await restoreContext();
 const waitSettings=(await manageReceptionPersonalization(pool,tokens.monthly,'monthly')).settings;
 await manageReceptionPersonalization(pool,tokens.monthly,'monthly',validateReceptionPersonalizationAction('settings',{
  expectedRevision:waitSettings.revision,draftTone:waitSettings.draftTone,automaticTone:waitSettings.automaticTone,learnFromHuman:false,
  timing:{enabled:true,minimumSeconds:1,maximumSeconds:30}}));
 automaticBehavior='success';const raceLease=await autoLease(),beforeRace=automaticProviderCalls;
 let race:Awaited<ReturnType<typeof generator>>[];
 concurrentGenerationProbe=true;
 try{race=await Promise.all([generator(raceLease,texts.question),generator(raceLease,texts.question)]);}finally{concurrentGenerationProbe=false;}
 generationCheck(race.filter(d=>d.evidenceCandidate).length===1&&automaticProviderCalls-beforeRace===2);
 const raceReceipts=(await pool.query(`SELECT g.state,g.reason,b.status billed,
  (SELECT count(*) FROM ai_usage_calls WHERE tenant_id=g.tenant_id AND request_key=g.request_key) generation_calls,
  (SELECT count(*) FROM automatic_reception_verifications WHERE job_id=g.job_id AND state='succeeded') verifier_receipts
  FROM automatic_reception_generations g JOIN ai_usage_calls b ON b.call_id=g.call_id WHERE g.job_id=$1`,[raceLease.jobId])).rows;
 generationCheck(raceReceipts.length===1&&raceReceipts[0].state==='succeeded'&&raceReceipts[0].billed==='succeeded'&&
  Number(raceReceipts[0].generation_calls)===1&&Number(raceReceipts[0].verifier_receipts)===1);
 stage='automatic-durable-wait';const waitCheck=(v:unknown)=>{assert.ok(v,'wait_check_'+automaticWaitChecks);checks++;automaticWaitChecks++;};
 await owner.query(automaticReplyWaitSchema);await owner.query(automaticReplyWaitRuntimeAcl('history_runtime'));
 await owner.query('GRANT UPDATE(state,worker_token,locked_at,draft,draft_hash,reason,receipt,updated_at) ON automatic_reception_jobs TO history_runtime');
 await owner.query('GRANT SELECT,UPDATE(connection_id) ON channel_connections TO history_runtime;GRANT UPDATE(identity_id) ON channel_identities TO history_runtime');
 const frozenAnswer=race.find(d=>d.evidenceCandidate)!;
 await saveAutomaticDraft(pool,raceLease,frozenAnswer);
 const waitBalance=(await aiPointsOverview('monthly')).monthly_used_micros,waitModels=automaticProviderCalls;
 waitCheck(await persistAutomaticReplyWait(pool,raceLease,frozenAnswer,texts.question,autoOptions));
 const persisted=(await pool.query('SELECT * FROM automatic_reply_waits WHERE job_id=$1',[raceLease.jobId])).rows[0];
 const originalJob=(await pool.query('SELECT created_at,worker_token,state,draft FROM automatic_reception_jobs WHERE job_id=$1',[raceLease.jobId])).rows[0];
 const plan=planReceptionSendTiming(frozenAnswer.text,new Date(originalJob.created_at).getTime(),Date.now());
 waitCheck(new Date(persisted.due_at).getTime()===plan.dueAtMs&&persisted.state==='waiting');
 waitCheck(originalJob.state==='processing'&&originalJob.worker_token===raceLease.workerToken);
 await assert.rejects(()=>owner.query("UPDATE automatic_reception_jobs SET state='submitting' WHERE job_id=$1",[raceLease.jobId]),/final barrier denied/);automaticWaitChecks++;checks++;
 waitCheck(!JSON.stringify(persisted).includes(texts.answer)&&!JSON.stringify(persisted).includes(texts.question));
 await assert.rejects(()=>persistAutomaticReplyWait(pool,raceLease,frozenAnswer,texts.question,autoOptions),/already_prepared/);automaticWaitChecks++;checks++;
 await assert.rejects(()=>persistAutomaticReplyWait(pool,{...raceLease,tenantId:'credits'},frozenAnswer,texts.question,autoOptions),/changed/);automaticWaitChecks++;checks++;
 await assert.rejects(()=>persistAutomaticReplyWait(pool,raceLease,{...frozenAnswer,text:'Changed frozen answer'},texts.question,autoOptions),/changed/);automaticWaitChecks++;checks++;
 for(const sql of ['UPDATE automatic_reply_waits SET due_at=clock_timestamp() WHERE job_id=$1','DELETE FROM automatic_reply_waits WHERE job_id=$1']){
  await assert.rejects(()=>pool.query(sql,[raceLease.jobId]),(e:any)=>e.code==='42501');automaticWaitChecks++;checks++;
  await assert.rejects(()=>owner.query(sql,[raceLease.jobId]),/immutable/);automaticWaitChecks++;checks++;
 }
 await assert.rejects(()=>owner.query('TRUNCATE automatic_reply_waits'),/immutable/);automaticWaitChecks++;checks++;
 waitCheck(await claimDueAutomaticReply(pool,'wechat')===null);
 // Real clock wait, no trigger bypass or forged deadline. Long waits aren't
 // production worker sleeps: this is solely the bounded isolated test runner.
 const untilDue=Number((await pool.query('SELECT (EXTRACT(EPOCH FROM (due_at-clock_timestamp()))*1000)::float8 remaining FROM automatic_reply_waits WHERE job_id=$1',[raceLease.jobId])).rows[0].remaining);
 if(untilDue>1000)waitCheck(await claimDueAutomaticReply(pool,'web')===null);
 await waitForFixtureDatabaseDue(pool,raceLease.jobId);
 const claims=await Promise.all([claimDueAutomaticReply(pool,'web'),claimDueAutomaticReply(pool,'web')]);
 waitCheck(claims.filter(Boolean).length===1);const claimed=claims.find(Boolean)!;
 waitCheck(claimed.lease.workerToken===raceLease.workerToken&&JSON.stringify(claimed.draft)===JSON.stringify(originalJob.draft));
 waitCheck(await claimDueAutomaticReply(pool,'web')===null); // no claim replay after restart
 const freshPrep=createAutomaticPresentationPreparation(pool,reader,autoOptions);
 waitCheck(await freshPrep.currentStored(claimed.lease,texts.question)); // no in-memory preparation required
 waitCheck(!await freshPrep.currentStored({...claimed.lease,customerId:randomUUID()},texts.question));
 const originalHistory=realNative?(await nativeDb!.query('SELECT content FROM messages WHERE account_id=$1 AND id=$2',[seeds.monthly.account,seeds.monthly.answer])).rows[0].content:null;
 if(realNative)await nativeDb!.query("UPDATE messages SET content=content||' changed while waiting' WHERE account_id=$1 AND id=$2",[seeds.monthly.account,seeds.monthly.answer]);
 else sourceChanged=!sourceChanged;
 waitCheck(!await freshPrep.currentStored(claimed.lease,texts.question));
 if(realNative)await nativeDb!.query('UPDATE messages SET content=$3 WHERE account_id=$1 AND id=$2',[seeds.monthly.account,seeds.monthly.answer,originalHistory]);
 else sourceChanged=!sourceChanged;
 waitCheck(await freshPrep.currentStored(claimed.lease,texts.question));
 await assert.rejects(()=>owner.query("UPDATE automatic_reply_waits SET state='waiting',dispatch_token=NULL,claimed_at=NULL WHERE job_id=$1",[raceLease.jobId]),/immutable|transition/);automaticWaitChecks++;checks++;
 const waitFacts:AutomaticReplyFacts={executorAvailable:true,consentVersion:AUTOMATIC_REPLY_CONSENT_VERSION,sendConsentVersion:AUTOMATIC_SEND_CONSENT_VERSION,
  tenantActive:true,generateEnabled:true,sendEnabled:true,latestCustomerMessage:true,humanResponded:false,channelReplyable:true,
  pointsAvailable:true,generated:false,fallback:false,requiresHumanApproval:false,evidenceCandidate:false,confidencePercent:0,thresholdPercent:90};
 let humanDuringWait=false;
 const dispatchAdapter:AutomaticReceptionAdapter={enabled:()=>enabled,facts:async()=>({...waitFacts,humanResponded:humanDuringWait}),
  generate:async()=>{throw Error('waiting answer must not regenerate');},assess:(l,d)=>finalAssessment(l,d),
  authorize:async(c,l,d)=>({facts:{...waitFacts,humanResponded:humanDuringWait},assessment:await assessStoredAutomaticEvidence(c,l,d,texts.question,{lock:true})}),
  // Synthetic boundary stub. Actual original sender/native HTTP fence is NOT
  // exercised in this stage; no real customer/public message is sent.
  submit:async()=>{syntheticDispatchCalls++;return {outcome:'accepted',receipt:{provider:'web_chat',acknowledged:true,providerMessageId:'synthetic_wait_ack'}};}};
 const resumedState=await resumeStoredAutomaticReception(pool,claimed.lease,claimed.draft,dispatchAdapter);
 if(resumedState!=='accepted')console.error(JSON.stringify({status:'isolated_wait_resume_failed',state:resumedState,
  details:(await pool.query('SELECT j.state,j.reason,clock_timestamp()>w.expires_at expired FROM automatic_reception_jobs j JOIN automatic_reply_waits w USING(job_id) WHERE j.job_id=$1',[claimed.lease.jobId])).rows[0]}));
 waitCheck(resumedState==='accepted');
 await finishAutomaticReplyWait(pool,claimed,'accepted');waitCheck(syntheticDispatchCalls===1);
 const finished=(await pool.query('SELECT state,dispatch_token FROM automatic_reply_waits WHERE job_id=$1',[raceLease.jobId])).rows[0];
 waitCheck(finished.state==='finished'&&finished.dispatch_token===claimed.dispatchToken&&await claimDueAutomaticReply(pool,'web')===null);
 // Restart waiting jobs due already: owner seeds their ORIGINAL receipt time
 // on INSERT, never edits immutable stored deadlines. No extra model required
 // for cancellation tests; these saved drafts have no fabricated verifier.
 const makeWaiting=async()=>{const l=await autoLease(new Date(Date.now()-60000));await automaticPrep.prepare(l,texts.question);
  await saveAutomaticDraft(pool,l,frozenAnswer);await persistAutomaticReplyWait(pool,l,frozenAnswer,texts.question,autoOptions);return l;};
 const humanLease=await makeWaiting();humanDuringWait=true;
 const restarted=createAutomaticReplyWaitRuntime(pool,{enabled:()=>enabled,family:'web',adapter:dispatchAdapter,presentationOptions:autoOptions,
  question:async()=>texts.question,currentPresentation:(l,q)=>freshPrep.currentStored(l,q)});
 waitCheck(await restarted.tick()===1);await restarted.stop();
 const humanResult=(await pool.query('SELECT state,reason FROM automatic_reception_jobs WHERE job_id=$1',[humanLease.jobId])).rows[0];
 waitCheck(humanResult.state==='skipped'&&humanResult.reason==='reply_wait_conditions_changed'&&syntheticDispatchCalls===1);
 humanDuringWait=false;const revokedLease=await makeWaiting();
 const currentContext=(await manageReceptionPersonalization(pool,tokens.monthly,'monthly')).grants.find(g=>g.purpose==='context')!;
 await manageReceptionPersonalization(pool,tokens.monthly,'monthly',validateReceptionPersonalizationAction('history-grant',{
  purpose:'context',enabled:false,expectedRevision:currentContext.revision}));
 const revokeDispatcher=createAutomaticReplyWaitRuntime(pool,{enabled:()=>enabled,family:'web',adapter:dispatchAdapter,presentationOptions:autoOptions,
  question:async()=>texts.question,currentPresentation:(l,q)=>freshPrep.currentStored(l,q)});
 waitCheck(await revokeDispatcher.tick()===1);await revokeDispatcher.stop();
 waitCheck((await pool.query('SELECT state FROM automatic_reception_jobs WHERE job_id=$1',[revokedLease.jobId])).rows[0].state==='skipped'&&syntheticDispatchCalls===1);
 await restoreContext();const crashedLease=await makeWaiting(),crashed=await claimDueAutomaticReply(pool,'web');
 waitCheck(crashed?.lease.jobId===crashedLease.jobId&&await claimDueAutomaticReply(pool,'web')===null);
 waitCheck(await expireAutomaticReplyWaits(pool)===0); // no immediate reclaim/retry of a claimed attempt
 const lateLease=await makeWaiting();await waitForFixtureDatabaseDue(pool,lateLease.jobId,'expires');
 waitCheck(await claimDueAutomaticReply(pool,'web')===null);waitCheck(await expireAutomaticReplyWaits(pool)===1);
 const expired=(await pool.query('SELECT j.state,w.state wait_state,j.reason FROM automatic_reception_jobs j JOIN automatic_reply_waits w USING(job_id) WHERE j.job_id=$1',[lateLease.jobId])).rows[0];
 waitCheck(expired.state==='skipped'&&expired.wait_state==='expired'&&expired.reason==='reply_wait_expired');
 waitCheck(automaticProviderCalls===waitModels&&(await aiPointsOverview('monthly')).monthly_used_micros===waitBalance&&syntheticDispatchCalls===1);
 waitCheck(pool.totalCount===pool.idleCount);
 if(nativeWait){
  await owner.query(automaticSemanticSchemaSql());await owner.query(automaticSemanticRuntimeAcl('history_runtime'));
  nativeWaitStarted=true;
  const result=await testReplyWaitNative({db:pool,owner,nativeDb:nativeDb!,root,
   seed:JSON.parse(readFileSync('/fixture/reply-wait-seed.json','utf8')) as ReplyWaitNativeSeed,customer,actor:actors.monthly!,connection,secret,
   question:texts.question,answer:'您好，'+texts.answer,models:()=>automaticProviderCalls,balance:async()=>(await aiPointsOverview('monthly')).monthly_used_micros,
   generate:generator,presentation:()=>({presentationOptions:autoOptions,currentPresentation:createAutomaticPresentationPreparation(pool,reader,autoOptions).currentStored}),
   stage:s=>{stage=s;}});
  automaticNativeWaitChecks=result.checks;automaticNativePublicMessages=result.publicMessages;automaticNativeSubmitCalls=result.submitCalls;checks+=result.checks;
  const wechat=await testWechatWaitNative({db:pool,owner,nativeDb:nativeDb!,root,
   seed:JSON.parse(readFileSync('/fixture/wechat-wait-seed.json','utf8')) as WechatWaitSeed,customer,actor:actors.monthly!,token:tokens.monthly!,secret,
   question:texts.question,answer:'您好，'+texts.answer,models:()=>automaticProviderCalls,balance:async()=>(await aiPointsOverview('monthly')).monthly_used_micros,
   generate:generator,presentation:()=>({presentationOptions:autoOptions,currentPresentation:createAutomaticPresentationPreparation(pool,reader,autoOptions).currentStored}),
   stage:s=>{stage=s;}});
  wechatNativeWaitChecks=wechat.checks;wechatSimulatedProviderRequests=wechat.providerRequests;wechatNativePermitCalls=wechat.permitCalls;
  wechatNativeHistoryMessages=wechat.historyMessages;checks+=wechat.checks;
  const shared=await testSharedWaitNative({db:pool,owner,nativeDb:nativeDb!,root,
   seeds:JSON.parse(readFileSync('/fixture/shared-wait-seed.json','utf8')) as SharedWaitSeed[],customer,actor:actors.monthly!,token:tokens.monthly!,secret,
   question:texts.question,answer:'您好，'+texts.answer,models:()=>automaticProviderCalls,balance:async()=>(await aiPointsOverview('monthly')).monthly_used_micros,
   generate:generator,presentation:()=>({presentationOptions:autoOptions,currentPresentation:createAutomaticPresentationPreparation(pool,reader,autoOptions).currentStored}),
   stage:s=>{stage=s;}});
  sharedNativeWaitChecks=shared.checks;sharedSimulatedProviderRequests=shared.providerRequests;sharedNativePermitCalls=shared.permitCalls;
  sharedNativeHistoryMessages=shared.historyMessages;checks+=shared.checks;
  const semantic=await testSemanticWaitNative({db:pool,owner,nativeDb:nativeDb!,root,
   seed:JSON.parse(readFileSync('/fixture/reply-wait-seed.json','utf8')) as ReplyWaitNativeSeed,customer,connection,secret,token:tokens.monthly!,reader,
   presentationOptions:autoOptions,stage:s=>{stage=s;}});
  semanticNativeWaitChecks=semantic.checks;semanticEmbeddingCalls=semantic.embeds;semanticGenerationCalls=semantic.generates;
  semanticVerificationCalls=semantic.verifies;semanticNativePublicMessages=semantic.publicMessages;semanticChargedMicros=semantic.chargedMicros;checks+=semantic.checks;
  sendAuthorization=semantic.authorizationId;
 }
 automaticBehavior='source-change';const sourceLease=await autoLease(),changedSource=await generator(sourceLease,texts.question);
 generationCheck(!changedSource.evidenceCandidate&&changedSource.requiresHumanApproval&&!(await finalAssessment(sourceLease,changedSource)).evidenceCandidate);
 generationCheck(!(await finalAssessment(raceLease,race.find(d=>d.evidenceCandidate)!)).evidenceCandidate);
 stage='automatic-exact-conflict';const alternative='通常三个工作日内发货。';
 await owner.query("UPDATE knowledge_documents SET version=1,content=content||E'\\n\\n'||$2 WHERE document_id=$1",[receipt.documentId,alternative]);
 await owner.query(`INSERT INTO automatic_reception_answers(answer_id,tenant_id,document_id,document_version,topic,answer_text,keywords,question_texts,
  status,approval_version,approved_by,requires_human_approval,valid_from,valid_until) VALUES($1,'monthly',$2,1,'shipping_information',$3,ARRAY['发货'],ARRAY[$4],
  'approved','approved-exact-answer-v1',$5,false,clock_timestamp()-INTERVAL '1 hour',clock_timestamp()+INTERVAL '1 day')`,
  [randomUUID(),receipt.documentId,alternative,texts.question,actors.monthly]);
 automaticBehavior='success';const beforeConflict=automaticProviderCalls,conflicting=await generator(await autoLease(),texts.question);
 generationCheck(conflicting.fallback&&conflicting.requiresHumanApproval&&automaticProviderCalls===beforeConflict);
 generationCheck(pool.totalCount===pool.idleCount);
 enabled=false;const counts={providerCalls,nativeCalls};check((await service.runOne()).state==='disabled');
 check(JSON.stringify(counts)===JSON.stringify({providerCalls,nativeCalls}));
 check(providerCalls===(realNative?7:6));
 console.log(JSON.stringify({status:'history_actual_billing_capacity_passed',checks,businessSchema:'full_current_sql',runtimeRole:'non_owner',
  billing:'actual_reserve_settle_and_month_lot_projections',capacity:'actual_entitlements_and_transaction_lock',nativeTransport:nativeWait?'actual_rails_http_non_owner_reply_wait':realNative?'actual_rails_http_select_only':'synthetic_signed_envelope',
  modelTransport:'synthetic_qwen_response',syntheticProviderCalls:providerCalls,nativePageCalls:nativeCalls,draftPresentationChecks:draftChecks,draftProviderCalls,
  draftProjection:'actual_uncertainty_barrier_only_no_native_note',automaticPreparationChecks,
  automaticPresentation:'exact_styled_generation_independent_verifier_and_final_guard_no_sender',automaticGenerationChecks,automaticProviderCalls,
  concurrentGenerationReceiptProof:'one_generation_one_verifier_one_generation_bill',concurrentGlobalSqlObservationsOmitted,
  automaticWaitChecks,automaticWait:'durable_due_restart_and_real_barrier_synthetic_submit',syntheticDispatchCalls,
  automaticNativeWaitChecks,automaticNativePublicMessages,automaticNativeSubmitCalls,
  wechatNativeWaitChecks,wechatSimulatedProviderRequests,wechatNativePermitCalls,wechatNativeHistoryMessages,wechatProviderTransport:'synthetic_no_vendor_network',
  sharedNativeWaitChecks,sharedSimulatedProviderRequests,sharedNativePermitCalls,sharedNativeHistoryMessages,
  semanticNativeWaitChecks,semanticEmbeddingCalls,semanticGenerationCalls,semanticVerificationCalls,semanticNativePublicMessages,semanticChargedMicros,
  realModelCalls:0,customerSends:0,productionChanges:0}));
}catch(e:any){console.error(JSON.stringify({status:'fixture_failed',stage,checks,sqlstate:/^[A-Z0-9]{5}$/.test(e?.code??'')?e.code:null,
 fixtureFrames:String(e?.stack??'').match(/reception-(?:history-billing|shared-wait-native|semantic-wait-native|wechat-wait-native|reply-wait-native)\.integration\.js:\d+:\d+/g),
 waitCheck:/^(?:(?:native|wechat|shared|semantic_native)_)?wait_check_\d+$/.test(e?.message??'')?e.message:null}));throw Error('history_billing_fixture_failed');}
finally{await pool.end();await owner.end();await root.end();await nativeDb?.end();}
