/** Actual isolated WeChat ingress/native permit + persistent wait + real points.
 * Provider acknowledgements are SYNTHETIC; no WeChat network or customer sends. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {receptionFixtureSqlGuards,waitForFixtureDatabaseDue} from './reception-fixture-sql-guards.js';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
import type {ReceptionDraft} from './reception-executor.js';
import type {AutomaticReplyWaitPresentation} from './automatic-reply-wait-runtime.js';
import {createAutomaticWeChatRuntime} from './automatic-wechat-runtime.js';
import {createAutomaticNativeClient} from './automatic-web-native-client.js';
import {createVerifiedWeChatIngressClient} from './verified-wechat-ingress-client.js';
import {projectVerifiedWeChatInbound} from './verified-wechat-ingress.js';
import {sharedWechatStoreSchemaSql} from './shared-wechat-store.js';
import {sharedWechatDeliverySchemaSql} from './shared-wechat-delivery.js';
import {automaticWechatSchemaSql} from './automatic-wechat-migrate.js';
import {manageAutomaticWeChatGrant,AUTOMATIC_WECHAT_DISCLOSURE_VERSION} from './automatic-wechat-management.js';
import {createAutomaticWeChatHistoryWorker} from './automatic-wechat-history-worker.js';

export type WechatWaitSeed={account:string;contact:string;human:string;inbox:string;connection:string;app:string;openid:string};
export async function testWechatWaitNative(input:{db:Pool;owner:Pool;nativeDb:Pool;root:Pool;seed:WechatWaitSeed;customer:string;actor:string;token:string;
 secret:string;question:string;answer:string;models:()=>number;balance:()=>Promise<number>;
 generate:(l:AutomaticReceptionLease,q:string)=>Promise<ReceptionDraft>;presentation:()=>AutomaticReplyWaitPresentation;stage:(s:string)=>void;}){
 assert.equal(process.env.RECEPTION_REPLY_WAIT_NATIVE_HTTP,'isolated-reply-wait-native');
 const {db,owner,nativeDb,root,seed,customer,actor,secret}=input;
 assert.match(seed.app,/^wx5{16}$/);assert.equal(seed.openid,'isolated-durable-user');
 let checks=0,providerRequests=0,permitCalls=0,tokenReads=0,conversation='',nativeConversation='';
 let fault:'none'|'human_before_permit'|'rate_limited'|'lost_ack'='none';
 let historyFault=false,historyRequests=0;
 const check=(v:unknown)=>{assert.ok(v,'wechat_wait_check_'+checks);checks++;};
 async function noSqlLocks(){check(Number((await root.query(receptionFixtureSqlGuards)).rows[0].n)===0);}
 async function human(){await nativeDb.query(`INSERT INTO messages(account_id,inbox_id,conversation_id,message_type,content_type,content,private,status,sender_type,sender_id,content_attributes,created_at,updated_at)
  VALUES($1,$2,$3,1,0,'人工已处理',false,0,'User',$4,'{}',clock_timestamp(),clock_timestamp())`,[seed.account,seed.inbox,nativeConversation,seed.human]);}
 const transport:typeof fetch=async(url,init)=>{
  await noSqlLocks();const u=new URL(String(url));
  if(u.origin==='http://fixture-native:3000'){
   check(u.pathname.startsWith('/internal/saas_sso/'));
   if(u.pathname.endsWith('/automatic_wechat/authorize')){permitCalls++;if(fault==='human_before_permit'){fault='none';await human();}}
   const response=await fetch(url,init);
   if(u.pathname.endsWith('/automatic_wechat/history')){
    historyRequests++;if(historyFault){historyFault=false;check(response.ok&&(await response.clone().json() as any).state==='recorded');
     // Commit actually succeeded. Only the native recording acknowledgement is
     // lost; retrying history must never reach the provider send endpoint.
     return Response.json({}, {status:503});}
   }
   return response;
  }
  check(u.origin==='https://api.weixin.qq.com'&&u.pathname==='/cgi-bin/message/custom/send');
  check(u.searchParams.get('access_token')==='isolated-durable-token');
  const body=JSON.parse(String(init?.body));check(body.touser===seed.openid&&body.text.content===input.answer&&body.aimsgcontext.is_ai_msg===0);
  providerRequests++;
  if(fault==='lost_ack'){fault='none';throw Error('isolated_provider_ack_lost');}
  if(fault==='rate_limited'){fault='none';return Response.json({errcode:45009,errmsg:'synthetic rate limit'});}
  return Response.json({errcode:0,errmsg:'ok'});
 };
 const native=createAutomaticNativeClient({origin:'http://fixture-native:3000',secret,fetcher:transport});
 const ingress=createVerifiedWeChatIngressClient({origin:'http://fixture-native:3000',secret,enabled:()=>true,fetcher:transport});
 function runtime(){return createAutomaticWeChatRuntime(db,{origin:'http://fixture-native:3000',secret,enabled:()=>true,fetcher:transport,
  generate:input.generate,timing:input.presentation(),resolveAccessToken:async(l,app)=>{
   check(l.tenantId==='monthly'&&l.channel==='wechat_official_account'&&app===seed.app);tokenReads++;
   return {appId:app,accessToken:'isolated-durable-token'};
  }});}
 async function saved(id:string){return (await db.query(`SELECT j.job_id,j.state,j.reason,j.receipt,j.transport_attempted_at,w.state wait_state,w.due_at,w.dispatch_token
  FROM automatic_reception_jobs j LEFT JOIN automatic_reply_waits w USING(job_id) WHERE j.tenant_id='monthly' AND j.channel='wechat_official_account' AND j.message_id=$1`,[id])).rows[0];}
 async function incoming(){
  const event='durable-'+randomUUID(),at=new Date().toISOString();
  const job=(await owner.query(`INSERT INTO gateway_events(tenant_id,channel,channel_connection_id,external_event_id,external_message_id,status,worker_id,locked_at,payload)
   VALUES('monthly','wechat_official_account',$1,$2,$2,'processing',$3,clock_timestamp(),$4) RETURNING *`,
   [seed.connection,event,randomUUID(),{normalized:{event_id:event,message_id:event,user_id:seed.openid,text:input.question,occurred_at:at}}])).rows[0];
  const result=await projectVerifiedWeChatInbound(db,job,ingress);check(/^\d+$/.test(result.id));
  check(JSON.stringify(await projectVerifiedWeChatInbound(db,job,ingress))===JSON.stringify(result));
  await owner.query("UPDATE gateway_events SET status='processed',processed_at=clock_timestamp(),chatwoot_message_id=$2 WHERE id=$1",[job.id,result.id]);
  conversation=result.conversationId;
  nativeConversation=String((await nativeDb.query('SELECT id FROM conversations WHERE account_id=$1 AND display_id=$2',[seed.account,conversation])).rows[0].id);
  // Fixture-only consolidation: this known synthetic Contact already owns the
  // historical public transcript. Do not rewrite a production customer identity.
  await owner.query("UPDATE channel_identities SET customer_id=$2 WHERE tenant_id='monthly' AND channel_connection_id=$1",[seed.connection,customer]);
  await nativeDb.query('UPDATE conversations SET assignee_id=$2 WHERE id=$1',[nativeConversation,seed.human]);
  return result.id;
 }
 async function prepared(){const id=await incoming(),before=providerRequests,tokens=tokenReads,r=runtime();
  try{check(await r.tick()===1);}finally{await r.stop();}
  const s=await saved(id);if(s?.wait_state!=='waiting')console.error(JSON.stringify({status:'wechat_wait_preparation_failed',state:s?.state,reason:s?.reason}));
  check(s.state==='processing'&&s.wait_state==='waiting'&&!s.transport_attempted_at);
  check(providerRequests===before&&tokenReads===tokens);return id;}
 async function dispatch(id:string){const s=await saved(id);await waitForFixtureDatabaseDue(db,s.job_id);check(true);
  const models=input.models(),balance=await input.balance(),r=runtime();
  try{const processed=await r.tickWaiting();if(processed!==1){const state=await saved(id);console.error(JSON.stringify({status:'wechat_wait_dispatch_count',processed,
   state:state?.state,reason:state?.reason,waitState:state?.wait_state,dueAt:state?.due_at,clock:(await db.query('SELECT clock_timestamp() now')).rows[0]}));}
   check(processed===1);check(await r.tickWaiting()===0);}finally{await r.stop();}
  check(input.models()===models&&await input.balance()===balance);return saved(id);}
 async function control(operation:'pause'|'resume'){const previous=await native.customerControl(seed.account,customer);
  const state=await native.customerControl(seed.account,customer,{operation,minutes:operation==='pause'?10:0,revision:previous.revision,
   actor_id:actor,request_id:randomUUID(),conversation_id:conversation,contact_id:seed.contact,native_actor_id:seed.human,permission_scope:'manager'});
  check(state.paused===(operation==='pause'));return state;}
 // Formal mode uses only the existing reviewed release ACL, never fixture grants.
 if(process.env.RECEPTION_FORMAL_RUNTIME!=='isolated-formal-reception'){
 await owner.query(sharedWechatStoreSchemaSql());await owner.query(sharedWechatDeliverySchemaSql());await owner.query(automaticWechatSchemaSql());
 // Additional isolated runtime ACLs only, not a formal production ACL receipt.
 await owner.query(`GRANT SELECT ON shared_wechat_accounts,shared_wechat_enrollments,shared_wechat_inboxes,shared_wechat_threads,
  shared_wechat_deliveries,shared_wechat_receipts,shared_wechat_routing_states TO history_runtime;
  GRANT SELECT,INSERT,UPDATE ON automatic_reception_wechat_grants TO history_runtime;
  GRANT SELECT,INSERT ON automatic_reception_wechat_audit,automatic_reception_wechat_outcomes,automatic_reception_wechat_envelopes,automatic_reception_wechat_history TO history_runtime;
  GRANT UPDATE(state,attempts,history_worker_token,locked_until,next_attempt_at,updated_at,reason,native_message_id) ON automatic_reception_wechat_history TO history_runtime;
  GRANT SELECT,INSERT,UPDATE ON gateway_events,customers,channel_identities TO history_runtime;
  GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO history_runtime;`);
 }
 const old=(await nativeDb.query('SELECT identifier,custom_attributes FROM contacts WHERE id=$1',[seed.contact])).rows[0];
 await nativeDb.query("UPDATE contacts SET identifier=$2,custom_attributes=jsonb_build_object('source_channel','wechat_official_account','replynest_wechat_connection',$3::text,'replynest_wechat_app',$4::text) WHERE id=$1",
  [seed.contact,seed.connection+':'+seed.openid,seed.connection,seed.app]);
 await owner.query(`INSERT INTO channel_connections(connection_id,tenant_id,channel_type,display_name,status,external_account_id,configuration)
  VALUES($1,'monthly','wechat_official_account','隔离公众号等待测试','ready',$2,$3)`,[seed.connection,seed.app,{chatwoot_account_id:seed.account,chatwoot_inbox_id:seed.inbox}]);
 const authorization=(await db.query("SELECT authorization_id FROM automatic_reception_grants WHERE tenant_id='monthly'")).rows[0].authorization_id;
 async function grant(enabled:boolean){const current=(await db.query("SELECT grant_id FROM automatic_reception_wechat_grants WHERE tenant_id='monthly'")).rows[0]?.grant_id??null;
  const result=await manageAutomaticWeChatGrant(db,input.token,enabled?{enabled:true,expected_authorization_id:authorization,expected_grant_id:current,
   channels:['wechat_official_account'],confirmed:true,consent_version:'wechat-automatic-send-v1',disclosure_version:AUTOMATIC_WECHAT_DISCLOSURE_VERSION}:
   {enabled:false,expected_authorization_id:authorization,expected_grant_id:current},'monthly');
  check(result.wechat.grant?.enabled===enabled);}
 await grant(true);
 input.stage('wechat-wait-assigned-restart');const id=await prepared(),accepted=await dispatch(id);
 check(accepted.state==='accepted'&&accepted.wait_state==='finished'&&accepted.transport_attempted_at&&accepted.dispatch_token);
 check(providerRequests===1&&permitCalls===1&&accepted.receipt.provider==='wechat_official_account'&&accepted.receipt.acknowledged===true);
 check((await db.query('SELECT outcome,reason FROM automatic_reception_wechat_outcomes WHERE job_id=$1',[accepted.job_id])).rows[0].reason==='provider_accepted');
 input.stage('wechat-wait-pause-resume');const pausedId=await prepared(),paused=await control('pause'),beforePause=providerRequests;
 check(new Date(paused.paused_until!).getTime()-Date.now()>590000);const cancelled=await dispatch(pausedId);
 check(cancelled.state==='skipped'&&!cancelled.transport_attempted_at&&providerRequests===beforePause);await control('resume');
 const restart=runtime();try{check(await restart.tick()===0&&await restart.tickWaiting()===0);}finally{await restart.stop();}
 input.stage('wechat-wait-human');const humanId=await prepared();await human();const beforeHuman=providerRequests,answered=await dispatch(humanId);
 check(answered.state==='skipped'&&!answered.transport_attempted_at&&providerRequests===beforeHuman);
 input.stage('wechat-wait-revoke');const revokeId=await prepared();await grant(false);const beforeRevoke=providerRequests,revoked=await dispatch(revokeId);
 check(revoked.state==='skipped'&&!revoked.transport_attempted_at&&providerRequests===beforeRevoke);await grant(true);
 input.stage('wechat-wait-native-race');const raceId=await prepared();fault='human_before_permit';const beforeRace=providerRequests,race=await dispatch(raceId);
 check(race.state==='failed'&&race.transport_attempted_at&&providerRequests===beforeRace);
 input.stage('wechat-wait-rate-limited');const rateId=await prepared();fault='rate_limited';const rate=await dispatch(rateId);
 check(rate.state==='failed'&&rate.transport_attempted_at);
 const outcome=(await db.query('SELECT reason,provider_code FROM automatic_reception_wechat_outcomes WHERE job_id=$1',[rate.job_id])).rows[0];
 check(outcome.reason==='provider_rate_limited'&&outcome.provider_code===45009);
 input.stage('wechat-wait-lost-ack');const uncertainId=await prepared();fault='lost_ack';const uncertain=await dispatch(uncertainId);
 check(uncertain.state==='uncertain'&&uncertain.wait_state==='finished'&&uncertain.transport_attempted_at);
 const models=input.models(),sent=providerRequests,permits=permitCalls,replay=runtime();
 try{check(await replay.tick()===0&&await replay.tickWaiting()===0);}finally{await replay.stop();}
 check(input.models()===models&&providerRequests===sent&&permitCalls===permits);
 await grant(false);
 input.stage('wechat-wait-history-after-revoke');
 check(Number((await db.query('SELECT count(*) n FROM automatic_reception_wechat_history')).rows[0].n)===1);
 const history=()=>createAutomaticWeChatHistoryWorker(db,{origin:'http://fixture-native:3000',secret,enabled:()=>true,fetcher:transport});
 historyFault=true;const firstHistory=history();try{check(await firstHistory.tick()===1);}finally{await firstHistory.stop();}
 const pending=(await db.query('SELECT * FROM automatic_reception_wechat_history WHERE job_id=$1',[accepted.job_id])).rows[0];
 check(pending.state==='pending'&&pending.attempts===1);
 const sleep=new Date(pending.next_attempt_at).getTime()-Date.now();if(sleep>0)await new Promise(r=>setTimeout(r,sleep+30));
 const secondHistory=history();try{check(await secondHistory.tick()===1&&await secondHistory.tick()===0);}finally{await secondHistory.stop();}
 const recorded=(await db.query('SELECT * FROM automatic_reception_wechat_history WHERE job_id=$1',[accepted.job_id])).rows[0];
 check(recorded.state==='recorded'&&recorded.attempts===2&&historyRequests===2);
 const publicRows=(await nativeDb.query(`SELECT m.content,m.private,m.sender_type,r.source_message_id::text FROM messages m
  JOIN replynest_wechat_history_receipts r ON r.message_id=m.id WHERE r.id=$1 AND m.account_id=$2 AND m.inbox_id=$3`,[accepted.job_id,seed.account,seed.inbox])).rows;
 check(publicRows.length===1&&publicRows[0].content===input.answer&&!publicRows[0].private&&publicRows[0].sender_type==='AgentBot'&&publicRows[0].source_message_id===id);
 check(providerRequests===sent&&permitCalls===permits&&input.models()===models);
 await nativeDb.query('UPDATE contacts SET identifier=$2,custom_attributes=$3 WHERE id=$1',[seed.contact,old.identifier,old.custom_attributes]);
 return {checks,providerRequests,permitCalls,tokenReads,historyMessages:publicRows.length};
}
