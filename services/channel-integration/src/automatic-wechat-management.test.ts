import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AUTOMATIC_WECHAT_SEND_CONSENT_VERSION} from './automatic-wechat-target.js';
import {AUTOMATIC_WECHAT_DISCLOSURE_VERSION,validateAutomaticWeChatGrant} from './automatic-wechat-management.js';
const grant={enabled:true,expected_authorization_id:randomUUID(),expected_grant_id:null,channels:['shared_wechat'],confirmed:true,
 consent_version:AUTOMATIC_WECHAT_SEND_CONSENT_VERSION,disclosure_version:AUTOMATIC_WECHAT_DISCLOSURE_VERSION};
test('WeChat consent requires exact scopes, separate disclosure and explicit administrator confirmation',()=>{
 assert.deepEqual(validateAutomaticWeChatGrant(grant),{enabled:true,expectedAuthorization:grant.expected_authorization_id,expectedGrant:null,channels:['shared_wechat']});
 for(const v of [{...grant,confirmed:false},{...grant,disclosure_version:'web-chat-exact-answers-v1'},{...grant,disclosure_version:'wechat-exact-answers-v1'},{...grant,consent_version:'automatic-send-v1'},
  {...grant,disclosure_version:'wechat-knowledge-faq-v2'},{...grant,channels:[]},{...grant,channels:['shared_wechat','shared_wechat']},{...grant,channels:['broadcast']},{...grant,channels:['web_chat']},
  {...grant,tenant_id:'foreign'},{...grant,actor_id:randomUUID()},{...grant,expected_authorization_id:null},{...grant,expected_grant_id:'guess'}])assert.throws(()=>validateAutomaticWeChatGrant(v));
});
test('scope revocation is exact, unconfirmed and guarded by both authorization versions',()=>{
 const id=randomUUID();assert.deepEqual(validateAutomaticWeChatGrant({enabled:false,expected_authorization_id:grant.expected_authorization_id,expected_grant_id:id}),
  {enabled:false,expectedAuthorization:grant.expected_authorization_id,expectedGrant:id,channels:[]});
 assert.throws(()=>validateAutomaticWeChatGrant({...grant,enabled:false}));
 assert.deepEqual(validateAutomaticWeChatGrant({...grant,channels:['shared_wechat','wechat_official_account']}).channels,['shared_wechat','wechat_official_account']);
});
