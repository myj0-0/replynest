import test from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {schemaFingerprint,bootstrapDatabaseRuntime} from './database-runtime.js';
import {automaticSemanticDatabaseComponent,automaticSemanticRuntimeAcl,automaticSemanticSchemaSql,migrateAutomaticSemanticComponent,type SemanticMigrationPlan} from './automatic-knowledge-migrate.js';
const fail=async():Promise<never>=>{throw Error('unexpected_connection');};
const db={connect:fail} as unknown as Pick<Pool,'connect'>;
const plan:SemanticMigrationPlan={ownerRole:'test_owner',migratorRole:'test_migrator',runtimeRole:'test_runtime',database:'test_database',
 before:[{component:'automatic_reception',sql_sha256:'a'.repeat(64)}],sqlSha256:schemaFingerprint(automaticSemanticSchemaSql()),
 aclSha256:schemaFingerprint(automaticSemanticRuntimeAcl('test_runtime')),executionClosed:true};
test('semantic component legacy startup rejects before any migration or seed',async()=>{
 let writes=0;
 await assert.rejects(()=>bootstrapDatabaseRuntime(db,[{name:'business',sql:'',migrate:async()=>{writes++;}},automaticSemanticDatabaseComponent()],{},async()=>{writes++;}),/semantic_owner_migration_required/);
 assert.equal(writes,0);await assert.rejects(()=>automaticSemanticDatabaseComponent().migrate(),/semantic_owner_migration_required/);
});
test('unfrozen, open or non-exact plans stop before DB access',async()=>{
 for(const bad of [{sqlSha256:'b'.repeat(64)},{aclSha256:'b'.repeat(64)},{executionClosed:false},{runtimeRole:'test_owner'},{runtimeRole:'x";DROP SCHEMA public;--'},
  {before:[]},{before:[...plan.before,...plan.before]},{before:[{component:'automatic_knowledge_semantic',sql_sha256:'a'.repeat(64)}]}])
  await assert.rejects(()=>migrateAutomaticSemanticComponent(db,{...plan,...bad}),/frozen_semantic|exact_semantic/);
});
test('semantic schema binds both journals and minimal nondefiner guard ACL',()=>{
 const sql=automaticSemanticSchemaSql(),acl=automaticSemanticRuntimeAcl('test_runtime');
 for(const table of ['retrievals','verifications'])assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS automatic_reception_'+table));
 assert.equal((acl.match(/GRANT SELECT,INSERT,UPDATE/g)??[]).length,2);
 assert.equal((acl.match(/REVOKE ALL ON FUNCTION/g)??[]).length,2);
 assert.ok(!/GRANT .*DELETE|GRANT .*TRUNCATE|SECURITY DEFINER/.test(acl));
});
test('only gateway semantic enablement requires the separate owner component and primary management schema',async()=>{
 const keys=['POSTGRES_HOST','POSTGRES_DATABASE','POSTGRES_USERNAME','POSTGRES_PASSWORD'] as const;
 const previous=keys.map(k=>process.env[k]);
 for(const key of keys)process.env[key]='isolated-component-unit-only';
 const {databaseComponents}=await import('./database-components.js');
 const {pool}=await import('./database.js');
 try{
  assert.ok(!databaseComponents({}).some(c=>c.name==='automatic_knowledge_semantic'));
  assert.throws(()=>databaseComponents({AI_RECEPTION_SEMANTIC_ANSWERS_ENABLED:'true'}),/semantic_management_component_required/);
  const env={AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED:'true',AI_RECEPTION_SEMANTIC_ANSWERS_ENABLED:'true'};
  const selected=databaseComponents(env);
  assert.deepEqual(selected.map(c=>c.name),['business','automatic_reception','automatic_knowledge_semantic']);
  assert.equal(selected.at(-1)?.sql,automaticSemanticSchemaSql());
  assert.deepEqual(databaseComponents(env,'knowledge').map(c=>c.name),['business']);
 }finally{await pool.end();for(let i=0;i<keys.length;i++){if(previous[i]===undefined)delete process.env[keys[i]];else process.env[keys[i]]=previous[i];}}
});
