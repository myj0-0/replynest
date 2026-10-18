import test from 'node:test';
import assert from 'node:assert/strict';
import {publicAiLabelDefault,parsePublicAiLabel,readPublicAiLabel,publicAiLabelRuntimeAcl,publicAiLabelDatabaseComponent} from './ai-public-label.js';
import {validateReceptionPersonalizationAction} from './reception-personalization.js';
test('global label defaults off; explicit tenant choice overrides the platform, null follows it',()=>{
 assert.equal(publicAiLabelDefault({}),false);assert.equal(publicAiLabelDefault({AI_PUBLIC_LABEL_DEFAULT:'false'}),false);
 assert.equal(publicAiLabelDefault({AI_PUBLIC_LABEL_DEFAULT:'true'}),true);
 for(const value of ['0','1','False','yes'])assert.throws(()=>publicAiLabelDefault({AI_PUBLIC_LABEL_DEFAULT:value}));
 for(const global of [false,true])for(const enabled of [null,false,true])
  assert.deepEqual(parsePublicAiLabel({revision:'1',enabled},global),{revision:'1',override:enabled,platformDefault:global,effective:enabled??global});
 for(const row of [{revision:'1',enabled:'false'},{revision:1,enabled:false},{revision:'01',enabled:true},{revision:'1'},{revision:'9223372036854775807',enabled:false}])
  assert.throws(()=>parsePublicAiLabel(row,false));
});
test('policy reads exactly one tenant and never silently falls back on database failure',async()=>{
 const env={AI_PUBLIC_LABEL_SETTINGS_ENABLED:'true',AI_PUBLIC_LABEL_DEFAULT:'false'};
 const calls:any[]=[];const db={query:async(sql:string,args:any[])=>{calls.push([sql,args]);return {rows:[{revision:'2',enabled:true}]};}} as any;
 assert.equal((await readPublicAiLabel(db,'tenant-a',env)).effective,true);assert.deepEqual(calls[0][1],['tenant-a']);
 assert.match(calls[0][0],/WHERE tenant_id=\$1/);
 assert.equal((await readPublicAiLabel(db,'tenant-a',{})).effective,false);assert.equal(calls.length,1);
 await assert.rejects(()=>readPublicAiLabel({query:async()=>{throw Error('private_db_error');}} as any,'tenant-a',env));
});
test('label input is strict presentation-only; schema is owner-installed with nondestructive runtime ACL',async()=>{
 for(const override of [true,false,null])assert.deepEqual(validateReceptionPersonalizationAction('public-label',{expectedRevision:'0',override}),{kind:'public-label',expectedRevision:'0',override});
 for(const extra of [{override:'false'},{override:0},{tenantId:'b'},{sendEnabled:true},{confirmed:true},{expectedRevision:0}])
  assert.throws(()=>validateReceptionPersonalizationAction('public-label',{expectedRevision:'0',override:null,...extra}));
 const component=publicAiLabelDatabaseComponent();await assert.rejects(component.migrate,/owner_migration_required/);
 assert.match(component.sql,/tenant_id TEXT PRIMARY KEY/);const acl=publicAiLabelRuntimeAcl('fixture_runtime');
 assert.ok(!/GRANT.*DELETE|GRANT.*TRUNCATE|SECURITY DEFINER/.test(acl));assert.throws(()=>publicAiLabelRuntimeAcl('x;DROP TABLE users'));
});
