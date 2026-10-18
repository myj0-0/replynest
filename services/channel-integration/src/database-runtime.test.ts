import test from 'node:test';
import assert from 'node:assert/strict';
import {bootstrapDatabaseRuntime,databaseStartupMode,schemaFingerprint,verifyDatabaseRuntime} from './database-runtime.js';
import type {Pool} from 'pg';
const component={name:'business',sql:'CREATE TABLE example(id int);',migrate:async()=>{}};
function fake(options:{privileged?:boolean;missing?:boolean;writable?:boolean;drift?:boolean}={}){
 const queries:string[]=[];let released=false;
 const db={connect:async()=>({query:async(sql:string)=>{
  queries.push(sql);
  if(sql.includes('FROM pg_roles'))return{rows:[{rolsuper:options.privileged??false,rolcreatedb:false,rolcreaterole:false,schema_create:false,database_create:false,memberships:false,owns_objects:false}]};
  if(sql.includes('FROM pg_class'))return{rows:options.missing?[]:[{relkind:'r',can_read:true,can_write:options.writable??false}]};
  if(sql.startsWith('SELECT component'))return{rows:[{component:'business',sql_sha256:schemaFingerprint(options.drift?'different':component.sql)}]};
  return{rows:[]};
 },release:()=>{released=true;}})} as unknown as Pick<Pool,'connect'>;
 return{db,queries,released:()=>released};
}
test('verify is read-only and never calls migrations or seed',async()=>{
 const f=fake();let writes=0;
 await bootstrapDatabaseRuntime(f.db,[{...component,migrate:async()=>{writes++;}}],{DATABASE_STARTUP_MODE:'verify'},async()=>{writes++;});
 assert.equal(writes,0);assert.equal(f.queries[0],'BEGIN READ ONLY');assert.equal(f.queries.at(-1),'COMMIT');assert.ok(f.released());
 assert.ok(!f.queries.some(q=>/^(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP)/.test(q)));
});
for(const [name,options,error] of [
 ['privileged',{privileged:true},'database_runtime_role_not_restricted'],
 ['missing receipt',{missing:true},'database_schema_receipt_not_protected'],
 ['writable receipt',{writable:true},'database_schema_receipt_not_protected'],
 ['drift',{drift:true},'database_schema_receipt_mismatch']
] as const)test(name+' fails closed',async()=>{const f=fake(options);await assert.rejects(verifyDatabaseRuntime(f.db,[component]),new RegExp(error));assert.equal(f.queries.at(-1),'ROLLBACK');assert.ok(f.released());});
test('legacy remains explicit compatibility path',async()=>{const f=fake();let sequence='';await bootstrapDatabaseRuntime(f.db,[{...component,migrate:async()=>{sequence+='m';}}],{},async()=>{sequence+='s';});assert.equal(sequence,'ms');assert.equal(f.queries.length,0);});
test('invalid mode never falls back',()=>{assert.throws(()=>databaseStartupMode({DATABASE_STARTUP_MODE:'verfy'}));});
test('expanded SQL fingerprints are content-sensitive',()=>{assert.notEqual(schemaFingerprint('a'),schemaFingerprint('b'));assert.match(schemaFingerprint('a'),/^[0-9a-f]{64}$/);});
