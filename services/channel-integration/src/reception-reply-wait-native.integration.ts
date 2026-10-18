/** Actual isolated native HTTP writer; no vendor, production or real model calls. */
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {receptionFixtureSqlGuards,waitForFixtureDatabaseDue} from './reception-fixture-sql-guards.js';
import {createAutomaticGatewayRuntime} from './automatic-reception-gateway.js';
import {createAutomaticWebIngress} from './automatic-reception-queue.js';
import {createAutomaticNativeClient} from './automatic-web-native-client.js';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
import type {ReceptionDraft} from './reception-executor.js';
import type {AutomaticReplyWaitPresentation} from './automatic-reply-wait-runtime.js';

export type ReplyWaitNativeSeed={account:string;contact:string;human:string;inbox:string;conversation:string;display:string;bot:string};
export async function testReplyWaitNative(input:{db:Pool;owner:Pool;nativeDb:Pool;root:Pool;seed:ReplyWaitNativeSeed;customer:string;actor:string;
 connection:string;secret:string;question:string;answer:string;models:()=>number;balance:()=>Promise<number>;
 generate:(l:AutomaticReceptionLease,q:string)=>Promise<ReceptionDraft>;presentation:()=>AutomaticReplyWaitPresentation;
 stage:(s:string)=>void;}){
 assert.equal(process.env.RECEPTION_REPLY_WAIT_NATIVE_HTTP,'isolated-reply-wait-native');
 const {db,owner,nativeDb,root,seed,customer,actor,connection,secret}=input;
 for(const value of Object.values(seed))assert.match(value,/^[1-9]\d{0,18}$/);
 let checks=0,publicMessages=0,submitCalls=0,fault:'none'|'human_before_submit'|'lost_ack'='none';
 const check=(v:unknown)=>{assert.ok(v,'native_wait_check_'+checks);checks++;};
 async function noSqlLocks(){check(Number((await root.query(receptionFixtureSqlGuards)).rows[0].n)===0);}
 async function message(human=false){return String((await nativeDb.query(`INSERT INTO messages(account_id,inbox_id,conversation_id,message_type,content_type,content,private,status,sender_type,sender_id,content_attributes,created_at,updated_at)
 VALUES($1,$2,$3,$4,0,$5,false,0,$6,$7,'{}',clock_timestamp(),clock_timestamp()) RETURNING id`,
 [seed.account,seed.inbox,seed.conversation,human?1:0,human?'人工已开始处理':input.question,human?'User':'Contact',human?seed.human:seed.contact])).rows[0].id);}
 const transport:typeof fetch=async(url,init)=>{
  check(String(url).startsWith('http://fixture-native:3000/internal/saas_sso/'));await noSqlLocks();
  const submitting=String(url).endsWith('/automatic_replies/submit');
  if(submitting){submitCalls++;if(fault==='human_before_submit'){fault='none';await message(true);}}
  const response=await fetch(url,init);
  if(submitting&&fault==='lost_ack'){fault='none';check(response.ok);check((await response.clone().json() as any).state==='accepted');throw Error('isolated_lost_ack');}
  return response;
 };
 const native=createAutomaticNativeClient({origin:'http://fixture-native:3000',secret,fetcher:transport});
 const bridge='isolated-wait-ingress-secret-'+'1'.repeat(40);
 const ingress=createAutomaticWebIngress(db,{enabled:()=>true,secret:bridge,snapshot:native.snapshot});
 async function admit(id:string){const body=Buffer.from(JSON.stringify({event:'message_created',private:false,message_type:0,id,
  account:{id:seed.account},inbox:{id:seed.inbox},conversation:{id:seed.display}})),stamp=String(Math.floor(Date.now()/1000));
  return ingress(body,stamp,'v1='+createHmac('sha256',bridge).update(stamp+'.').update(body).digest('hex'));}
 function runtime(){return createAutomaticGatewayRuntime(db,{management:true,web:true,wechatManagement:false,wechat:false,wechatHistory:false,
  draftCallback:false,callback:true,timing:true,origin:'http://fixture-native:3000',nativeSecret:secret,bridgeSecret:bridge,token:'unused-fixture-read-token'},
  {generate:input.generate,draft:async()=>{throw Error('no legacy notes');},fetcher:transport,timing:input.presentation()});}
 async function saved(id:string){return (await db.query(`SELECT j.job_id,j.state,j.reason,j.receipt,j.transport_attempted_at,w.state wait_state,w.due_at,j.created_at,
  w.dispatch_token FROM automatic_reception_jobs j LEFT JOIN automatic_reply_waits w USING(job_id) WHERE j.tenant_id='monthly' AND j.message_id=$1`,[id])).rows[0];}
 async function count(id:string){return Number((await nativeDb.query("SELECT count(*) n FROM replynest_automatic_receipts WHERE account_id=$1 AND source_message_id=$2 AND result->>'state'='accepted'",[seed.account,id])).rows[0].n);}
 async function due(id:string){const s=await saved(id);await waitForFixtureDatabaseDue(db,s.job_id);check(true);}
 async function prepared(){const id=await message();check(await admit(id)==='queued');const r=runtime();
  try{check(await r.tick()===1);}finally{await r.stop();}
  const s=await saved(id);
  if(s.state!=='processing'||s.wait_state!=='waiting')console.error(JSON.stringify({status:'native_wait_preparation_failed',state:s.state,reason:s.reason,waitState:s.wait_state}));
  check(s.state==='processing'&&s.wait_state==='waiting'&&!s.transport_attempted_at);
  check(await count(id)===0);return id;}
 async function dispatch(id:string){await due(id);const before=input.models(),balance=await input.balance(),r=runtime();
  try{const processed=await r.tickWaiting();if(processed!==1){const state=await saved(id);console.error(JSON.stringify({status:'native_wait_dispatch_count',processed,
   state:state?.state,reason:state?.reason,waitState:state?.wait_state,dueAt:state?.due_at,clock:(await db.query('SELECT clock_timestamp() now')).rows[0]}));}
   check(processed===1);check(await r.tickWaiting()===0);}finally{await r.stop();}
  check(input.models()===before&&await input.balance()===balance);return saved(id);}
 async function control(operation:'pause'|'resume'){const previous=await native.customerControl(seed.account,customer);
  const state=await native.customerControl(seed.account,customer,{operation,minutes:operation==='pause'?10:0,revision:previous.revision,
   actor_id:actor,request_id:randomUUID(),conversation_id:seed.display,contact_id:seed.contact,native_actor_id:seed.human,permission_scope:'manager'});
  check(state.paused===(operation==='pause'));return state;}
 // Formal mode uses only the existing reviewed release ACL, never fixture grants.
 if(process.env.RECEPTION_FORMAL_RUNTIME!=='isolated-formal-reception'){
 await owner.query('GRANT SELECT,INSERT ON automatic_reception_jobs,automatic_reception_assessments TO history_runtime;GRANT UPDATE(transport_attempted_at) ON automatic_reception_jobs TO history_runtime');
 }
 await owner.query("UPDATE channel_connections SET configuration=jsonb_build_object('chatwoot_account_id',$2::text,'chatwoot_inbox_id',$3::text) WHERE connection_id=$1",[connection,seed.account,seed.inbox]);
 await owner.query("UPDATE channel_identities SET chatwoot_conversation_id=$2 WHERE tenant_id='monthly' AND channel_connection_id=$1",[connection,seed.display]);
 check(String((await nativeDb.query('SELECT assignee_id FROM conversations WHERE id=$1 AND account_id=$2',[seed.conversation,seed.account])).rows[0].assignee_id)===seed.human);
 input.stage('native-wait-assigned-restart');
 const id=await prepared(),s=await dispatch(id);
 if(s.state!=='accepted')console.error(JSON.stringify({status:'native_wait_terminal_diagnostic',state:s.state,reason:s.reason,
  waitState:s.wait_state,attempted:Boolean(s.transport_attempted_at),submitCalls,
  assessments:(await db.query("SELECT phase,assessment->>'reason' reason FROM automatic_reception_assessments WHERE job_id=$1",[s.job_id])).rows}));
 check(s.state==='accepted'&&s.wait_state==='finished'&&s.transport_attempted_at&&s.dispatch_token);
 const pub=(await nativeDb.query(`SELECT m.id::text,m.content,m.sender_type,m.sender_id::text,m.private,m.account_id::text,m.inbox_id::text,m.conversation_id::text,
  r.result FROM messages m JOIN replynest_automatic_receipts r ON (r.result->>'message_id')::bigint=m.id WHERE r.id=$1`,[s.job_id])).rows[0];
 check(pub.content===input.answer&&pub.sender_type==='AgentBot'&&pub.sender_id===seed.bot&&!pub.private&&pub.account_id===seed.account&&pub.inbox_id===seed.inbox&&pub.conversation_id===seed.conversation);
 check(s.receipt.providerMessageId===pub.id&&await count(id)===1);publicMessages++;
 const beforeRepeat=input.models(),sent=submitCalls;check(await admit(id)==='ignored');const replay=runtime();
 try{check(await replay.tick()===0&&await replay.tickWaiting()===0);}finally{await replay.stop();}check(input.models()===beforeRepeat&&submitCalls===sent);
 input.stage('native-wait-pause-resume');const pausedId=await prepared(),paused=await control('pause');
 check(new Date(paused.paused_until!).getTime()-Date.now()>590000);const cancelled=await dispatch(pausedId);
 check(cancelled.state==='skipped'&&cancelled.wait_state==='finished'&&!cancelled.transport_attempted_at&&await count(pausedId)===0);
 await control('resume');check(await admit(pausedId)==='ignored');
 input.stage('native-wait-human-reply');const humanId=await prepared();await message(true);const humanResult=await dispatch(humanId);
 check(humanResult.state==='skipped'&&humanResult.wait_state==='finished'&&!humanResult.transport_attempted_at&&await count(humanId)===0);
 input.stage('native-wait-authorization-revoked');const revokedId=await prepared();await owner.query("UPDATE automatic_reception_grants SET enabled=false WHERE tenant_id='monthly'");
 const revoked=await dispatch(revokedId);check(revoked.state==='skipped'&&revoked.wait_state==='finished'&&!revoked.transport_attempted_at&&await count(revokedId)===0);
 await owner.query("UPDATE automatic_reception_grants SET enabled=true WHERE tenant_id='monthly'");check(await admit(revokedId)==='duplicate');
 input.stage('native-wait-fence-race');const changedId=await prepared();fault='human_before_submit';const changed=await dispatch(changedId);
 check(changed.state==='failed'&&changed.wait_state==='finished'&&changed.transport_attempted_at&&await count(changedId)===0);
 input.stage('native-wait-lost-ack');const unknownId=await prepared();fault='lost_ack';const unknown=await dispatch(unknownId);
 check(unknown.state==='uncertain'&&unknown.wait_state==='finished'&&unknown.transport_attempted_at&&await count(unknownId)===1);publicMessages++;
 const before=input.models(),attempts=submitCalls,restarted=runtime();
 try{check(await restarted.tickWaiting()===0&&await restarted.tick()===0);}finally{await restarted.stop();}
 check(input.models()===before&&submitCalls===attempts&&await count(unknownId)===1);
 // Restore only the isolated mutable binding for subsequent legacy assertions.
 await owner.query("UPDATE channel_identities SET chatwoot_conversation_id=10 WHERE tenant_id='monthly' AND channel_connection_id=$1",[connection]);
 return {checks,publicMessages,submitCalls};
}
