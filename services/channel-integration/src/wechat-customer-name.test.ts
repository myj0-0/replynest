import {test} from 'node:test';
import assert from 'node:assert/strict';
import {wechatCustomerName} from './wechat-customer-name.js';
test('WeChat generic name shows only the last four verified characters',()=>{
 assert.equal(wechatCustomerName('微信访客','shared_wechat','oTestCustomer_A9-b'),'微信访客 · A9-b');
 assert.equal(wechatCustomerName('微信访客','wechat_official_account','independent1234'),'微信访客 · 1234');
});
test('nickname, manual name, non-WeChat channel and malformed source are preserved',()=>{
 for(const name of ['小王','客服命名','微信访客 · 5678'])assert.equal(wechatCustomerName(name,'shared_wechat','openid1234'),name);
 assert.equal(wechatCustomerName('微信访客','web_chat','openid1234'),'微信访客');
 for(const source of [null,undefined,1234,'a','<script>',' abc1234'])assert.equal(wechatCustomerName('微信访客','shared_wechat',source),'微信访客');
});
test('valid unexpired authorized nickname wins only over the generic name',()=>{
 assert.equal(wechatCustomerName('微信访客','shared_wechat','openid1234','微信小王'),'微信小王');
 assert.equal(wechatCustomerName('客服手动命名','shared_wechat','openid1234','微信小王'),'客服手动命名');
 for(const nickname of ['', '  ', 'bad\nname', 'a'.repeat(101), null])assert.equal(wechatCustomerName('微信访客','shared_wechat','openid1234',nickname),'微信访客 · 1234');
});
