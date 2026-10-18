import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLearnedReceptionStyle,createReceptionStyleLearningWorker,resolveReceptionTone} from './reception-style-learning-worker.js';
const style={status:'suggestion',tone:'friendly_detailed',sampleMessages:9,sampleConversations:3,medianReplyCharacters:20,
 politeGreetingRate:1,friendlyMarkerRate:1,emojiRate:0};
test('finite style boundary rejects transcripts, invalid rates and invented sufficient-history claims',()=>{
 assert.equal(parseLearnedReceptionStyle(style).tone,'friendly_detailed');
 for(const change of [{raw:'private'},{sampleMessages:7},{sampleConversations:2},{sampleMessages:81},{emojiRate:NaN},
  {friendlyMarkerRate:2},{tone:'female'},{medianReplyCharacters:-1},{status:'approved'},{sampleMessages:'9'}])assert.throws(()=>parseLearnedReceptionStyle({...style,...change}));
 assert.equal(parseLearnedReceptionStyle({...style,status:'insufficient_history',tone:'neutral',sampleMessages:0,sampleConversations:0,medianReplyCharacters:0,politeGreetingRate:0,friendlyMarkerRate:0}).status,'insufficient_history');
 assert.throws(()=>parseLearnedReceptionStyle({...style,tone:'concise'}));
 assert.throws(()=>parseLearnedReceptionStyle({...style,status:'insufficient_history',sampleMessages:1,sampleConversations:1}));
});
test('default-off worker and resolver perform no database/history/model access; batch inputs are bounded',async()=>{
 const db={connect:async()=>assert.fail('no DB')} as any,reader={read:async()=>assert.fail('no history')};
 const worker=createReceptionStyleLearningWorker(db,reader);
 assert.deepEqual(await worker.batch(),{state:'disabled',scanned:0,refreshed:0,skipped:0,failed:0,nextTenant:null});
 assert.equal(await resolveReceptionTone(db,'a','automatic'),'neutral');
 for(const input of [{limit:0},{limit:21},{limit:1.5},{afterTenant:';SQL'},{allTenants:true}])await assert.rejects(()=>worker.batch(input as any),/invalid_style_batch/);
 await assert.rejects(()=>resolveReceptionTone(db,'../a','draft'),/invalid_tone_scope/);
});
function fixture(){
 const state={connections:0,grant:true,queries:[] as {sql:string;values:any[]}[],rows:[] as any[],revision:'2',learn:true,
  profile:{style,profile_grant_id:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',profile_account_id:'2',profile_settings_revision:'2'} as any};
 const db={connect:async()=>{state.connections++;return {release:()=>{state.connections--;},query:async(sql:string,values:any[]=[])=>{
  state.queries.push({sql,values});
  if(sql.startsWith('SELECT s.tenant_id'))return {rows:state.rows};
  if(sql.startsWith('SELECT g.account_id'))return {rows:[{account:'2',grant_id:state.profile.profile_grant_id,revision:state.revision}]};
  if(sql.startsWith('SELECT 1 FROM reception_history_grants'))return {rows:state.grant?[{}]:[],rowCount:state.grant?1:0};
  if(sql.startsWith('SELECT 1 FROM reception_personalization_settings'))return {rows:[],rowCount:state.learn&&values[1]===state.revision?1:0};
  if(sql.startsWith('INSERT INTO reception_learned_styles'))return {rows:[{}],rowCount:1};
  if(sql.startsWith('UPDATE reception_learned_styles'))return {rows:[],rowCount:1};
  if(sql.startsWith('SELECT draft_tone'))return {rows:[{draft_tone:'concise',automatic_tone:'neutral',revision:state.revision,learn_from_human:state.learn}]};
  if(sql.startsWith('SELECT style'))return {rows:state.profile?[state.profile]:[]};
  return {rows:[],rowCount:0};
 }};}} as any;return {db,state};
}
test('refresh releases connection during bounded reader I/O; saves aggregate not transcripts and uses stable keyset',async()=>{
 const f=fixture();f.state.rows=[{tenant_id:'a'}];let calls=0;
 const w=createReceptionStyleLearningWorker(f.db,{read:async scope=>{calls++;assert.equal(f.state.connections,0);assert.equal(scope.purpose,'style');
  return {purpose:'style',style:style as any,sampleDigest:'a'.repeat(64),scanned:9,pages:1,asOf:'2026-10-06T00:00:00.000000Z'};
 }},{enabled:()=>true});
 const r=await w.batch({afterTenant:'previous',limit:2});assert.equal(r.refreshed,1);assert.equal(r.nextTenant,'a');assert.equal(calls,1);
 const page=f.state.queries.find(q=>q.sql.startsWith('SELECT s.tenant_id'))!;assert.deepEqual(page.values,['previous',2]);assert.match(page.sql,/ORDER BY s.tenant_id LIMIT/);
 const update=f.state.queries.find(q=>q.sql.startsWith('UPDATE reception_learned_styles SET style'))!;assert.equal(update.values[2].tone,'friendly_detailed');
 assert.equal(Object.hasOwn(update.values[2],'messages'),false);assert.match(update.sql,/lease_until>clock_timestamp/);assert.equal(f.state.connections,0);
});
test('authorization/settings/gate changes during read discard sample and release exact owned lease only',async()=>{
 for(const change of ['grant','revision','learn','gate']){
  const f=fixture();f.state.rows=[{tenant_id:'a'}];let enabled=true;
  const w=createReceptionStyleLearningWorker(f.db,{read:async()=>{if(change==='grant')f.state.grant=false;if(change==='revision')f.state.revision='3';if(change==='learn')f.state.learn=false;if(change==='gate')enabled=false;
   return {purpose:'style',style:style as any,sampleDigest:'a'.repeat(64),scanned:9,pages:1,asOf:'2026-10-06T00:00:00.000000Z'};
  }},{enabled:()=>enabled});
  const r=await w.batch();assert.equal(r.refreshed,0);assert.equal(r.skipped,1);
  assert.ok(!f.state.queries.some(q=>q.sql.startsWith('UPDATE reception_learned_styles SET style')));
  const release=f.state.queries.find(q=>q.sql.startsWith('UPDATE reception_learned_styles SET lease_id'))!;
  assert.match(release.sql,/WHERE tenant_id=\$1 AND lease_id=\$2/);assert.equal(f.state.connections,0);
 }
});
test('uncertain history is not retried; errors contain counters not transcript/private exception',async()=>{
 const f=fixture();f.state.rows=[{tenant_id:'a'}];let calls=0;
 const w=createReceptionStyleLearningWorker(f.db,{read:async()=>{calls++;throw Error('private_payload');}},{enabled:()=>true});
 const r=await w.batch();assert.equal(r.failed,1);assert.equal(calls,1);assert.ok(!JSON.stringify(r).includes('private_payload'));
 assert.equal(f.state.connections,0);assert.ok(f.state.queries.some(q=>/15 minutes/.test(q.sql)));
});
test('tone resolver respects mode presets and rejects stale/revoked/malformed/insufficient learned profile',async()=>{
 const f=fixture();assert.equal(await resolveReceptionTone(f.db,'a','draft',{enabled:()=>true}),'friendly_detailed');
 f.state.grant=false;assert.equal(await resolveReceptionTone(f.db,'a','draft',{enabled:()=>true}),'concise');f.state.grant=true;
 f.state.profile.profile_settings_revision='1';assert.equal(await resolveReceptionTone(f.db,'a','automatic',{enabled:()=>true}),'neutral');f.state.profile.profile_settings_revision='2';
 f.state.profile.style={...style,messages:['private']};assert.equal(await resolveReceptionTone(f.db,'a','draft',{enabled:()=>true}),'concise');
 f.state.profile.style={...style,status:'insufficient_history',tone:'neutral',sampleMessages:2,sampleConversations:1};
 assert.equal(await resolveReceptionTone(f.db,'a','draft',{enabled:()=>true}),'concise');
 f.state.learn=false;assert.equal(await resolveReceptionTone(f.db,'a','draft',{enabled:()=>true}),'concise');assert.equal(f.state.connections,0);
});
