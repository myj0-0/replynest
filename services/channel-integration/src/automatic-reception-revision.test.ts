import test from 'node:test';
import assert from 'node:assert/strict';
import type {PoolClient} from 'pg';
import {automaticEvidenceRevision} from './automatic-reception-revision.js';
function fixture(revision:unknown='9007199254740993',isolation='read committed'){
 const calls:Array<{sql:string;args:unknown}>=[];
 const db={query:async(sql:string,args:unknown)=>{calls.push({sql,args});return {
  rows:sql.includes('current_setting')?[{isolation}]:sql.includes('SELECT revision')?[{revision}]:[],rowCount:1
 };}} as unknown as Pick<PoolClient,'query'>;
 return {db,calls};
}
test('guard keeps bigint revision as text and uses tenant-scoped shared lock',async()=>{
 const {db,calls}=fixture();assert.equal(await automaticEvidenceRevision(db,'a',true),'9007199254740993');
 assert.ok(calls[0].sql.startsWith('SAVEPOINT'));
 assert.ok(calls.at(-1)!.sql.includes('WHERE tenant_id=$1 FOR SHARE'));assert.deepEqual(calls.at(-1)!.args,['a']);
});
test('unlocked diagnostic never claims a transaction/shared lock',async()=>{
 const {db,calls}=fixture('3');assert.equal(await automaticEvidenceRevision(db,'a',false),'3');
 assert.equal(calls.length,2);assert.ok(calls.every(c=>!c.sql.includes('FOR SHARE')&&!c.sql.includes('SAVEPOINT')));
});
test('invalid tenant is rejected before querying',async()=>{
 const {db,calls}=fixture();for(const tenant of ['', ' ', 'a'.repeat(201)])await assert.rejects(()=>automaticEvidenceRevision(db,tenant,true),/invalid_automatic_evidence_tenant/);
 assert.equal(calls.length,0);
});
test('frozen snapshot isolation is rejected before reading sources',async()=>{
 const {db,calls}=fixture('3','repeatable read');await assert.rejects(()=>automaticEvidenceRevision(db,'a',true),/requires_read_committed/);
 assert.equal(calls.length,2);
});
test('missing, numeric, negative or malformed revision fails closed',async()=>{
 for(const revision of [null,1,'-1','invalid','1'.repeat(20)]){
  const {db}=fixture(revision);
  await assert.rejects(()=>automaticEvidenceRevision(db,'a',true),/revision_unavailable/);
 }
 const db={query:async()=>({rows:[]})} as unknown as Pick<PoolClient,'query'>;
 await assert.rejects(()=>automaticEvidenceRevision(db,'a',false),/revision_unavailable/);
});
