import test from 'node:test';
import assert from 'node:assert/strict';
import {automaticReplyWaitSchema,automaticReplyWaitRuntimeAcl,claimDueAutomaticReply} from './automatic-reply-wait-store.js';
import {automaticReplyWaitDatabaseComponent} from './automatic-reply-wait-component.js';
import {createAutomaticReplyWaitRuntime} from './automatic-reply-wait-runtime.js';
const fail=async():Promise<never>=>{throw Error('must_not_access_db_native_or_model');};
test('unregistered/default-off wait runtime performs no DB/native/model work',async()=>{
 const runtime=createAutomaticReplyWaitRuntime({query:fail,connect:fail} as any,{family:'web',adapter:{enabled:()=>true} as any,
  question:fail,currentPresentation:fail,presentationOptions:{enabled:()=>true}});
 assert.equal(await runtime.tick(),0);await assert.rejects(()=>runtime.defer({channel:'web_chat'} as any,{} as any),/reply_wait_unavailable/);
 await runtime.stop();assert.equal(await runtime.tick(),0);
});
test('wait runtime requires BOTH independent execution and presentation gates',async()=>{
 for(const gates of [{adapter:false,presentation:true},{adapter:true,presentation:false}]){
  const runtime=createAutomaticReplyWaitRuntime({query:fail,connect:fail} as any,{family:'wechat',enabled:()=>true,
   adapter:{enabled:()=>gates.adapter} as any,presentationOptions:{enabled:()=>gates.presentation},question:fail,currentPresentation:fail});
  assert.equal(await runtime.tick(),0);await runtime.stop();
 }
});
test('finite family/ACL and owner-only component; waiting deadline is DB-derived and never rewritten',async()=>{
 assert.throws(()=>createAutomaticReplyWaitRuntime({} as any,{family:'model-chosen'} as any),/invalid/);
 await assert.rejects(()=>claimDueAutomaticReply({connect:fail} as any,'other' as any),/invalid/);
 const acl=automaticReplyWaitRuntimeAcl('wait_runtime');assert.match(acl,/UPDATE\(state,dispatch_token,claimed_at,finished_at,reason\)/);
 assert.doesNotMatch(acl,/UPDATE\(due_at|GRANT .*DELETE|GRANT .*TRUNCATE|SECURITY DEFINER/);
 for(const role of ['','Owner','bad; DROP'])assert.throws(()=>automaticReplyWaitRuntimeAcl(role),/invalid/);
 for(const guard of ['date_trunc(\'milliseconds\',j.created_at)','reply wait snapshot is immutable','reply dispatch claim is immutable','reply dispatch is not due',"OLD.state='claimed' AND NEW.state='finished'"])
  assert.ok(automaticReplyWaitSchema.includes(guard));
 assert.doesNotMatch(automaticReplyWaitSchema,/SECURITY DEFINER|NEW\.state='waiting'.*OLD\.state='claimed'/);
 const component=automaticReplyWaitDatabaseComponent();assert.equal(component.sql,automaticReplyWaitSchema);
 await assert.rejects(()=>component.migrate(),/owner_migration_required/);
});

test('verified gateway registration requires presentation first; other consumers never install waits',async()=>{
 const keys=['POSTGRES_HOST','POSTGRES_DATABASE','POSTGRES_USERNAME','POSTGRES_PASSWORD'] as const;
 const previous=keys.map(k=>process.env[k]);for(const k of keys)process.env[k]='isolated-wait-component-only';
 const {databaseComponents}=await import('./database-components.js');const {pool}=await import('./database.js');
 try{
  assert.ok(!databaseComponents({}).some(c=>c.name==='automatic_reply_wait'));
  assert.throws(()=>databaseComponents({AI_RECEPTION_REPLY_TIMING_ENABLED:'true'}),/verified_presentation_required/);
  const env={DATABASE_STARTUP_MODE:'verify',AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED:'true',AI_RECEPTION_SEMANTIC_ANSWERS_ENABLED:'true',
   AI_RECEPTION_PERSONALIZATION_MANAGEMENT_ENABLED:'true',AI_RECEPTION_AUTOMATIC_PRESENTATION_ENABLED:'true',AI_RECEPTION_REPLY_TIMING_ENABLED:'true'};
  const components=databaseComponents(env);
  assert.deepEqual(components.slice(-2).map(c=>c.name),['automatic_reception_presentation','automatic_reply_wait']);
  assert.equal(components.at(-1)?.sql,automaticReplyWaitSchema);
  await assert.rejects(()=>components.at(-1)!.migrate(),/owner_migration_required/);
  assert.deepEqual(databaseComponents(env,'knowledge').map(c=>c.name),['business']);
 }finally{await pool.end();for(let i=0;i<keys.length;i++){if(previous[i]===undefined)delete process.env[keys[i]];else process.env[keys[i]]=previous[i];}}
});
