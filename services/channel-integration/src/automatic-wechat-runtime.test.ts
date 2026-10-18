import test from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {createAutomaticWeChatRuntime} from './automatic-wechat-runtime.js';
import {createAutomaticWeChatAdapter} from './automatic-wechat-adapter.js';
import {createAutomaticWeChatIntake} from './automatic-wechat-intake.js';
import {createAutomaticReceptionQueue} from './automatic-reception-queue.js';
import {recordAutomaticWeChatOutcome} from './automatic-wechat-outcome.js';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
import type {AutomaticWeChatResult} from './automatic-wechat-transport.js';
import type {AutomaticReceptionAdapter} from './automatic-reception-runtime.js';
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const lease:AutomaticReceptionLease={tenantId:'synthetic',jobId:'11111111-1111-4111-8111-111111111111',
 workerToken:'22222222-2222-4222-8222-222222222222',authorizationId:'33333333-3333-4333-8333-333333333333',
 customerId:'44444444-4444-4444-8444-444444444444',connectionId:'55555555-5555-4555-8555-555555555555',
 accountId:'1',conversationId:'2',messageId:'3',channel:'wechat_official_account',consentVersion:'automatic-send-v1'};
function forbidden(){
 let calls=0;
 const fail=async()=>{calls++;throw Error('unexpected_io');};
 return {db:{query:fail,connect:fail} as unknown as Pool,
  options:{origin:'http://isolated.invalid',secret:'isolated-runtime-secret-00000000000000',generate:fail,resolveAccessToken:fail,fetcher:fail},
  get calls(){return calls;}};
}
test('公众号执行组合缺省关闭，不连接数据库、不启用定时器或读取密钥',async()=>{
 const f=forbidden();let timers=0;
 const runtime=createAutomaticWeChatRuntime(f.db,{...f.options,schedule:()=>{timers++;return ()=>{};}});
 runtime.start();assert.equal(await runtime.tick(),0);await runtime.stop();await runtime.stop();
 assert.equal(await runtime.tick(),0);assert.throws(()=>runtime.start(),/stopping/);assert.equal(timers,0);assert.equal(f.calls,0);
});
test('关闭的公众号适配器直接调用也不读取客户或请求模型',async()=>{
 const f=forbidden(),a=createAutomaticWeChatAdapter(f.db,f.options),facts=await a.facts(lease);
 assert.equal(facts.executorAvailable,false);assert.equal(facts.pointsAvailable,false);assert.equal(facts.consentVersion,null);
 await assert.rejects(()=>a.generate(lease),/unavailable/);assert.equal(f.calls,0);
});
test('队列只接受固定渠道族，微信和网站工作器使用不同数据库锁',async()=>{
 const f=forbidden();
 assert.throws(()=>createAutomaticReceptionQueue(f.db,{adapter:{} as AutomaticReceptionAdapter,channelFamily:'other' as 'wechat'}),/invalid_automatic_queue_family/);
 const slots:number[]=[],released:boolean[]=[];
 const db={connect:async()=>({query:async(_sql:string,args:number[])=>{slots.push(args[0]!);return {rows:[{locked:false}]};},release:(destroy:boolean)=>released.push(destroy)})} as unknown as Pool;
 for(const family of ['web','wechat'] as const){const q=createAutomaticReceptionQueue(db,{enabled:()=>true,adapter:{} as AutomaticReceptionAdapter,channelFamily:family});assert.equal(await q.tick(),0);await q.stop();}
 assert.deepEqual(slots,[2,3]);assert.deepEqual(released,[false,false]);assert.equal(f.calls,0);
});
test('公众号入队获取失败可重新运行，停止后禁止新连接',async()=>{
 const f=forbidden(),q=createAutomaticWeChatIntake(f.db,{enabled:()=>true});
 await assert.rejects(()=>q.tick(),/unexpected_io/);await flush();await assert.rejects(()=>q.tick(),/unexpected_io/);await flush();
 await q.stop();assert.equal(await q.tick(),0);assert.equal(f.calls,2);
});
function intakeProbe(anchor:unknown='1791345124000'){
 const queries:Array<{sql:string;args:unknown[]}>=[];
 const db={connect:async()=>({query:async(sql:string,args:unknown[]=[])=>{
  queries.push({sql,args});
  if(sql.includes('pg_try_advisory_xact_lock'))return {rows:[{held:true}]};
  if(sql.includes('admission_ms'))return {rows:[{admission_ms:anchor}]};
  if(sql.includes('SELECT count(*)'))return {rows:[{n:0}]};
  return {rows:[]};
 },release:()=>{}})} as unknown as Pool;
 return {db,queries};
}
test('公众号新入队以数据库时钟锚定启动边界，批次复用且不依赖应用墙钟',async()=>{
 const p=intakeProbe();let mono=1000;
 const q=createAutomaticWeChatIntake(p.db,{enabled:()=>true,monotonicNow:()=>mono});
 mono=4500;assert.equal(await q.tick(),0);await flush();mono=9000;assert.equal(await q.tick(),0);await q.stop();
 const clocks=p.queries.filter(v=>v.sql.includes('admission_ms'));
 assert.equal(clocks.length,1);assert.deepEqual(clocks[0]!.args,[3500]);
 const scans=p.queries.filter(v=>v.sql.startsWith('SELECT * FROM'));
 assert.equal(scans.length,2);assert.deepEqual(scans[0]!.args,[new Date(1791345124000).toISOString(),new Date(1791345124000).toISOString()]);
 assert.deepEqual(scans[1]!.args,scans[0]!.args);
 const sql=scans[0]!.sql;
 assert.match(sql,/e\.created_at>=\$1::timestamptz/);
 assert.match(sql,/occurred_at'>=\$2::text/);
 assert.match(sql,/r\.source_occurred_at>=\$1::timestamptz/);
 assert.match(sql,/GREATEST\(g\.updated_at,wg\.created_at\)/);
 assert.match(sql,/NOT EXISTS\(SELECT 1 FROM automatic_reception_jobs/);
 assert.match(sql,/candidates ORDER BY at,tenant_id LIMIT 20$/);
 assert.equal(p.queries.some(v=>/UPDATE automatic_reception_jobs|DELETE/.test(v.sql)),false);
});
test('入队观察到关闭后重新开启必须建立新边界；关闭期间不连接数据库',async()=>{
 const p=intakeProbe();let on=false,mono=1000;
 const q=createAutomaticWeChatIntake(p.db,{enabled:()=>on,monotonicNow:()=>mono});
 assert.equal(await q.tick(),0);assert.equal(p.queries.length,0);
 on=true;mono=2000;await q.tick();await flush();
 on=false;mono=5000;const before=p.queries.length;await q.tick();assert.equal(p.queries.length,before);
 on=true;mono=9000;await q.tick();await q.stop();
 assert.deepEqual(p.queries.filter(v=>v.sql.includes('admission_ms')).map(v=>v.args),[[0],[0]]);
});
test('数据库启动边界异常时回滚，不扫描历史或修改任何任务',async()=>{
 for(const bad of [null,'not-a-time','0','-1','9007199254740992']){
  const p=intakeProbe(bad),q=createAutomaticWeChatIntake(p.db,{enabled:()=>true,monotonicNow:()=>1000});
  await assert.rejects(q.tick(),/invalid_wechat_admission_clock/);await flush();await q.stop();
  assert.equal(p.queries.some(v=>v.sql.startsWith('SELECT * FROM')),false);
  assert.ok(p.queries.some(v=>v.sql==='ROLLBACK'));
 }
});
test('单调时钟倒退时拒绝入队，不把它变成更早的历史准入边界',async()=>{
 const p=intakeProbe();let mono=1000;
 const q=createAutomaticWeChatIntake(p.db,{enabled:()=>true,monotonicNow:()=>mono});mono=999;
 await assert.rejects(q.tick(),/invalid_wechat_admission_clock/);await flush();await q.stop();
 assert.equal(p.queries.some(v=>v.sql.includes('admission_ms')),false);
});
test('运行组合批次不重叠，停止等待正在入队的数据库连接释放',async()=>{
 let release!:()=>void,connects=0,releases=0;
 const gate=new Promise<void>(r=>{release=r;});
 const db={connect:async()=>{connects++;await gate;return {query:async()=>({rows:[{held:false}]}),release:()=>{releases++;}};}} as unknown as Pool;
 const f=forbidden(),runtime=createAutomaticWeChatRuntime(db,{...f.options,enabled:()=>true});
 const first=runtime.tick();await flush();assert.equal(await runtime.tick(),0);
 let done=false;const stop=runtime.stop().then(()=>{done=true;});await flush();assert.equal(done,false);
 release();assert.equal(await first,0);await stop;assert.equal(connects,1);assert.equal(releases,1);assert.equal(f.calls,0);
});
test('运行组合停止期间发生数据库错误，不泄漏原始错误或继续安排任务',async()=>{
 let reject!:()=>void,connects=0;
 const gate=new Promise<never>((_resolve,fail)=>{reject=()=>fail(Error('private raw database error'));});
 const f=forbidden(),db={connect:async()=>{connects++;return gate;}} as unknown as Pool;
 const runtime=createAutomaticWeChatRuntime(db,{...f.options,enabled:()=>true});
 const p=runtime.tick(),check=assert.rejects(p,/private raw database error/);await flush();
 const stop=runtime.stop(),stopped=assert.rejects(stop,/^Error: automatic_wechat_stop_failed$/);reject();await check;await stopped;
 assert.equal(await runtime.tick(),0);assert.equal(connects,1);assert.equal(f.calls,0);
});
test('公众号定时器只启动一次，关闭开关后不执行批次，停止取消定时器',async()=>{
 const f=forbidden(),callbacks:Array<()=>void>=[];let on=true,cancelled=0;
 const runtime=createAutomaticWeChatRuntime(f.db,{...f.options,enabled:()=>on,schedule:fn=>{callbacks.push(fn);return ()=>{cancelled++;};}});
 runtime.start();runtime.start();assert.equal(callbacks.length,1);on=false;callbacks[0]!();await flush();assert.equal(f.calls,0);
 await runtime.stop();assert.equal(cancelled,1);callbacks.at(-1)!();await flush();assert.equal(callbacks.length,2);
});
test('发送结果校验拒绝原始错误、伪造送达编号和异常供应商码，零数据库访问',async()=>{
 const f=forbidden();
 const bad=[{outcome:'rejected',reason:'raw secret error'},
  {outcome:'accepted',receipt:{provider:'shared_wechat',acknowledged:true}},
  {outcome:'accepted',receipt:{provider:'wechat_official_account',acknowledged:true,providerMessageId:'fake'}},
  ...[0,-1,1.5,NaN,2147483648].map(providerCode=>({outcome:'rejected',reason:'provider_rejected',providerCode}))];
 for(const r of bad)await assert.rejects(()=>recordAutomaticWeChatOutcome(f.db,lease,'合成答复',r as AutomaticWeChatResult),/invalid_wechat_outcome/);
 await assert.rejects(()=>recordAutomaticWeChatOutcome(f.db,lease,'字'.repeat(601),{outcome:'accepted',receipt:{provider:'wechat_official_account',acknowledged:true}}),/invalid_wechat_outcome/);
 assert.equal(f.calls,0);
});
test('公众号到期调度独立于入队模型批次，关闭后不读数据或密钥',async()=>{
 const f=forbidden(),delays:number[]=[],callbacks:Array<()=>void>=[];let on=true;
 const runtime=createAutomaticWeChatRuntime(f.db,{...f.options,enabled:()=>on,
  timing:{presentationOptions:{enabled:()=>true},currentPresentation:async()=>false},
  schedule:(fn,ms)=>{callbacks.push(fn);delays.push(ms);return ()=>{};}});
 runtime.start();runtime.start();assert.deepEqual(delays,[3000,500]);on=false;callbacks.forEach(fn=>fn());
 await flush();assert.equal(await runtime.tickWaiting(),0);await runtime.stop();assert.equal(f.calls,0);
});
