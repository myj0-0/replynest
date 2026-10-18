import test from 'node:test';
import assert from 'node:assert/strict';
import {createMassPollers} from './mass-campaign-worker.js';
test('defaults do nothing; receipt querying is independent of send authorization',async()=>{
 let sends=0,queries=0;
 const env:NodeJS.ProcessEnv={};
 const worker=createMassPollers({send:async()=>{sends++;},receipt:async()=>{queries++;}},env);
 await worker.send();await worker.receipt();assert.equal(sends+queries,0);
 env.MASS_CAMPAIGN_RECEIPT_WORKER_ENABLED='true';await worker.receipt();assert.equal(queries,1);assert.equal(sends,0);
 env.MASS_CAMPAIGN_WORKER_ENABLED='true';await worker.send();assert.equal(sends,0);
 env.MESSAGE_CAMPAIGN_EXECUTION_ENABLED='true';env.MESSAGE_CAMPAIGN_PROVIDER='synthetic';await worker.send();assert.equal(sends,0);
 env.MESSAGE_CAMPAIGN_PROVIDER='wechat_mass';await worker.send();assert.equal(sends,1);
});
test('overlapping ticks are single flight; error releases the guard',async()=>{
 let release!:()=>void,sends=0;
 const waiting=new Promise<void>(resolve=>{release=resolve;});
 const worker=createMassPollers({send:async()=>{sends++;await waiting;throw Error('synthetic');},receipt:async()=>{}},
 {MASS_CAMPAIGN_WORKER_ENABLED:'true',MESSAGE_CAMPAIGN_EXECUTION_ENABLED:'true',MESSAGE_CAMPAIGN_PROVIDER:'wechat_mass'});
 const first=worker.send();await worker.send();assert.equal(sends,1);release();await assert.rejects(first);
 await assert.rejects(worker.send());assert.equal(sends,2);
});
