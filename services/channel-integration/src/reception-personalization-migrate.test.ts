import test from 'node:test';
import assert from 'node:assert/strict';
import {schemaFingerprint} from './database-runtime.js';
import {migrateReceptionPersonalizationRelease,receptionPersonalizationReleaseComponents,receptionPersonalizationReleaseAcl,type ReceptionPersonalizationMigrationPlan} from './reception-personalization-migrate.js';
const db={connect:async()=>{throw Error('unexpected_connection');}} as any;
const plan:ReceptionPersonalizationMigrationPlan={ownerRole:'fixture_owner',migratorRole:'fixture_migrator',runtimeRole:'fixture_runtime',database:'fixture_db',
 before:['business','automatic_reception','automatic_knowledge_semantic'].map(component=>({component,sql_sha256:'a'.repeat(64)})),
 target:receptionPersonalizationReleaseComponents().map(c=>({component:c.name,sql_sha256:schemaFingerprint(c.sql)})),
 aclSha256:schemaFingerprint(receptionPersonalizationReleaseAcl('fixture_runtime')),executionClosed:true};
test('release accepts only exact four source fingerprints, roles, closed state and previous receipt set before connecting',async()=>{
 for(const bad of [{executionClosed:false},{runtimeRole:'fixture_owner'},{database:'x;DROP DATABASE x'},
  {before:[]},{before:plan.before.slice(1)},{before:[...plan.before,plan.before[0]]},{before:[...plan.before,plan.target[0]]},
  {target:plan.target.slice(1)},{target:[...plan.target.slice(1),plan.target[1]]},
  {target:plan.target.map((r,n)=>n? r:{...r,sql_sha256:'b'.repeat(64)})},{aclSha256:'b'.repeat(64)},{unreviewedSql:'SELECT 1'}])
  await assert.rejects(()=>migrateReceptionPersonalizationRelease(db,{...plan,...bad}),/frozen_reception|exact_reception/);
});
test('individual components never permit implicit runtime DDL; ACL does not grant delete or receipt writes',async()=>{
 const c=receptionPersonalizationReleaseComponents();assert.equal(c.length,4);
 for(const component of c)await assert.rejects(()=>component.migrate(),/owner_migration_required/);
 const acl=receptionPersonalizationReleaseAcl('fixture_runtime');
 assert.match(acl,/UPDATE\(state,dispatch_token,claimed_at,finished_at,reason\)/);
 assert.doesNotMatch(acl,/GRANT[^;]*(DELETE|TRUNCATE|REFERENCES|TRIGGER)|SECURITY DEFINER|replynest_schema_receipts/);
 assert.throws(()=>receptionPersonalizationReleaseAcl('x";'),/invalid_reception/);
});
