import test from 'node:test';
import assert from 'node:assert/strict';
import type {Pool,PoolClient} from 'pg';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
import {loadAutomaticEvidence,assessStoredAutomaticEvidence} from './automatic-reception-evidence-store.js';
import {assessAutomaticEvidence} from './automatic-reception-evidence.js';
import {automaticSemanticPolicyAllowed} from './automatic-knowledge-verification.js';
import {manageAutomaticReception} from './automatic-reception-management.js';
import {createAutomaticManagementApi} from './automatic-reception-management-api.js';

const lease={tenantId:'synthetic',accountId:'1',authorizationId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
 channel:'web_chat',jobId:'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',workerToken:'cccccccc-1111-4111-8111-cccccccccccc'} as AutomaticReceptionLease;
const question='多久发货？',reply='通常在两个工作日内发货。';
const flags=['AI_RECEPTION_KNOWLEDGE_ANSWERS_ENABLED','AI_RECEPTION_SEMANTIC_ANSWERS_ENABLED','AI_RECEPTION_AUTOMATIC_PRESENTATION_ENABLED'];
async function isolatedFlags(run:()=>Promise<void>){
 const previous=flags.map(k=>process.env[k]);
 try{process.env[flags[0]]='true';process.env[flags[1]]='true';process.env[flags[2]]='false';await run();}
 finally{flags.forEach((k,i)=>{if(previous[i]===undefined)delete process.env[k];else process.env[k]=previous[i];});}
}
function evidenceDb(reason='semantic_generated'){
 const queries:string[]=[];
 const db={query:async(sql:string)=>{
  queries.push(sql);
  assert.doesNotMatch(sql,/FROM automatic_reception_answers/);
  if(sql.includes("current_setting('transaction_isolation')"))return {rowCount:1,rows:[{isolation:'read committed'}]};
  if(sql.includes('automatic_reception_revisions'))return {rowCount:1,rows:[{revision:'1'}]};
  if(sql.includes('FROM automatic_reception_grants g')||sql.includes('FROM automatic_reception_jobs j JOIN'))return {rowCount:1,rows:[]};
  if(sql.includes('WITH candidates AS MATERIALIZED'))return {rowCount:1,rows:[{tenantId:lease.tenantId,documentId:'dddddddd-1111-4111-8111-dddddddddddd',
   version:1,content:`问：${question}\n答：${reply}`,validFrom:'2020-01-01T00:00:00.000Z',validUntil:'2099-01-01T00:00:00.000Z'}]};
  if(sql.includes('SELECT reason FROM automatic_reception_generations'))return {rowCount:1,rows:[{reason}]};
  return {rowCount:0,rows:[]};
 }} as unknown as Pick<PoolClient,'query'>;
 return {db,queries};
}
test('published FAQ is knowledge, not an exact-answer shortcut; missing verification blocks it',async()=>isolatedFlags(async()=>{
 const {db,queries}=evidenceDb();
 const input=await loadAutomaticEvidence(db,lease,question,{lock:true});
 assert.equal(input.sources.length,1);
 assert.equal(assessAutomaticEvidence({...input,reply}).reason,'knowledge_grounded_faq');
 assert.equal(automaticSemanticPolicyAllowed(input),true);
 const result=await assessStoredAutomaticEvidence(db,lease,{text:reply} as never,question,{lock:true});
 assert.equal(result.evidenceCandidate,false);assert.equal(result.requiresHumanApproval,true);
 assert.equal(result.reason,'knowledge_verification_required');
 // Regression: even a verbatim FAQ must reach the independent verification journal.
 assert.ok(queries.some(sql=>sql.includes('FROM automatic_reception_verifications v')));
}));
test('queued legacy generation cannot qualify for knowledge-only delivery',async()=>isolatedFlags(async()=>{
 for(const reason of ['generated','approved_exact_answer','exact_styled_generated']){
  const {db}=evidenceDb(reason);
  const result=await assessStoredAutomaticEvidence(db,lease,{text:reply} as never,question,{lock:true});
  assert.equal(result.evidenceCandidate,false);assert.equal(result.requiresHumanApproval,true);
 }
}));
function administratorDb(){
 const queries:string[]=[];
 const client={release(){},query:async(sql:string)=>{
  queries.push(sql);
  if(sql.includes('FROM console_sessions s JOIN'))return {rowCount:1,rows:[{tenant_id:lease.tenantId,account_id:'1',platform_user_id:lease.jobId,session_id:lease.workerToken}]};
  if(sql.includes('RETURNING reads,writes'))return {rowCount:1,rows:[{reads:1,writes:1}]};
  return {rowCount:0,rows:[]};
 }} as unknown as PoolClient;
 return {queries,db:{connect:async()=>client} as Pick<Pool,'connect'>};
}
test('retired management actions return 410 after real administrator/workspace checks, without answer mutations',async()=>{
 for(const action of [{kind:'create',answer:{}},{kind:'replace',id:lease.jobId,expected:'1',answer:{}},
  {kind:'approve',id:lease.jobId,expected:'1'},{kind:'disable',id:lease.jobId,expected:'1'}]){
  const {db,queries}=administratorDb();
  await assert.rejects(()=>manageAutomaticReception(db,'a'.repeat(64),action as never,lease.tenantId),{code:'exact_answers_retired',status:410});
  assert.ok(queries.some(sql=>sql.includes('FROM console_sessions s JOIN')));
  assert.ok(queries.includes('ROLLBACK'));
  assert.ok(!queries.some(sql=>/INSERT INTO automatic_reception_answers|UPDATE automatic_reception_answers/.test(sql)));
 }
});
test('legacy HTTP endpoints are gone, including approval, but auth and workspace checks remain',async()=>{
 const base='https://synthetic.invalid/api/v1/automatic-reception/management';
 for(const path of ['/answers',`/answers/${lease.jobId}/approve`,`/answers/${lease.jobId}/replace`,`/answers/${lease.jobId}/disable`]){
  for(const workspace of [lease.tenantId,'another-tenant']){
   const {db}=administratorDb();let status=0,body='';
   const response={writeHead(n:number){status=n;},end(s:string){body=s;},setHeader(){}} as unknown as ServerResponse;
   const request={method:'POST',headers:{authorization:'Bearer '+'a'.repeat(64),'x-replynest-workspace':workspace}} as unknown as IncomingMessage;
   await createAutomaticManagementApi(db,{enabled:()=>true,requireWorkspaceHeader:true})(request,response,new URL(base+path));
   assert.equal(status,workspace===lease.tenantId?410:409);
   assert.equal(JSON.parse(body).error.code,workspace===lease.tenantId?'exact_answers_retired':'workspace_changed');
  }
 }
});
