/** Shared-channel actual routing/HTTP/native fences; synthetic vendor only.
 * Existing fixture contacts are explicitly linked; never a live provisioner. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {receptionFixtureSqlGuards,waitForFixtureDatabaseDue,waitForFixtureRecordedIngressClock} from './reception-fixture-sql-guards.js';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
import type {ReceptionDraft} from './reception-executor.js';
import type {AutomaticReplyWaitPresentation} from './automatic-reply-wait-runtime.js';
import {createAutomaticWeChatRuntime} from './automatic-wechat-runtime.js';
import {createAutomaticWeChatHistoryWorker} from './automatic-wechat-history-worker.js';
import {createAutomaticNativeClient} from './automatic-web-native-client.js';
import {recordSharedWechatEvent,type VerifiedSharedEvent} from './shared-wechat-store.js';
import {sceneToken} from './shared-wechat-routing.js';
import {deliverSharedWechatInbound} from './shared-wechat-delivery.js';
import {createSharedWechatTransport} from './shared-wechat-transport.js';
import {ensureSharedWechatCustomer} from './shared-wechat-customer.js';
import {manageAutomaticWeChatGrant,AUTOMATIC_WECHAT_DISCLOSURE_VERSION} from './automatic-wechat-management.js';

export type SharedWaitSeed={tenant:string;account:string;contact:string;human:string;inbox:string;conversation:string;display:string;contactKey:string};
export async function testSharedWaitNative(input:{db:Pool;owner:Pool;nativeDb:Pool;root:Pool;seeds:SharedWaitSeed[];customer:string;actor:string;token:string;
 secret:string;question:string;answer:string;models:()=>number;balance:()=>Promise<number>;
 generate:(l:AutomaticReceptionLease,q:string)=>Promise<ReceptionDraft>;presentation:()=>AutomaticReplyWaitPresentation;stage:(s:string)=>void;}){
 assert.equal(process.env.RECEPTION_REPLY_WAIT_NATIVE_HTTP,'isolated-reply-wait-native');
 const {db,owner,nativeDb,root,seeds,customer,actor,secret}=input,[a,b]=seeds;
 assert.deepEqual(seeds.map(s=>s.tenant),['monthly','credits']);
 const app='wx6666666666666666',openid='isolated-shared-durable-user';
 let checks=0,providerRequests=0,permitCalls=0,tokenReads=0,lastTransitionAt=0;
 let fault:'none'|'switch_after_permit'|'enrollment_after_permit'='none';
 const check=(v:unknown)=>{if(!v)console.error(JSON.stringify({status:'shared_inner_assertion_diagnostic',checkIndex:checks,fault}));assert.ok(v,'shared_wait_check_'+checks);checks++;};
 async function noSqlLocks(){check(Number((await root.query(receptionFixtureSqlGuards)).rows[0].n)===0);}
 async function event(value:Pick<VerifiedSharedEvent,'kind'|'text'|'event'|'eventKey'>){
  // Synthetic ingress must use the same isolated authoritative clock as its
  // grant/routing records. Do not manufacture a future callback with Node time.
  const deadline=performance.now()+3000;let occurredAt:number;
  for(;;){occurredAt=Number((await db.query('SELECT floor(EXTRACT(EPOCH FROM clock_timestamp())*1000)::float8 now')).rows[0].now);
   if(!Number.isSafeInteger(occurredAt))throw Error('fixture_shared_clock_invalid');
   if(occurredAt>lastTransitionAt)break;
   if(performance.now()>=deadline)throw Error('fixture_shared_transition_clock_deadline');
   await new Promise(r=>setTimeout(r,10));
  }
  const id='shared-durable-'+randomUUID();
  const result=await recordSharedWechatEvent(db,{appId:app,openId:openid,eventId:id,occurredAt,...value});
  lastTransitionAt=result.decision.state.lastTransitionAt;check(!result.duplicate);return {id,result};
 }
 async function select(tenant:string){
  const choices=await event({kind:'text',text:'切换商家'});check(choices.result.decision.action==='choose');
  const code=choices.result.decision.state.choices!.items.find(c=>c.tenantId===tenant)!.code;
  const selected=await event({kind:'text',text:'选择 '+code});check(selected.result.decision.action==='entered'&&selected.result.decision.tenantId===tenant);
 }
 const merchantName=String((await db.query("SELECT name FROM tenants WHERE tenant_id='monthly'")).rows[0].name);
 const transport:typeof fetch=async(url,init)=>{
  await noSqlLocks();const u=new URL(String(url));
  if(u.origin==='http://fixture-native:3000'){
   check(u.pathname.startsWith('/internal/saas_sso/')||u.pathname.startsWith('/api/v1/accounts/'));
   if(u.pathname.endsWith('/automatic_wechat/authorize'))permitCalls++;
   const response=await fetch(url,init);
   if(u.pathname.endsWith('/automatic_wechat/authorize')&&fault!=='none'){
    check(response.ok&&(await response.clone().json() as any).state==='transport_authorized');
    const action=fault;fault='none';
    if(action==='switch_after_permit')await select('credits');
    else await owner.query("UPDATE shared_wechat_enrollments SET enabled=false WHERE app_id=$1 AND tenant_id='monthly'",[app]);
   }
   return response;
  }
  check(u.origin==='https://api.weixin.qq.com'&&u.pathname==='/cgi-bin/message/custom/send');
  check(u.searchParams.get('access_token')==='isolated-shared-durable-token');
  const body=JSON.parse(String(init?.body));check(body.touser===openid&&body.text.content===`【${merchantName}】\n${input.answer}`&&body.aimsgcontext.is_ai_msg===0);
  providerRequests++;return Response.json({errcode:0,errmsg:'ok'});
 };
 const incomingTransport=createSharedWechatTransport({chatwootBaseUrl:'http://fixture-native:3000',chatwootToken:'isolated-shared-wait-native-token',fetcher:transport,
  liveSendEnabled:false,resolveWeChat:async()=>{throw Error('manual shared sender forbidden');}});
 const native=createAutomaticNativeClient({origin:'http://fixture-native:3000',secret,fetcher:transport});
 function runtime(){return createAutomaticWeChatRuntime(db,{origin:'http://fixture-native:3000',secret,enabled:()=>true,fetcher:transport,
  generate:input.generate,timing:input.presentation(),resolveAccessToken:async(l,appId)=>{
   check(l.tenantId==='monthly'&&l.channel==='shared_wechat'&&l.connectionId===null&&appId===app);tokenReads++;
   return {appId,accessToken:'isolated-shared-durable-token'};
  }});}
 async function saved(id:string){return (await db.query(`SELECT j.job_id,j.state,j.reason,j.receipt,j.transport_attempted_at,w.state wait_state,w.due_at
  FROM automatic_reception_jobs j LEFT JOIN automatic_reply_waits w USING(job_id) WHERE j.tenant_id='monthly' AND j.channel='shared_wechat' AND j.message_id=$1`,[id])).rows[0];}
 async function incoming(expected:string='monthly'){
  const e=await event({kind:'text',text:input.question});check(e.result.decision.action==='route'&&e.result.decision.tenantId===expected);
  check(await deliverSharedWechatInbound(db,app,e.id,incomingTransport)==='delivered');
  check(await deliverSharedWechatInbound(db,app,e.id,incomingTransport)==='duplicate');
  const target=seeds.find(s=>s.tenant===expected)!;await ensureSharedWechatCustomer(db,expected,target.display);
  const digest=createHash('sha256').update(JSON.stringify([app,expected,openid])).digest('hex');
  // Known fixture contacts share the seeded historical customer only INSIDE A;
  // B retains its separate business customer, never merged across tenants.
  if(expected==='monthly')await owner.query("UPDATE channel_identities SET customer_id=$2 WHERE tenant_id='monthly' AND channel='shared_wechat' AND external_user_id=$1",[digest,customer]);
  const id=String((await db.query("SELECT upstream_message_id FROM shared_wechat_deliveries WHERE app_id=$1 AND command_id=$2 AND direction='in'",[app,e.id])).rows[0].upstream_message_id);
  const written=(await nativeDb.query('SELECT account_id::text,inbox_id::text,conversation_id::text FROM messages WHERE id=$1',[id])).rows[0];
  check(written.account_id===target.account&&written.inbox_id===target.inbox&&written.conversation_id===target.conversation);
  return id;
 }
 async function prepared(){const id=await incoming(),before=providerRequests,tokens=tokenReads,models=input.models(),balance=await input.balance(),r=runtime();
  await waitForFixtureRecordedIngressClock(db,app,id);
  try{const count=await r.tick();if(count!==1)console.error(JSON.stringify({status:'shared_intake_boundary_diagnostic',count,
   nodeClock:Date.now(),databaseClock:(await db.query('SELECT clock_timestamp() now')).rows[0],
   saved:await saved(id),admission:(await db.query(`SELECT d.status,d.direction,r.delivery_state,r.decision->>'action' action,
    r.source_occurred_at,d.created_at,g.updated_at primary_updated,wg.created_at channel_created,
    r.source_occurred_at>=GREATEST(g.updated_at,wg.created_at) after_grants,
    r.source_occurred_at<=clock_timestamp() not_future,g.enabled primary_enabled,wg.enabled channel_enabled,
    wg.channels,t.status tenant_status,s.ai_auto_reply_enabled,s.automatic_sending_enabled,s.automation_consent_version,
    (SELECT count(*) FROM shared_wechat_threads b JOIN channel_identities i ON i.tenant_id=d.tenant_id AND i.channel='shared_wechat'
      AND i.channel_connection_id IS NULL AND i.chatwoot_contact_id=b.contact_id AND i.chatwoot_conversation_id=b.conversation_id
     WHERE b.app_id=d.app_id AND b.tenant_id=d.tenant_id AND b.open_id=d.open_id AND b.account_id=t.chatwoot_account_id) identities,
    (SELECT count(*) FROM automatic_reception_jobs WHERE state IN('queued','processing','submitting')) pending,
    (SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=714201 AND objid IN(1,3) AND granted) admission_locks
    FROM shared_wechat_deliveries d JOIN shared_wechat_receipts r ON r.app_id=d.app_id AND r.event_id=d.command_id
    JOIN tenants t ON t.tenant_id=d.tenant_id JOIN automatic_reception_grants g ON g.tenant_id=d.tenant_id
    JOIN automatic_reception_wechat_grants wg ON wg.tenant_id=d.tenant_id JOIN tenant_ai_settings s ON s.tenant_id=d.tenant_id
    WHERE d.app_id=$1 AND d.upstream_message_id=$2 AND d.direction='in'`,[app,id])).rows}));check(count===1);}finally{await r.stop();}
  const s=await saved(id);if(s?.wait_state!=='waiting')console.error(JSON.stringify({status:'shared_wait_preparation_failed',state:s?.state,reason:s?.reason,
   generation:(await db.query(`SELECT g.state,g.reason,g.attempted_at IS NOT NULL attempted,v.state verification_state,v.reason verification_reason,
    p.job_id IS NOT NULL prepared_history FROM automatic_reception_jobs j LEFT JOIN automatic_reception_generations g USING(job_id)
    LEFT JOIN automatic_reception_verifications v USING(job_id) LEFT JOIN automatic_reception_presentations p USING(job_id)
    WHERE j.tenant_id='monthly' AND j.channel='shared_wechat' AND j.message_id=$1`,[id])).rows}));
  check(s.state==='processing'&&s.wait_state==='waiting'&&!s.transport_attempted_at);
  check(providerRequests===before&&tokenReads===tokens&&input.models()===models+2&&await input.balance()>balance);return id;}
 async function dispatch(id:string){const s=await saved(id);await waitForFixtureDatabaseDue(db,s.job_id);check(true);
  const models=input.models(),balance=await input.balance(),r=runtime();
  try{const processed=await r.tickWaiting();if(processed!==1){const state=await saved(id);console.error(JSON.stringify({status:'shared_wait_dispatch_count',processed,
   state:state?.state,reason:state?.reason,waitState:state?.wait_state,dueAt:state?.due_at,clock:(await db.query('SELECT clock_timestamp() now')).rows[0]}));}
   check(processed===1);check(await r.tickWaiting()===0);}finally{await r.stop();}
  check(input.models()===models&&await input.balance()===balance);const result=await saved(id);
  console.error(JSON.stringify({status:'shared_dispatch_terminal_diagnostic',state:result.state,reason:result.reason,waitState:result.wait_state,
   attempted:Boolean(result.transport_attempted_at),providerRequests,permitCalls,fault}));return result;}
 async function grant(enabled:boolean){const row=(await db.query(`SELECT g.authorization_id,wg.grant_id FROM automatic_reception_grants g
  JOIN automatic_reception_wechat_grants wg USING(tenant_id) WHERE g.tenant_id='monthly'`)).rows[0];
  const result=await manageAutomaticWeChatGrant(db,input.token,enabled?{enabled:true,expected_authorization_id:row.authorization_id,expected_grant_id:row.grant_id,
   channels:['shared_wechat'],confirmed:true,consent_version:'wechat-automatic-send-v1',disclosure_version:AUTOMATIC_WECHAT_DISCLOSURE_VERSION}:
   {enabled:false,expected_authorization_id:row.authorization_id,expected_grant_id:row.grant_id},'monthly');check(result.wechat.grant?.enabled===enabled);}
 // Formal mode uses only the existing reviewed release ACL, never fixture grants.
 if(process.env.RECEPTION_FORMAL_RUNTIME!=='isolated-formal-reception'){
 await owner.query(`GRANT INSERT,UPDATE ON shared_wechat_routing_states,shared_wechat_receipts,shared_wechat_deliveries,shared_wechat_threads TO history_runtime;
  GRANT SELECT ON shared_wechat_scenes TO history_runtime;
  GRANT UPDATE(app_id) ON shared_wechat_accounts TO history_runtime;
  GRANT UPDATE(tenant_id) ON shared_wechat_enrollments,shared_wechat_inboxes,shared_wechat_scenes TO history_runtime;`);
 }
 await owner.query('INSERT INTO shared_wechat_accounts(app_id,enabled) VALUES($1,true)',[app]);
 const oldContacts=[];
 for(const s of seeds){
  check(s.contactKey==='rn_shared_'+createHash('sha256').update(JSON.stringify([app,s.tenant,openid])).digest('hex'));
  oldContacts.push((await nativeDb.query('SELECT identifier,custom_attributes FROM contacts WHERE id=$1',[s.contact])).rows[0]);
  await nativeDb.query("UPDATE contacts SET identifier=$2,custom_attributes=jsonb_build_object('source_channel','shared_wechat') WHERE id=$1",[s.contact,s.contactKey]);
  await owner.query('INSERT INTO shared_wechat_enrollments(app_id,tenant_id,enabled) VALUES($1,$2,true)',[app,s.tenant]);
  await owner.query('INSERT INTO shared_wechat_inboxes(app_id,tenant_id,account_id,inbox_id,enabled) VALUES($1,$2,$3,$4,true)',[app,s.tenant,s.account,s.inbox]);
  await owner.query('INSERT INTO shared_wechat_threads(app_id,tenant_id,open_id,account_id,inbox_id,conversation_id,contact_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
   [app,s.tenant,openid,s.account,s.inbox,s.display,s.contact]);
 }
 const scenes=seeds.map(()=>sceneToken());
 for(let i=0;i<seeds.length;i++)await owner.query('INSERT INTO shared_wechat_scenes(app_id,digest,tenant_id,expires_at) VALUES($1,$2,$3,NULL)',[app,scenes[i].digest,seeds[i].tenant]);
 await grant(true);
 input.stage('shared-wait-single-merchant');const first=await event({kind:'scan',event:'SCAN',eventKey:scenes[0].value});
 check(first.result.decision.action==='entered'&&first.result.decision.tenantId==='monthly'&&first.result.decision.state.associations.length===1);
 const id=await prepared(),accepted=await dispatch(id);check(accepted.state==='accepted'&&accepted.wait_state==='finished'&&accepted.transport_attempted_at);
 check(providerRequests===1&&accepted.receipt.provider==='shared_wechat'&&accepted.receipt.acknowledged===true);
 input.stage('shared-wait-add-merchant');const stale=await prepared(),scanB=await event({kind:'scan',event:'SCAN',eventKey:scenes[1].value});
 check(scanB.result.decision.action==='choose'&&scanB.result.decision.state.associations.length===2&&!scanB.result.decision.state.selected);
 const beforeSwitch=providerRequests,switched=await dispatch(stale);check(switched.state==='skipped'&&!switched.transport_attempted_at&&providerRequests===beforeSwitch);
 const noSelection=await event({kind:'text',text:input.question});check(noSelection.result.decision.action==='choose');
 check(await deliverSharedWechatInbound(db,app,noSelection.id,incomingTransport)==='blocked');
 await select('credits');const beforeBModels=input.models(),beforeBBalance=await input.balance(),bId=await incoming('credits'),bRuntime=runtime();
 try{check(await bRuntime.tick()===0&&await bRuntime.tickWaiting()===0);}finally{await bRuntime.stop();}
 check(input.models()===beforeBModels&&await input.balance()===beforeBBalance&&await saved(bId)===undefined&&providerRequests===beforeSwitch);
 const identities=(await db.query("SELECT tenant_id,customer_id,external_user_id FROM channel_identities WHERE channel='shared_wechat' AND external_user_id=ANY($1)",
  [seeds.map(s=>createHash('sha256').update(JSON.stringify([app,s.tenant,openid])).digest('hex'))])).rows;
 check(identities.length===2&&identities[0].customer_id!==identities[1].customer_id);
 input.stage('shared-wait-multi-merchant');await select('monthly');const multi=await prepared(),multiResult=await dispatch(multi);
 check(multiResult.state==='accepted'&&providerRequests===beforeSwitch+1);
 input.stage('shared-wait-switch-back-version');const oldVersion=await prepared();await select('credits');await select('monthly');const beforeVersion=providerRequests,changed=await dispatch(oldVersion);
 check(changed.state==='skipped'&&!changed.transport_attempted_at&&providerRequests===beforeVersion);
 input.stage('shared-wait-switch-after-native-permit');const raceId=await prepared();fault='switch_after_permit';const beforeRace=providerRequests,race=await dispatch(raceId);
 check(race.state==='failed'&&race.transport_attempted_at&&providerRequests===beforeRace);
 input.stage('shared-wait-enrollment-after-native-permit');await select('monthly');const disabledId=await prepared();fault='enrollment_after_permit';const beforeDisable=providerRequests,disabled=await dispatch(disabledId);
 if(!(disabled.state==='failed'&&disabled.transport_attempted_at&&providerRequests===beforeDisable))console.error(JSON.stringify({status:'shared_enrollment_boundary_diagnostic',
  state:disabled.state,reason:disabled.reason,waitState:disabled.wait_state,attempted:Boolean(disabled.transport_attempted_at),providerDelta:providerRequests-beforeDisable,fault}));
 check(disabled.state==='failed'&&disabled.transport_attempted_at&&providerRequests===beforeDisable);
 await owner.query("UPDATE shared_wechat_enrollments SET enabled=true WHERE app_id=$1 AND tenant_id='monthly'",[app]);
 const beforeReplays=input.models(),balance=await input.balance(),replay=runtime();try{check(await replay.tick()===0&&await replay.tickWaiting()===0);}finally{await replay.stop();}
 check(input.models()===beforeReplays&&await input.balance()===balance&&providerRequests===beforeDisable);
 await grant(false);
 input.stage('shared-wait-history-original-merchant');const history=createAutomaticWeChatHistoryWorker(db,{origin:'http://fixture-native:3000',secret,enabled:()=>true,fetcher:transport});
 try{check(await history.tick()===1&&await history.tick()===1&&await history.tick()===0);}finally{await history.stop();}
 const recorded=(await nativeDb.query(`SELECT m.content,m.private,m.account_id::text,m.inbox_id::text,r.source_message_id::text FROM messages m
  JOIN replynest_wechat_history_receipts r ON r.message_id=m.id WHERE r.provider='shared_wechat' ORDER BY m.id`)).rows;
 check(recorded.length===2&&recorded.every(m=>m.content===`【${merchantName}】\n${input.answer}`&&!m.private&&m.account_id===a.account&&m.inbox_id===a.inbox));
 check(recorded.map(m=>m.source_message_id).sort().join(',')===[id,multi].sort().join(',')&&providerRequests===beforeDisable&&input.models()===beforeReplays);
 for(let i=0;i<seeds.length;i++)await nativeDb.query('UPDATE contacts SET identifier=$2,custom_attributes=$3 WHERE id=$1',[seeds[i].contact,oldContacts[i].identifier,oldContacts[i].custom_attributes]);
 return {checks,providerRequests,permitCalls,historyMessages:recorded.length};
}
