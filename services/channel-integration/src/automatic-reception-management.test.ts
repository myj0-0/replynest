import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AUTOMATIC_SEND_CONSENT_VERSION} from './automatic-reply-policy.js';
import {AUTOMATIC_EVIDENCE_VERSION} from './automatic-reception-evidence.js';
import {AUTOMATIC_SEND_DISCLOSURE_VERSION,validateAutomaticAnswerInput,validateAutomaticManagementAction} from './automatic-reception-management.js';
const answer={document_id:randomUUID(),document_version:1,topic:'shipping_information',answer_text:'通常在两个工作日内发货。',keywords:['发货'],question_texts:['多久发货？'],valid_from:'2026-10-01T00:00:00.000Z',valid_until:'2026-11-01T00:00:00.000Z'};
const grant={enabled:true,expected_authorization_id:null,confirmed:true,consent_version:AUTOMATIC_SEND_CONSENT_VERSION,disclosure_version:AUTOMATIC_SEND_DISCLOSURE_VERSION};
test('send authorization requires separate current consent, disclosure and explicit confirmation',()=>{
 assert.deepEqual(validateAutomaticManagementAction('grant',grant),{kind:'grant',enabled:true,expected:null});
 for(const body of [{...grant,confirmed:false},{...grant,consent_version:'automatic-reply-v1'},{...grant,disclosure_version:'old'},{...grant,disclosure_version:'web-chat-exact-answers-v1'},
  {...grant,disclosure_version:'web-chat-knowledge-faq-v2'},{...grant,account_id:'2'},{...grant,actor_id:randomUUID()},{...grant,tenant_id:'b'},{...grant,expected_authorization_id:'guess'}])assert.throws(()=>validateAutomaticManagementAction('grant',body));
});
test('revocation does not require approval and cannot carry hidden targets or resurrect an old grant',()=>{
 const id=randomUUID();assert.deepEqual(validateAutomaticManagementAction('grant',{enabled:false,expected_authorization_id:id}),{kind:'grant',enabled:false,expected:id});
 assert.throws(()=>validateAutomaticManagementAction('grant',{...grant,enabled:false}));
});
test('answer input is a bounded exact configuration, not an executable or model approval',()=>{
 assert.equal(validateAutomaticAnswerInput(answer).answer_text,answer.answer_text);
 for(const input of [{...answer,status:'approved'},{...answer,approved_by:randomUUID()},{...answer,requires_human_approval:false},{...answer,confidencePercent:100},
  {...answer,answer_text:'x'.repeat(4001)},{...answer,question_texts:Array(21).fill('多久发货？')},{...answer,keywords:['发']},
  {...answer,document_version:0},{...answer,topic:'refund'},{...answer,valid_until:'2027-11-01T00:00:00.000Z'}])assert.throws(()=>validateAutomaticAnswerInput(input));
});
test('canonical dates and normalized duplicate samples fail closed',()=>{
 for(const input of [{...answer,valid_from:'2026-02-30T00:00:00.000Z'},{...answer,valid_until:answer.valid_from},
  {...answer,keywords:['发货',' 发货 ']},{...answer,question_texts:['多久发货？','多久 发货?']}])assert.throws(()=>validateAutomaticAnswerInput(input));
});
test('every change uses an exact string revision and content changes never carry approval fields',()=>{
 const id=randomUUID();assert.deepEqual(validateAutomaticManagementAction('replace',{expected_revision:'9007199254740993',answer},id).kind,'replace');
 for(const rev of [1,'0','-1','9223372036854775808'])assert.throws(()=>validateAutomaticManagementAction('disable',{expected_revision:rev},id));
 assert.throws(()=>validateAutomaticManagementAction('replace',{expected_revision:'1',answer,status:'approved'},id));
});
test('approval requires explicit evidence-version confirmation; disabling does not',()=>{
 const id=randomUUID();assert.equal(validateAutomaticManagementAction('approve',{expected_revision:'1',confirmed:true,approval_version:AUTOMATIC_EVIDENCE_VERSION},id).kind,'approve');
 assert.throws(()=>validateAutomaticManagementAction('approve',{expected_revision:'1',confirmed:false,approval_version:AUTOMATIC_EVIDENCE_VERSION},id));
 assert.equal(validateAutomaticManagementAction('disable',{expected_revision:'1'},id).kind,'disable');
});
