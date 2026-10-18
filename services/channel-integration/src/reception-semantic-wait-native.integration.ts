/** Isolated actual pgvector, history HTTP, native writer and point ledger.
 * Only model responses are synthetic; never a live provisioner or sender. */
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {receptionFixtureSqlGuards,waitForFixtureDatabaseDue} from './reception-fixture-sql-guards.js';
import {createAutomaticGatewayRuntime} from './automatic-reception-gateway.js';
import {createAutomaticWebIngress} from './automatic-reception-queue.js';
import {createAutomaticNativeClient} from './automatic-web-native-client.js';
import {createMeteredAutomaticGenerator} from './automatic-reception-generation.js';
import {createMeteredAutomaticSemanticRetriever} from './automatic-knowledge-semantic-store.js';
import {createMeteredAutomaticSemanticVerifier} from './automatic-knowledge-verification.js';
import {createAutomaticPresentationPreparation,type AutomaticPresentationOptions} from './reception-automatic-presentation.js';
import {createAuthorizedReceptionHistoryReader} from './reception-history-reader.js';
import {manageReceptionPersonalization,validateReceptionPersonalizationAction} from './reception-personalization.js';
import {chunkText} from './knowledge-ingestion.js';
import {qwenText,qwenEmbedding} from './qwen-runtime.js';
import {parseSemanticAnswer} from './automatic-knowledge-grounding.js';
import {automaticTextRisks} from './automatic-reception-evidence.js';
import {aiPointsOverview,reserveAiPoints,settleAiPoints} from './ai-points.js';
import {initialAiPrices,priceAiUsage} from './ai-points-core.js';
import {planReceptionSendTiming} from './reception-presentation.js';
import type {ReplyWaitNativeSeed} from './reception-reply-wait-native.integration.js';
import {manageAutomaticReception,validateAutomaticManagementAction,AUTOMATIC_SEND_DISCLOSURE_VERSION} from './automatic-reception-management.js';

