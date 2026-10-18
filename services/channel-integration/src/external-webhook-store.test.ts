import test from 'node:test';
import assert from 'node:assert/strict';
import {claimExternalWebhook,externalWebhookClaimActive,finishExternalWebhook,externalWebhookLeaseComponent} from './external-webhook-store.js';
import type {ExternalWebhookClaim} from './external-webhook-store.js';
import {bootstrapDatabaseRuntime} from './database-runtime.js';

const app={tenant_id:'synthetic-tenant',app_id:'synthetic-app',webhook_url_cipher:'url-cipher',webhook_secret_cipher:'secret-cipher'};
const event={event_id:'synthetic-event',attempts:0,payload:{type:'synthetic'}};
function scripted(rows:unknown[][]){
 const sql:string[]=[],parameters:unknown[][]=[];let held=0,read=0;
 const db={connect:async()=>{held++;return{release:()=>{held--;},query:async(text:string,args:unknown[]=[])=>{
  sql.push(text);parameters.push(args);
  return {rows:/^SELECT/.test(text)?rows[read++]??[]:[],rowCount:1};
 }};},query:async(text:string,args:unknown[]=[])=>{sql.push(text);parameters.push(args);return{rows:[],rowCount:1};}};
 return {db:db as any,sql,parameters,held:()=>held};
}
test('claim commits and releases before returning transport credentials; attempts count at claim',async()=>{
 const s=scripted([[app],[event]]);const claim=await claimExternalWebhook(s.db);
 assert.ok(claim&&claim!=='terminal');assert.equal(claim.attempts,1);assert.equal(s.held(),0);
 assert.equal(s.sql.at(-1),'COMMIT');assert.match(s.sql[2],/FOR UPDATE OF a SKIP LOCKED/);
 assert.match(s.sql[3],/FOR UPDATE SKIP LOCKED/);assert.match(s.sql[4],/attempts=attempts\+1/);
 assert.match(s.sql[4],/next_attempt_at=NOW\(\)\+INTERVAL '60 seconds'/);
 assert.match(claim.lease,/^[0-9a-f-]{36}$/);
});
test('no work and exhausted crash attempts release without transport',async()=>{
 for(const [rows,result] of [[[[]],null],[[[app],[{...event,attempts:8}]],'terminal']] as const){
  const s=scripted(rows as unknown as unknown[][]);assert.equal(await claimExternalWebhook(s.db),result);
  assert.equal(s.held(),0);assert.equal(s.sql.at(-1),'COMMIT');
  if(result)assert.match(s.sql[4],/status='failed',lease_token=NULL,lease_until=NULL/);
 }
});
test('transaction error rolls back and returns connection',async()=>{
 let released=false;const db={connect:async()=>({query:async(sql:string)=>{if(sql==='COMMIT'||sql==='ROLLBACK')return{};throw Error('synthetic-db-error');},release:()=>{released=true;}})};
 await assert.rejects(()=>claimExternalWebhook(db as any),/synthetic-db-error/);assert.equal(released,true);
});
test('preflight and completion fence exact tenant/app/event/lease; revoked app cannot revive result',async()=>{
 const claim:ExternalWebhookClaim={tenant:'t',app:'a',event:'e',lease:'lease',attempts:2,payload:{},urlCipher:'u',secretCipher:'s'};
 const s=scripted([[{active:false}]]);assert.equal(await externalWebhookClaimActive(s.db,claim),true);
 assert.deepEqual(s.parameters[0],['t','a','e','lease']);assert.match(s.sql[0],/e.lease_until>NOW\(\)/);
 assert.equal(await finishExternalWebhook(s.db,claim,true),true);assert.equal(s.held(),0);
 const update=s.sql.findIndex(sql=>sql.startsWith('UPDATE'));assert.equal(s.parameters[update][4],'cancelled');
 assert.match(s.sql[update],/status='pending' AND lease_token=\$4 AND lease_until>NOW\(\)/);
});
test('independent component requires owner migration and is not shared business schema',async()=>{
 const component=externalWebhookLeaseComponent();assert.equal(component.name,'external_webhook_leases');
 await assert.rejects(()=>component.migrate(),/owner_migration_required/);
 assert.doesNotMatch(component.sql,/SECURITY DEFINER|GRANT .*CREATE/);
 let migrated=false;
 await assert.rejects(()=>bootstrapDatabaseRuntime({} as any,[{name:'business',sql:'',migrate:async()=>{migrated=true;}},component],{}),/owner_migration_required/);
 assert.equal(migrated,false);
});
test('processor performs slow network outside transaction, coalesces ticks and finishes afterward',async()=>{
 const keys=['POSTGRES_HOST','POSTGRES_DATABASE','POSTGRES_USERNAME','POSTGRES_PASSWORD','NOTIFICATION_WEBHOOK_MASTER_KEY'] as const;
 const old=keys.map(k=>process.env[k]);for(const k of keys)process.env[k]=k==='NOTIFICATION_WEBHOOK_MASTER_KEY'?'11'.repeat(32):'synthetic-unit-only';
 const {createExternalWebhookProcessor}=await import('./open-platform-webhooks.js');
 const {encryptWebhookSecret}=await import('./notification-webhook-crypto.js');const {pool}=await import('./database.js');
 try{
  const s=scripted([[{...app,webhook_url_cipher:encryptWebhookSecret('https://example.com/'),webhook_secret_cipher:encryptWebhookSecret('synthetic-only')}],[event],[{active:true}],[]]);
  let unblock!:()=>void,entered!:()=>void,calls=0;
  const gate=new Promise<void>(r=>{unblock=r;});const started=new Promise<void>(r=>{entered=r;});
  const process=createExternalWebhookProcessor(s.db,async()=>{calls++;assert.equal(s.held(),0);assert.equal(s.sql.at(-2),'COMMIT');entered();await gate;assert.equal(s.held(),0);});
  const running=process();await started;assert.equal(s.held(),0);await process();assert.equal(calls,1);
  unblock();await running;assert.equal(s.held(),0);assert.equal(calls,1);
  assert.ok(s.sql.some(sql=>sql.startsWith('UPDATE external_app_events SET status=$5')));
 }finally{await pool.end();for(let i=0;i<keys.length;i++){if(old[i]===undefined)delete process.env[keys[i]];else process.env[keys[i]]=old[i];}}
});
