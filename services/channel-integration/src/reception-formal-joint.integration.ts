/** Formal full-schema joined fixture. No runtime schema installs or extra
 * grants. Artificial partly-installed-schema transitions remain in the legacy
 * test only: this entry keeps the complete durable-send barriers installed.
 * Synthetic models/provider; actual DB, billing, grants and native HTTP. */
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
assert.equal(fixture,'isolated-history-billing');assert.equal(process.env.RECEPTION_FORMAL_RUNTIME,'isolated-formal-reception');assert.equal(process.env.POSTGRES_HOST,'fixture-db');
assert.equal(process.env.POSTGRES_DATABASE,'replynest_production');assert.equal(process.env.POSTGRES_USERNAME,'replynest_runtime');
assert.equal(process.env.QWEN_API_KEY,'synthetic-history-provider-key');assert.equal(process.env.AI_POINTS_ENABLED,'true');
const root=new Pool({host:'fixture-db',database:'replynest_production',user:'postgres',password:'isolated-full-only',max:1});
const owner=new Pool({host:'fixture-db',database:'replynest_production',user:'replynest_migrator',password:'a'.repeat(64),options:'-c role=replynest_app',max:1});
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
const nativeDb=realNative?new Pool({host:'fixture-native-db',database:'chatwoot_production',user:'chatwoot_runtime',password:'a'.repeat(64),max:1}):undefined;
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

 stage='formal-runtime-boundary';
 const runtimeIdentity=(await pool.query("SELECT current_user,session_user,has_schema_privilege(current_user,'public','CREATE') ddl")).rows[0];
 check(runtimeIdentity.current_user==='replynest_runtime'&&runtimeIdentity.session_user==='replynest_runtime'&&!runtimeIdentity.ddl);
 await assert.rejects(()=>pool.query('SET ROLE replynest_app'),(e:any)=>e.code==='42501');checks++;
 await assert.rejects(()=>pool.query('UPDATE replynest_schema_receipts SET migrated_at=clock_timestamp()'),(e:any)=>e.code==='42501');checks++;
 // Retire only the isolated migration-fixture sentinel before queue acceptance.
 await owner.query("UPDATE reception_history_knowledge_jobs SET state='failed',reason='isolated_fixture_sentinel_retired' WHERE tenant_id='persona-full-synthetic' AND state='queued'");
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

  const acl=(await nativeDb!.query("SELECT current_user,has_schema_privilege(current_user,'public','CREATE') ddl,has_table_privilege(current_user,'schema_migrations','INSERT') receipt")).rows[0];
  check(acl.current_user==='chatwoot_runtime'&&!acl.ddl&&!acl.receipt);
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

 stage='formal-native-runtime-composition';
 const generationCheck=(v:unknown)=>{check(v);automaticGenerationChecks++;};
 const connection=randomUUID();
 await owner.query("UPDATE channel_identities SET chatwoot_contact_id=$2 WHERE tenant_id='monthly' AND customer_id=$1",[customer,contact]);
 await owner.query("INSERT INTO channel_connections(connection_id,tenant_id,channel_type,display_name,status,configuration) VALUES($1,'monthly','web_chat','Synthetic formal reception','ready','{}')",[connection]);
 await owner.query(`INSERT INTO channel_identities(tenant_id,customer_id,channel,external_user_id,chatwoot_contact_id,chatwoot_source_id,chatwoot_conversation_id,channel_connection_id)
 VALUES('monthly',$1,'web_chat','synthetic-formal-customer',$2,'synthetic',10,$3)`,[customer,contact,connection]);
 await owner.query("UPDATE tenant_ai_settings SET ai_auto_reply_enabled=true,automatic_sending_enabled=true,automation_consent_version='automatic-reply-v1' WHERE tenant_id='monthly'");
 // Synthetic initial identity; native/channel helpers obtain current audited
 // grants through actual administrator sessions and native actor authorization.
 await owner.query(`INSERT INTO automatic_reception_grants(tenant_id,account_id,authorization_id,consent_version,enabled,actor_id)
 VALUES('monthly',$1,$2,'automatic-send-v1',true,$3)`,[nativeAccount,randomUUID(),actors.monthly]);
 const autoOptions={enabled:()=>enabled,contextEnabled:()=>true,styleEnabled:()=>false};
 const automaticPrep=createAutomaticPresentationPreparation(pool,reader,autoOptions);
 await nativeDb!.query('UPDATE messages SET content=$3 WHERE account_id=$1 AND id=$2',[seeds.monthly.account,seeds.monthly.question,texts.question]);
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
 await restoreContext();
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
 if(nativeWait){
  nativeWaitStarted=true;
  const result=await testReplyWaitNative({db:pool,owner,nativeDb:nativeDb!,root,
   seed:JSON.parse(readFileSync('/fixture/reply-wait-seed.json','utf8')) as ReplyWaitNativeSeed,customer,actor:actors.monthly!,connection,secret,
   question:texts.question,answer:'您好，'+texts.answer,models:()=>automaticProviderCalls,balance:async()=>(await aiPointsOverview('monthly')).monthly_used_micros,
   generate:generator,presentation:()=>({presentationOptions:autoOptions,currentPresentation:createAutomaticPresentationPreparation(pool,reader,autoOptions).currentStored}),
   stage:s=>{stage=s;}});
  automaticNativeWaitChecks=result.checks;automaticNativePublicMessages=result.publicMessages;automaticNativeSubmitCalls=result.submitCalls;checks+=result.checks;
  console.log(JSON.stringify({status:'formal_path_passed',path:'web',checks:result.checks,publicMessages:result.publicMessages}));
  const wechat=await testWechatWaitNative({db:pool,owner,nativeDb:nativeDb!,root,
   seed:JSON.parse(readFileSync('/fixture/wechat-wait-seed.json','utf8')) as WechatWaitSeed,customer,actor:actors.monthly!,token:tokens.monthly!,secret,
   question:texts.question,answer:'您好，'+texts.answer,models:()=>automaticProviderCalls,balance:async()=>(await aiPointsOverview('monthly')).monthly_used_micros,
   generate:generator,presentation:()=>({presentationOptions:autoOptions,currentPresentation:createAutomaticPresentationPreparation(pool,reader,autoOptions).currentStored}),
   stage:s=>{stage=s;}});
  wechatNativeWaitChecks=wechat.checks;wechatSimulatedProviderRequests=wechat.providerRequests;wechatNativePermitCalls=wechat.permitCalls;
  wechatNativeHistoryMessages=wechat.historyMessages;checks+=wechat.checks;
  console.log(JSON.stringify({status:'formal_path_passed',path:'independent_wechat',checks:wechat.checks,providerRequests:wechat.providerRequests,historyMessages:wechat.historyMessages}));
  const shared=await testSharedWaitNative({db:pool,owner,nativeDb:nativeDb!,root,
   seeds:JSON.parse(readFileSync('/fixture/shared-wait-seed.json','utf8')) as SharedWaitSeed[],customer,actor:actors.monthly!,token:tokens.monthly!,secret,
   question:texts.question,answer:'您好，'+texts.answer,models:()=>automaticProviderCalls,balance:async()=>(await aiPointsOverview('monthly')).monthly_used_micros,
   generate:generator,presentation:()=>({presentationOptions:autoOptions,currentPresentation:createAutomaticPresentationPreparation(pool,reader,autoOptions).currentStored}),
   stage:s=>{stage=s;}});
  sharedNativeWaitChecks=shared.checks;sharedSimulatedProviderRequests=shared.providerRequests;sharedNativePermitCalls=shared.permitCalls;
  sharedNativeHistoryMessages=shared.historyMessages;checks+=shared.checks;
  console.log(JSON.stringify({status:'formal_path_passed',path:'shared_wechat',checks:shared.checks,providerRequests:shared.providerRequests,historyMessages:shared.historyMessages}));
  const semantic=await testSemanticWaitNative({db:pool,owner,nativeDb:nativeDb!,root,
   seed:JSON.parse(readFileSync('/fixture/reply-wait-seed.json','utf8')) as ReplyWaitNativeSeed,customer,connection,secret,token:tokens.monthly!,reader,
   presentationOptions:autoOptions,stage:s=>{stage=s;}});
  semanticNativeWaitChecks=semantic.checks;semanticEmbeddingCalls=semantic.embeds;semanticGenerationCalls=semantic.generates;
  semanticVerificationCalls=semantic.verifies;semanticNativePublicMessages=semantic.publicMessages;semanticChargedMicros=semantic.chargedMicros;checks+=semantic.checks;
  console.log(JSON.stringify({status:'formal_path_passed',path:'semantic',checks:semantic.checks,chargedMicros:semantic.chargedMicros,publicMessages:semantic.publicMessages}));
 }
 enabled=false;const counts={providerCalls,nativeCalls};check((await service.runOne()).state==='disabled');
 check(JSON.stringify(counts)===JSON.stringify({providerCalls,nativeCalls}));
 check(providerCalls===(realNative?7:6));
 console.log(JSON.stringify({status:'formal_reception_joint_passed',checks,businessSchema:'frozen_full_twelve_components',runtimeRole:'replynest_runtime',nativeRuntimeRole:'chatwoot_runtime',
  billing:'actual_reserve_settle_and_month_lot_projections',capacity:'actual_entitlements_and_transaction_lock',nativeTransport:'actual_rails_http_formal_runtime',
  modelTransport:'synthetic_qwen_response',syntheticProviderCalls:providerCalls,nativePageCalls:nativeCalls,draftPresentationChecks:draftChecks,draftProviderCalls,
  draftProjection:'actual_uncertainty_barrier_only_no_native_note',automaticPreparationChecks,
  automaticPresentation:'exact_styled_generation_independent_verifier_and_final_guard_no_sender',automaticGenerationChecks,automaticProviderCalls,
  concurrentGenerationReceiptProof:'existing_packaged_suite_not_this_entry',concurrentGlobalSqlObservationsOmitted,
  automaticWaitChecks,automaticWait:'actual_native_helpers_full_schema_barriers',syntheticDispatchCalls,
  automaticNativeWaitChecks,automaticNativePublicMessages,automaticNativeSubmitCalls,
  wechatNativeWaitChecks,wechatSimulatedProviderRequests,wechatNativePermitCalls,wechatNativeHistoryMessages,wechatProviderTransport:'synthetic_no_vendor_network',
  sharedNativeWaitChecks,sharedSimulatedProviderRequests,sharedNativePermitCalls,sharedNativeHistoryMessages,
  semanticNativeWaitChecks,semanticEmbeddingCalls,semanticGenerationCalls,semanticVerificationCalls,semanticNativePublicMessages,semanticChargedMicros,
  realModelCalls:0,customerSends:0,productionChanges:0}));
}catch(e:any){console.error(JSON.stringify({status:'fixture_failed',stage,checks,sqlstate:/^[A-Z0-9]{5}$/.test(e?.code??'')?e.code:null,
 fixtureFrames:String(e?.stack??'').match(/reception-(?:formal-joint|history-billing|shared-wait-native|semantic-wait-native|wechat-wait-native|reply-wait-native)\.integration\.js:\d+:\d+/g),
 waitCheck:/^(?:(?:native|wechat|shared|semantic_native)_)?wait_check_\d+$/.test(e?.message??'')?e.message:null}));throw Error('formal_reception_joint_fixture_failed');}
finally{await pool.end();await owner.end();await root.end();await nativeDb?.end();}
