import test from 'node:test';
import assert from 'node:assert/strict';
import {webhookFailure,webhookRetrySeconds,WEBHOOK_MAX_ATTEMPTS,claimNotificationWebhook,finishNotificationWebhook,queueNotificationWebhookTest} from './notification-webhook-retry.js';
test('transient transport, DNS and capacity errors are eligible for bounded retry',()=>{
 for(const code of ['webhook_timeout','webhook_transport_failed','webhook_dns_timeout','webhook_response_aborted','webhook_capacity_exceeded'])assert.equal(webhookFailure(Error(code)).retryable,true);
 assert.equal(webhookFailure(Object.assign(Error('hostname not logged'),{code:'EAI_AGAIN'})).code,'webhook_network_unavailable');
});
test('only temporary HTTP rejections retry, not authentication or redirect errors',()=>{
 for(const code of [408,425,429,500,502,503,504])assert.equal(webhookFailure(Error(`webhook_http_${code}`)).retryable,true);
 for(const code of [301,400,401,403,404,410,413])assert.equal(webhookFailure(Error(`webhook_http_${code}`)).retryable,false);
});
test('invalid endpoints, unsafe hosts and provider rejections stop safely',()=>{
 for(const text of ['Webhook URL must target public IPv4','webhook_non_public_host','webhook_invalid_response','webhook_provider_999','invalid secret password=DO_NOT_LOG'])assert.equal(webhookFailure(Error(text)).retryable,false);
 assert.doesNotMatch(JSON.stringify(webhookFailure(Error('password=DO_NOT_LOG'))),/DO_NOT_LOG/);
});
test('retry is five total claims with bounded exponential delay',()=>{
 assert.equal(WEBHOOK_MAX_ATTEMPTS,5);assert.deepEqual([1,2,3,4].map(webhookRetrySeconds),[30,60,120,240]);assert.equal(webhookRetrySeconds(99),900);
});
test('Feishu bot flow control retries but signature, IP and keyword errors stop',()=>{
 assert.equal(webhookFailure(Error('webhook_provider_11232'),'feishu').retryable,true);
 assert.equal(webhookFailure(Error('webhook_provider_11232'),'wecom').retryable,false);
 for(const code of [19021,19022,19024,9499])assert.deepEqual(webhookFailure(Error(`webhook_provider_${code}`),'feishu'),{code:`webhook_provider_${code}`,retryable:false});
});
test('claim uses due, attempt cap and tenant/event scope without holding network locks',async()=>{
 const calls:any[]=[];const db={query:async(sql:string,values:unknown[])=>{calls.push({sql,values});return {rowCount:1,rows:calls.length===2?[{attempt_count:2}]:[]};}};
 assert.equal(await claimNotificationWebhook(db as any,'synthetic-delivery','synthetic-tenant'),2);
 assert.match(calls[1].sql,/d\.attempt_count<5/);assert.match(calls[1].sql,/e\.tenant_id=d\.tenant_id/);assert.match(calls[1].sql,/t\.status IN \('active','test'\)/);assert.match(calls[1].sql,/60 seconds/);
});
test('stale completion cannot update a destination or revive a job',async()=>{
 const calls:any[]=[];const db={query:async(sql:string)=>{calls.push(sql);return {rowCount:0,rows:[]};}};
 assert.equal(await finishNotificationWebhook(db as any,'synthetic','tenant',1,'delivered',null),false);assert.equal(calls.length,1);assert.match(calls[0],/attempt_count=\$3 AND next_attempt_at>NOW\(\)/);
});
test('an already pending test is returned instead of inserting another',async()=>{
 const calls:string[]=[];let released=false;const existing={delivery_id:'same-job',status:'pending',attempt_count:2};
 const client={query:async(sql:string)=>{calls.push(sql);return {rowCount:1,rows:sql.startsWith('SELECT d.delivery_id')?[existing]:[]};},release:()=>{released=true;}};
 const result=await queueNotificationWebhookTest({connect:async()=>client} as any,'tenant','target');
 assert.equal(result.delivery_id,'same-job');assert.equal(calls.some(x=>x.startsWith('INSERT')),false);assert.equal(calls.at(-1),'COMMIT');assert.equal(released,true);
});
test('invalid tenant/target rolls back before inserting or sending',async()=>{
 const calls:string[]=[];let released=false;const client={query:async(sql:string)=>{calls.push(sql);return {rowCount:0,rows:[]};},release:()=>{released=true;}};
 await assert.rejects(queueNotificationWebhookTest({connect:async()=>client} as any,'tenant-B','target-A'),/notification_destination_not_found/);
 assert.equal(calls.at(-1),'ROLLBACK');assert.equal(calls.some(x=>x.startsWith('INSERT')),false);assert.equal(released,true);
});
