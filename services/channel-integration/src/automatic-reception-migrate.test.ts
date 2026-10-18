import test from 'node:test';
import assert from 'node:assert/strict';
import {migrateAutomaticReception} from './automatic-reception-migrate.js';
function fixture(failAt=0){const queries:string[]=[];let released=0;return {queries,get released(){return released;},db:{connect:async()=>({query:async(sql:string)=>{queries.push(sql);if(queries.length===failAt)throw Error('private database detail');return {};},release:()=>{released++;}})} as any};}
test('default-off migration does not acquire a database connection',async()=>{
 await migrateAutomaticReception({connect:()=>{throw Error('unexpected connection');}} as any);
});
test('enabled migration owns one bounded serialized transaction and releases once',async()=>{
 const f=fixture();await migrateAutomaticReception(f.db,true);
 assert.equal(f.queries[0],'BEGIN');assert.match(f.queries[1],/statement_timeout='30s'.*lock_timeout='3s'/);
 assert.match(f.queries[2],/pg_advisory_xact_lock/);assert.equal(f.queries.length,9);assert.equal(f.queries.at(-1),'COMMIT');assert.equal(f.released,1);
});
test('DDL and commit failures roll back all experimental schemas with a fixed error',async()=>{
 for(const index of [4,6,9]){const f=fixture(index);await assert.rejects(migrateAutomaticReception(f.db,true),/^Error: automatic_reception_migration_failed$/);
  assert.equal(f.queries.at(-1),'ROLLBACK');assert.equal(f.released,1);}
});
test('connection failure does not expose database credentials or paths',async()=>{
 await assert.rejects(migrateAutomaticReception({connect:async()=>{throw Error('private database credential');}} as any,true),/^Error: automatic_reception_migration_failed$/);
});
