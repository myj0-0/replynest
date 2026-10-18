import test from 'node:test';
import assert from 'node:assert/strict';
import {createAutomaticPresentationPreparation,currentStoredAutomaticPresentation,automaticPresentationRuntimeAcl,automaticPresentationSchema} from './reception-automatic-presentation.js';
import {automaticPresentationDatabaseComponent} from './reception-automatic-presentation-component.js';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
const fail=async():Promise<never>=>{throw Error('must_not_reach_database_history_or_model');};
const db={connect:fail} as any,reader={read:fail};
const lease:AutomaticReceptionLease={tenantId:'a',jobId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',workerToken:'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
 customerId:'cccccccc-1111-4111-8111-cccccccccccc',authorizationId:'dddddddd-1111-4111-8111-dddddddddddd',accountId:'1',conversationId:'2',messageId:'3',
 channel:'shared_wechat',connectionId:null,consentVersion:'automatic-send-v1'};
test('default-off presentation never accesses DB/history; invented preparations cannot be revalidated',async()=>{
 const off=createAutomaticPresentationPreparation(db,reader),invented={data:{tone:'neutral' as const,context:[]},timing:{enabled:true,minimumSeconds:1,maximumSeconds:30}};
 await assert.rejects(()=>off.prepare(lease,'一般多久发货？'),/^Error: automatic_presentation_unavailable$/);
 assert.equal(await off.current(invented,true),false);assert.equal(await off.currentInTransaction({query:fail} as any,invented),false);
 assert.equal(await off.currentStored(lease,'一般多久发货？'),false);
 assert.equal(await currentStoredAutomaticPresentation({query:fail} as any,lease,'一般多久发货？'),false);
 const on=createAutomaticPresentationPreparation(db,reader,{enabled:()=>true});
 assert.equal(await on.current(invented),false);assert.equal(await on.currentInTransaction({query:fail} as any,invented),false);
});
test('invalid scope/question and legacy consent stop before history; errors are finite, not raw DB data',async()=>{
 let connects=0;const seen={connect:async()=>{connects++;throw Error('private raw database value');}} as any;
 const on=createAutomaticPresentationPreparation(seen,reader,{enabled:()=>true});
 for(const changed of [{tenantId:'../a'},{customerId:'x'},{accountId:'9223372036854775808'},{messageId:'0'},
  {consentVersion:'legacy'},{channel:'shared_wechat',connectionId:'eeeeeeee-1111-4111-8111-eeeeeeeeeeee'},
  {channel:'web_chat',connectionId:null}])
  await assert.rejects(()=>on.prepare({...lease,...changed} as AutomaticReceptionLease,'一般多久发货？'),/^Error: automatic_presentation_unavailable$/);
 for(const question of ['',null,'字'.repeat(4001)])await assert.rejects(()=>on.prepare(lease,question as string),/^Error: automatic_presentation_unavailable$/);
 assert.equal(connects,0);
 await assert.rejects(()=>on.prepare(lease,'一般多久发货？'),/^Error: automatic_presentation_unavailable$/);assert.equal(connects,1);
});
test('journal is typed/immutable with tenant, worker, question, sources and independent history-purpose bindings',()=>{
 for(const field of ['tenant_id','worker_token','customer_id','question_hash','source_revision','settings_revision','presentation_hash','context_grant_id','style_grant_id'])
  assert.ok(automaticPresentationSchema.includes(field));
 assert.match(automaticPresentationSchema,/IF TG_OP<>'INSERT'/);assert.match(automaticPresentationSchema,/BEFORE TRUNCATE/);
 assert.match(automaticPresentationSchema,/j\.state='processing'/);assert.match(automaticPresentationSchema,/locked_at>clock_timestamp/);
 assert.match(automaticPresentationSchema,/reception-history-context-v1/);assert.match(automaticPresentationSchema,/reception-history-style-v1/);
 assert.doesNotMatch(automaticPresentationSchema,/SECURITY DEFINER|raw_history|history_text|question_text|answer_text/);
 const acl=automaticPresentationRuntimeAcl('unit_runtime');assert.match(acl,/GRANT SELECT,INSERT ON TABLE/);
 assert.doesNotMatch(acl,/GRANT .*UPDATE|GRANT .*DELETE|GRANT .*TRUNCATE|CREATE ON/);
 for(const role of ['','Owner','bad";DROP TABLE x;--'])assert.throws(()=>automaticPresentationRuntimeAcl(role),/invalid/);
});
test('automatic presentation component never permits a runtime DDL install',async()=>{
 const component=automaticPresentationDatabaseComponent();assert.equal(component.name,'automatic_reception_presentation');
 assert.equal(component.sql,automaticPresentationSchema);await assert.rejects(()=>component.migrate(),/owner_migration_required/);
});
