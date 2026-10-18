import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoricalKnowledgeService,historyKnowledgeMessages,parseHistoryKnowledgeOutput,historyKnowledgeRuntimeAcl} from './reception-history-knowledge.js';
import {historyKnowledgeDatabaseComponent} from './reception-history-knowledge-component.js';
const scope={tenantId:'a',accountId:'2',grantId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',purpose:'knowledgeDraft' as const};
const row={tenantId:'a',accountId:'2',customerId:'41',conversationId:'1',private:false,deleted:false};
const sample={purpose:'knowledgeDraft' as const,privacyPolicy:'history-redaction-v1' as const,sampleDigest:'a'.repeat(64),asOf:'2026-10-06T00:00:00.000000Z',scanned:2,pages:1,
 messages:[{...row,messageId:'1',createdAtMs:Date.parse('2026-10-05T23:59:58Z'),direction:'incoming' as const,authorKind:'customer' as const,text:'一般多久发货？'},
 {...row,messageId:'2',createdAtMs:Date.parse('2026-10-05T23:59:59Z'),direction:'outgoing' as const,authorKind:'human' as const,text:'通常两个工作日内发货。'}]};
const proposal={question:'一般多久发货？',answer:'通常两个工作日内发货。',sourceMessageIds:['1','2']};
test('history prompt exports only finite masked message fields, never tenant/contact/grant identities or approval authority',()=>{
 const prompt=historyKnowledgeMessages(sample,scope);assert.match(prompt[0].content,/待核对资料/);assert.match(prompt[0].content,/不得输出批准/);
 assert.match(prompt[0].content,/JSON 字符串/);assert.match(prompt[0].content,/绝不能转为 JSON 数字/);
 assert.match(prompt[0].content,/相同问题只整理一次/);assert.match(prompt[0].content,/同一会话、同一客户/);
 const body=JSON.parse(prompt[1].content);assert.deepEqual(Object.keys(body),['untrusted_history']);
 assert.deepEqual(Object.keys(body.untrusted_history[0]),['messageId','conversationId','direction','authorKind','text']);
 assert.equal(body.untrusted_history.find((m:any)=>m.direction==='incoming').messageId,'history_message_1');
 assert.ok(!JSON.stringify(prompt).includes(scope.grantId));assert.equal(body.untrusted_history.length,2);
 assert.throws(()=>historyKnowledgeMessages({...sample,privacyPolicy:'none'} as any,scope));
 const filtered=historyKnowledgeMessages({...sample,messages:[...sample.messages,{...sample.messages[1],messageId:'3',private:true,text:'synthetic-private'}]},scope);
 assert.ok(!JSON.stringify(filtered).includes('synthetic-private'));
 assert.throws(()=>historyKnowledgeMessages({...sample,messages:[{...sample.messages[0],tenantId:'b'}]},scope));
});
test('opaque model labels resolve to exact authorized native IDs without numeric coercion or invented sources',()=>{
 const labeled={...proposal,sourceMessageIds:['history_message_1','history_message_2']};
 const original=parseHistoryKnowledgeOutput(JSON.stringify({drafts:[proposal]}),sample,scope)[0];
 const actual=parseHistoryKnowledgeOutput(JSON.stringify({drafts:[labeled]}),sample,scope)[0];
 assert.deepEqual(actual.sourceMessageIds,['1','2']);assert.equal(actual.sourceDigest,original.sourceDigest);
 for(const ids of [['history_message_1','history_message_missing'],['history_message_1',2],
  ['history_message_1','1'],['history_message_1','history_message_1']])
  assert.throws(()=>parseHistoryKnowledgeOutput(JSON.stringify({drafts:[{...proposal,sourceMessageIds:ids}]}),sample,scope));
 const big={...sample,messages:[{...sample.messages[0],messageId:'9007199254740992'},
  {...sample.messages[1],messageId:'9007199254740993'}]};
 const precise=parseHistoryKnowledgeOutput(JSON.stringify({drafts:[{...proposal,
  sourceMessageIds:['history_message_9007199254740992','history_message_9007199254740993']}]}),big,scope)[0];
 assert.deepEqual(precise.sourceMessageIds,['9007199254740992','9007199254740993']);
});
test('provider output remains review-required draft with real source pairing; arbitrary flags/privacy/duplicate questions rejected',()=>{
 const drafts=parseHistoryKnowledgeOutput(JSON.stringify({drafts:[proposal]}),sample,scope);
 assert.equal(drafts[0].state,'draft');assert.equal(drafts[0].automaticUseAllowed,false);assert.equal(drafts[0].requiresTenantReview,true);
 for(const body of [{drafts:[{...proposal,approved:true}]},{drafts:[{...proposal,sourceMessageIds:['1','3']}]},
  {drafts:[{...proposal,answer:'联系 a@example.invalid'}]},{drafts:[proposal,proposal]},
  {drafts:[{...proposal,sourceMessageIds:[1,2]}]},
  {drafts:[{...proposal,sourceMessageIds:[9007199254740992,9007199254740993]}]},
  {drafts:Array.from({length:6},()=>proposal)},{drafts:[proposal],publish:true}])assert.throws(()=>parseHistoryKnowledgeOutput(JSON.stringify(body),sample,scope));
 assert.deepEqual(parseHistoryKnowledgeOutput('{"drafts":[]}',sample,scope),[]);
 assert.throws(()=>parseHistoryKnowledgeOutput('x'.repeat(30001),sample,scope));
 const valid=JSON.stringify({drafts:[proposal]});
 assert.throws(()=>parseHistoryKnowledgeOutput(valid.replace('"answer":','"answer":"first","answer":'),sample,scope));
 assert.throws(()=>parseHistoryKnowledgeOutput(valid.replace('"answer":',String.raw`"\u0061nswer":"first","answer":`),sample,scope));
});
test('default-off operation never reaches authentication, DB, native reader, reservation or provider',async()=>{
 const forbidden=async()=>assert.fail('no effect');
 const s=createHistoricalKnowledgeService({connect:forbidden} as any,{read:forbidden},{enabled:()=>false,pointsEnabled:()=>true,configured:()=>true,
  reserve:forbidden,settle:forbidden,model:forbidden,capacity:forbidden});
 assert.deepEqual(await s.runOne(),{state:'disabled'});
 await assert.rejects(()=>s.request('a'.repeat(64),'a',{requestId:scope.grantId,confirmed:true}),/history_knowledge_disabled/);
});
test('request scope/confirmation/idempotency fields cannot choose actor/account/grant/SQL/model before DB',async()=>{
 const forbidden=async()=>assert.fail('no effect');
 const s=createHistoricalKnowledgeService({connect:forbidden} as any,{read:forbidden},{enabled:()=>true,pointsEnabled:()=>true,configured:()=>true,
  reserve:forbidden,settle:forbidden,model:forbidden,capacity:forbidden});
 for(const input of [null,[],{}, {requestId:'x',confirmed:true},{requestId:scope.grantId,confirmed:false},
  {requestId:scope.grantId,confirmed:true,grantId:scope.grantId}])await assert.rejects(()=>s.request('a'.repeat(64),'a',input),/confirmation_required/);
 await assert.rejects(()=>s.request('a'.repeat(64),'a;SQL',{requestId:scope.grantId,confirmed:true}),/confirmation_required/);
});
test('new schema is owner-install only; runtime does not get destructive or public privileges',async()=>{
 await assert.rejects(historyKnowledgeDatabaseComponent().migrate,/owner_migration_required/);
 const acl=historyKnowledgeRuntimeAcl('fixture_runtime');assert.match(acl,/GRANT SELECT,INSERT,UPDATE/);assert.ok(!/GRANT.*DELETE|GRANT.*CREATE|SECURITY DEFINER/.test(acl));
 assert.throws(()=>historyKnowledgeRuntimeAcl('owner;DROP'));
});