export async function testSemanticWaitNative(input:{db:Pool;owner:Pool;nativeDb:Pool;root:Pool;seed:ReplyWaitNativeSeed;customer:string;
 connection:string;secret:string;token:string;reader:ReturnType<typeof createAuthorizedReceptionHistoryReader>;
 presentationOptions:AutomaticPresentationOptions;stage:(s:string)=>void;}){
 assert.equal(process.env.RECEPTION_REPLY_WAIT_NATIVE_HTTP,'isolated-reply-wait-native');
 const {db,owner,nativeDb,root,seed,customer,connection,secret}=input;
 let checks=0,embeds=0,generates=0,verifies=0,submits=0,mode:'success'|'negative'='success';
 const check=(v:unknown)=>{assert.ok(v,'semantic_native_wait_check_'+checks);checks++;};
 const question='办理现场登记需要哪些材料？',fact='办理现场登记所需材料为报名确认信和纸质申请表。';
 const condition='仅适用于持有报名确认信的访客；尚未取得确认信，请先联系活动组织方核对报名状态。';
 const filler='登记台展示办理流程，访客按照指示准备材料，现场工作人员核对材料并说明后续步骤。'.repeat(30);
 const source='# 现场登记指南\n\n'+fact+'\n\n'+filler+'\n\n'+condition;
 const firstClaim='您好，请携带报名确认信与纸质申请表办理现场登记。',answer=firstClaim+'\n'+condition;
 const answerOutput={answer,claims:[{text:firstClaim,source_index:0,quote:fact},{text:condition,source_index:0,quote:condition}]};
 // Check the fixture against the SAME pure risk/grounding gate before the
 // expensive native scenarios. This ordinary-materials case must not contain
 // transaction-specific wording (which correctly falls back to a human).
 check(automaticTextRisks(source).length===0&&!!parseSemanticAnswer(JSON.stringify(answerOutput),question,[{text:source}]));
 check(parseSemanticAnswer(JSON.stringify({answer:firstClaim,claims:[answerOutput.claims[0]]}),question,[{text:source}])===null);
 const document=randomUUID(),foreignDocument=randomUUID(),vector=Array<number>(768).fill(0);vector[2]=1;
 const usage={input_tokens:100,output_tokens:30,cached_input_tokens:0};
 const expectedCharge=priceAiUsage({input_tokens:64,output_tokens:0,cached_input_tokens:0},initialAiPrices.embedding).point_micros+
  2*priceAiUsage(usage,initialAiPrices.text).point_micros;
 const counts=()=>JSON.stringify({embeds,generates,verifies,submits});
 const balance=async()=>(await aiPointsOverview('monthly')).monthly_used_micros;
 async function guardedTransactions(){return Number((await root.query(receptionFixtureSqlGuards)).rows[0].n);}
 async function noSqlLocks(){check(await guardedTransactions()===0);}
 // Empty SKIP LOCKED peers may briefly idle without a transaction ID. A
 // real FOR SHARE guard acquires one: prove this detector rather than simply
 // dropping the I/O lock assertion when the due loop becomes concurrent.
 const probe=await db.connect();try{
  await probe.query('BEGIN');check(await guardedTransactions()===0);
  await probe.query("SELECT tenant_id FROM automatic_reception_grants WHERE tenant_id='monthly' FOR SHARE");
  check(await guardedTransactions()===1);await probe.query('ROLLBACK');check(await guardedTransactions()===0);
 }finally{await probe.query('ROLLBACK').catch(()=>{});probe.release();}
 const modelTransport:typeof fetch=async(url,init)=>{
  await noSqlLocks();const u=new URL(String(url)),raw=String(init?.body),body=JSON.parse(raw);
  check(u.origin==='https://maas.qianwenaiapi.com'&&u.pathname.startsWith('/compatible-mode/v1/')&&init?.redirect==='error');
  check(!raw.includes(customer)&&!raw.includes(document)&&!raw.includes(foreignDocument)&&!raw.includes('FOREIGN_SOURCE'));
  if(u.pathname.endsWith('/embeddings')){
   embeds++;check(body.model===initialAiPrices.embedding.model&&body.input===question&&body.dimensions===768);
   return Response.json({data:[{embedding:vector}],usage:{prompt_tokens:64,total_tokens:64}});
  }
  check(u.pathname.endsWith('/chat/completions')&&body.model===initialAiPrices.text.model&&body.response_format.type==='json_object');
  const data=JSON.parse(body.messages.at(-1).content),verification=body.messages[0].content.includes('独立的客服来源核验器');
  check(data.question===question&&data.sources.length===1&&data.sources[0].text.includes(fact)&&data.sources[0].text.includes(condition));
  check(data.sources[0].text.length>800);let output;
  if(verification){
   verifies++;check(body.messages.length===2&&!('presentation' in data)&&!raw.includes('已隐藏')&&!raw.includes('PRIVATE_'));
   const passed=mode!=='negative';
   output={question_answered:true,all_claims_supported:passed,conditions_preserved:true,no_conflict:true,
    claims:data.claims.map((p:any,n:number)=>({index:n,source_index:p.source_index,quote_hash:p.quote_hash,supported:passed}))};
  }else{
   generates++;check(body.messages.length===3&&data.presentation.tone==='friendly_detailed'&&data.presentation.context.length>=2);
   check(!raw.includes('masked@example.invalid')&&!raw.includes('13800138000')&&!raw.includes('PRIVATE_'));
   output=answerOutput;
  }
  return Response.json({choices:[{message:{content:JSON.stringify(output)},finish_reason:'stop'}],
   usage:{prompt_tokens:100,completion_tokens:30,prompt_tokens_details:{cached_tokens:0}}});
 };
 const ports={enabled:()=>true,pointsEnabled:()=>true,configured:()=>true,
  reserve:(t:string,k:string,i:number,o:number)=>reserveAiPoints(t,k,'copilot',i,o),settle:settleAiPoints,
  model:(messages:{role:'system'|'user';content:string}[],tokens:number,json=false)=>qwenText(messages,tokens,modelTransport,json)};
 const retrieve=createMeteredAutomaticSemanticRetriever(db,{enabled:()=>true,pointsEnabled:()=>true,configured:()=>true,
  reserve:(t,k,i)=>reserveAiPoints(t,k,'embedding_query',i,0),settle:settleAiPoints,embed:q=>qwenEmbedding(q,modelTransport)});
 const preparation=()=>createAutomaticPresentationPreparation(db,input.reader,input.presentationOptions);
 const generator=createMeteredAutomaticGenerator(db,ports,{enabled:()=>true,retrieve,
  verify:createMeteredAutomaticSemanticVerifier(db,ports,input.presentationOptions)},
  {enabled:()=>true,preparation:preparation()});
 const nativeTransport:typeof fetch=async(url,init)=>{
  check(String(url).startsWith('http://fixture-native:3000/internal/saas_sso/'));await noSqlLocks();
  if(String(url).endsWith('/automatic_replies/submit'))submits++;
  return fetch(url,init);
 };
 const native=createAutomaticNativeClient({origin:'http://fixture-native:3000',secret,fetcher:nativeTransport});
 const bridge='isolated-semantic-wait-secret-'+'2'.repeat(40);
 const ingress=createAutomaticWebIngress(db,{enabled:()=>true,secret:bridge,snapshot:native.snapshot});
 function runtime(){return createAutomaticGatewayRuntime(db,{management:true,web:true,wechatManagement:false,wechat:false,wechatHistory:false,
  draftCallback:false,callback:true,timing:true,origin:'http://fixture-native:3000',nativeSecret:secret,bridgeSecret:bridge,token:'unused-fixture-token'},
  {generate:generator,draft:async()=>{throw Error('legacy draft forbidden');},fetcher:nativeTransport,
   timing:{presentationOptions:input.presentationOptions,currentPresentation:preparation().currentStored}});}
 async function settings(tone:'neutral'|'friendly_detailed'){
  const s=(await manageReceptionPersonalization(db,input.token,'monthly')).settings;
  await manageReceptionPersonalization(db,input.token,'monthly',validateReceptionPersonalizationAction('settings',{
   expectedRevision:s.revision,draftTone:s.draftTone,automaticTone:tone,learnFromHuman:false,
   timing:{enabled:true,minimumSeconds:1,maximumSeconds:30}}));
 }
 async function saved(id:string){return (await db.query(`SELECT j.job_id,j.state,j.reason,j.transport_attempted_at,j.draft,j.created_at,
  w.state wait_state,w.due_at FROM automatic_reception_jobs j LEFT JOIN automatic_reply_waits w USING(job_id)
  WHERE j.tenant_id='monthly' AND j.message_id=$1`,[id])).rows[0];}
 async function prepared(){
  const id=String((await nativeDb.query(`INSERT INTO messages(account_id,inbox_id,conversation_id,message_type,content_type,content,private,status,sender_type,sender_id,
   content_attributes,created_at,updated_at) VALUES($1,$2,$3,0,0,$4,false,0,'Contact',$5,'{}',clock_timestamp(),clock_timestamp()) RETURNING id`,
   [seed.account,seed.inbox,seed.conversation,question,seed.contact])).rows[0].id);
  const body=Buffer.from(JSON.stringify({event:'message_created',private:false,message_type:0,id,account:{id:seed.account},inbox:{id:seed.inbox},conversation:{id:seed.display}})),stamp=String(Math.floor(Date.now()/1000));
  check(await ingress(body,stamp,'v1='+createHmac('sha256',bridge).update(stamp+'.').update(body).digest('hex'))==='queued');
  const before=await balance(),beforeModels={embeds,generates,verifies},r=runtime();try{check(await r.tick()===1);}finally{await r.stop();}
  const s=await saved(id);if(mode==='success'&&s.wait_state!=='waiting'){
   const journal=(await db.query(`SELECT r.state retrieval_state,r.reason retrieval_reason,g.state generation_state,g.reason generation_reason,
    v.state verification_state,v.reason verification_reason FROM automatic_reception_jobs j
    LEFT JOIN automatic_reception_retrievals r USING(job_id) LEFT JOIN automatic_reception_generations g USING(job_id)
    LEFT JOIN automatic_reception_verifications v USING(job_id) WHERE j.job_id=$1`,[s.job_id])).rows[0];
   console.error(JSON.stringify({status:'semantic_wait_preparation_failed',state:s.state,reason:s.reason,embeds,generates,verifies,journal}));
  }
  check(embeds===beforeModels.embeds+1&&generates===beforeModels.generates+1&&verifies===beforeModels.verifies+1);
  const bills=(await db.query('SELECT status,charged_micros,feature FROM ai_usage_calls WHERE tenant_id=$1 AND request_key=ANY($2::text[])',
   ['monthly',['automatic-knowledge-query:','automatic-reply:','automatic-verify:'].map(k=>k+s.job_id)])).rows;
  check(bills.length===3&&bills.every(b=>b.status==='succeeded')&&bills.filter(b=>b.feature==='embedding_query').length===1);
  check(bills.reduce((sum,b)=>sum+Number(b.charged_micros),0)===expectedCharge&&await balance()-before===expectedCharge);
  if(mode==='success'){
   check(s.state==='processing'&&s.wait_state==='waiting'&&!s.transport_attempted_at&&s.draft.text===answer);
   const plan=planReceptionSendTiming(answer,new Date(s.created_at).getTime(),Date.now());
   check(new Date(s.due_at).getTime()===plan.dueAtMs&&plan.targetDelaySeconds>1&&plan.targetDelaySeconds<30);
   check(plan.targetDelaySeconds>planReceptionSendTiming('您好',new Date(s.created_at).getTime(),Date.now()).targetDelaySeconds);
  }
  return {id,s};
 }
 async function dispatch(id:string){const s=await saved(id);await waitForFixtureDatabaseDue(db,s.job_id);check(true);
  const before=counts(),used=await balance(),r=runtime();
  try{const processed=await r.tickWaiting();if(processed!==1){const state=await saved(id);console.error(JSON.stringify({status:'semantic_wait_dispatch_count',processed,
   state:state?.state,reason:state?.reason,waitState:state?.wait_state,dueAt:state?.due_at,clock:(await db.query('SELECT clock_timestamp() now')).rows[0]}));}
   check(processed===1&&await r.tickWaiting()===0);}finally{await r.stop();}
  check(counts()===before||JSON.parse(counts()).submits===JSON.parse(before).submits+1);
  check(embeds===JSON.parse(before).embeds&&generates===JSON.parse(before).generates&&verifies===JSON.parse(before).verifies&&await balance()===used);
  return saved(id);
 }
 for(const [tenant,doc,body] of [['monthly',document,source],['credits',foreignDocument,'FOREIGN_SOURCE'+source]]){
  await owner.query("INSERT INTO knowledge_documents(document_id,tenant_id,title,source_type,content,keywords) VALUES($1,$2,'合成长文登记说明','knowledge',$3,ARRAY['登记'])",[doc,tenant,body]);
  await owner.query(`INSERT INTO knowledge_chunks(chunk_id,tenant_id,document_id,document_version,chunk_index,content,embedding,embedding_provider,embedding_model,embedding_status)
   VALUES($1,$2,$3,1,0,$4,$5::vector,'qwen',$6,'ready')`,[randomUUID(),tenant,doc,chunkText(body)[0],JSON.stringify(vector),initialAiPrices.embedding.model]);
 }
 check(!chunkText(source)[0].includes(condition)&&source.indexOf(condition)>800);
 // The earlier exact-answer fixture used a synthetic owner-created primary
 // grant. Do NOT fabricate its missing disclosure audit: obtain a fresh v3
 // grant through the actual synthetic admin session and actual native actor.
 // Formal mode uses only the existing reviewed release ACL, never fixture grants.
 if(process.env.RECEPTION_FORMAL_RUNTIME!=='isolated-formal-reception'){
 await owner.query(`GRANT SELECT,INSERT,UPDATE ON automatic_reception_grants TO history_runtime;
  GRANT SELECT,INSERT ON automatic_reception_management_audit TO history_runtime;
  GRANT INSERT,UPDATE ON tenant_ai_settings TO history_runtime;`);
 }
 const previous=(await db.query("SELECT authorization_id FROM automatic_reception_grants WHERE tenant_id='monthly'")).rows[0].authorization_id;
 const granted=await manageAutomaticReception(db,input.token,validateAutomaticManagementAction('grant',{
  enabled:true,expected_authorization_id:previous,confirmed:true,consent_version:'automatic-send-v1',
  disclosure_version:AUTOMATIC_SEND_DISCLOSURE_VERSION}),'monthly',{sender:native.sender});
 const authorizationId=granted.grant.authorization_id;
 check(authorizationId!==previous&&granted.grant.enabled);
 check((await db.query(`SELECT 1 FROM automatic_reception_management_audit WHERE tenant_id='monthly' AND resource_id=$1
  AND action='grant.enabled' AND metadata->>'disclosure_version'=$2`,[authorizationId,AUTOMATIC_SEND_DISCLOSURE_VERSION])).rowCount===1);
 await settings('friendly_detailed');
 await owner.query("UPDATE channel_connections SET configuration=jsonb_build_object('chatwoot_account_id',$2::text,'chatwoot_inbox_id',$3::text) WHERE connection_id=$1",[connection,seed.account,seed.inbox]);
 await owner.query("UPDATE channel_identities SET chatwoot_conversation_id=$2 WHERE tenant_id='monthly' AND channel_connection_id=$1",[connection,seed.display]);
 input.stage('semantic-native-wait-restart');const first=await prepared(),result=await dispatch(first.id);check(result.state==='accepted'&&result.wait_state==='finished');
 const publicRows=(await nativeDb.query(`SELECT m.content,m.private,m.sender_type,m.account_id::text,m.inbox_id::text,m.conversation_id::text
  FROM messages m JOIN replynest_automatic_receipts r ON (r.result->>'message_id')::bigint=m.id WHERE r.id=$1`,[result.job_id])).rows;
 check(publicRows.length===1&&publicRows[0].content===answer&&!publicRows[0].private&&publicRows[0].sender_type==='AgentBot'&&
  publicRows[0].account_id===seed.account&&publicRows[0].inbox_id===seed.inbox&&publicRows[0].conversation_id===seed.conversation);
 input.stage('semantic-native-wait-source-change');const changed=await prepared(),sent=submits;
 await owner.query('UPDATE knowledge_documents SET version=version+1 WHERE document_id=$1',[document]);
 const cancelled=await dispatch(changed.id);check(cancelled.state==='skipped'&&!cancelled.transport_attempted_at&&submits===sent);
 await owner.query('UPDATE knowledge_documents SET version=1 WHERE document_id=$1',[document]);
 input.stage('semantic-native-wait-context-revoke');const revoked=await prepared(),grant=(await manageReceptionPersonalization(db,input.token,'monthly')).grants.find(g=>g.purpose==='context')!;
 await manageReceptionPersonalization(db,input.token,'monthly',validateReceptionPersonalizationAction('history-grant',{purpose:'context',enabled:false,expectedRevision:grant.revision}));
 const revokedResult=await dispatch(revoked.id);check(revokedResult.state==='skipped'&&!revokedResult.transport_attempted_at&&submits===sent);
 const tombstone=(await manageReceptionPersonalization(db,input.token,'monthly')).grants.find(g=>g.purpose==='context')!;
 await manageReceptionPersonalization(db,input.token,'monthly',validateReceptionPersonalizationAction('history-grant',{
  purpose:'context',enabled:true,expectedRevision:tombstone.revision,confirmed:true,disclosureVersion:'reception-history-context-v1'}));
 input.stage('semantic-native-negative-verifier');mode='negative';const negative=await prepared();
 check(negative.s.state==='draft'&&!negative.s.wait_state&&!negative.s.transport_attempted_at&&submits===sent);
 const beforeReplay=counts(),beforeReplayBalance=await balance(),restarted=runtime();
 try{check(await restarted.tick()===0&&await restarted.tickWaiting()===0);}finally{await restarted.stop();}
 check(counts()===beforeReplay&&await balance()===beforeReplayBalance);
 await settings('neutral');await owner.query("UPDATE channel_identities SET chatwoot_conversation_id=10 WHERE tenant_id='monthly' AND channel_connection_id=$1",[connection]);
 return {checks,embeds,generates,verifies,publicMessages:publicRows.length,submitCalls:submits,chargedMicros:expectedCharge*generates,authorizationId};
}
