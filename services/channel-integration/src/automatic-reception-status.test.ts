import test from 'node:test';
import assert from 'node:assert/strict';
import {automaticStatusQuery,readAutomaticReceptionStatus,readAutomaticReceptionSources} from './automatic-reception-status.js';
import type {Pool} from 'pg';
const id='aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url');
test('task keyset preserves six-digit database microseconds',()=>{
 const c={at:'2026-10-01T00:00:00.123456Z',id};
 assert.deepEqual(automaticStatusQuery(10,encode(c)),{limit:10,cursor:c});
 assert.deepEqual(automaticStatusQuery(1,null),{limit:1,cursor:null});
});
test('task lists reject unbounded limits and malformed or noncanonical cursors',()=>{
 for(const limit of [0,26,1.5,NaN,Infinity])assert.throws(()=>automaticStatusQuery(limit,null));
 for(const after of ['?', 'x'.repeat(201),encode({at:'2026-02-31T00:00:00.000000Z',id}),
  encode({at:'2026-10-01T00:00:00.123Z',id}),encode({at:'2026-10-01T00:00:00.123456Z',id,tenant:'other'}),
  encode({at:'2026-10-01T00:00:00.123456Z',id:'guess'})])assert.throws(()=>automaticStatusQuery(10,after));
});
test('invalid task/source queries do not acquire database connections',async()=>{
 const db={connect:async()=>{throw Error('must not connect');}} as unknown as Pick<Pool,'connect'>;
 await assert.rejects(readAutomaticReceptionStatus(db,'',100,null),/invalid_payload/);
 await assert.rejects(readAutomaticReceptionSources(db,'',1,'guess'),/invalid_payload/);
});
