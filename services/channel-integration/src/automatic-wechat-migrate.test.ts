import test from 'node:test';
import assert from 'node:assert/strict';
import {automaticWechatSchemaSql,migrateAutomaticWeChat} from './automatic-wechat-migrate.js';
import {automaticReceptionSchemaSql} from './automatic-reception-migrate.js';

test('WeChat component is separately versioned and default-off migration performs no I/O',async()=>{
 await migrateAutomaticWeChat({connect:async()=>{throw Error('must not connect');}} as any);
 assert.match(automaticWechatSchemaSql(),/automatic_reception_wechat_outcomes/);
 assert.ok(!automaticReceptionSchemaSql().includes('automatic_reception_wechat_outcomes'));
});
test('explicit owner migration uses one bounded transaction and rolls back with a fixed error',async()=>{
 for(const failAt of [0,1,4,10]){
  const queries:string[]=[];let release=0;
  const db={connect:async()=>({query:async(sql:string)=>{queries.push(sql);if(queries.length===failAt)throw Error('secret path');},release:()=>{release++;}})} as any;
  if(failAt){await assert.rejects(migrateAutomaticWeChat(db,true),/^Error: automatic_wechat_migration_failed$/);assert.equal(queries.at(-1),'ROLLBACK');}
  else{await migrateAutomaticWeChat(db,true);assert.equal(queries.length,10);assert.equal(queries.at(-1),'COMMIT');}
  assert.equal(queries[0],'BEGIN');
  if(failAt===1)assert.deepEqual(queries,['BEGIN','ROLLBACK']);
  else{assert.match(queries[1],/statement_timeout='30s'.*lock_timeout='3s'/);assert.match(queries[2],/pg_advisory_xact_lock\(714201,3\)/);}
  assert.equal(release,1);
 }
});
