import test from 'node:test';import assert from 'node:assert/strict';
import {quickReplyImageEnabled,quickReplyPayload,quickReplyTransferId} from './quick-reply-images-core.js';
const id='90000000-0000-4000-a000-000000000001';
test('text, image-only and text/image are distinct validated payloads',()=>{
 assert.deepEqual(quickReplyPayload({content:' hello '},true),{content:'hello',image_asset_id:null});
 assert.deepEqual(quickReplyPayload({content:'',image_asset_id:id},true),{content:'',image_asset_id:id});
 assert.deepEqual(quickReplyPayload({content:'hello',image_asset_id:id},true),{content:'hello',image_asset_id:id});
 for(const body of [{content:''},{content:'x'.repeat(4001)},{content:123},{content:'x',url:'https://evil.example'},{content:'',image_asset_id:'https://evil.example'}])assert.throws(()=>quickReplyPayload(body,true));
});
test('feature requires explicit enable, image field cannot silently disappear while disabled',()=>{
 assert.equal(quickReplyImageEnabled({}),false);assert.equal(quickReplyImageEnabled({QUICK_REPLY_IMAGES_ENABLED:'true'}),true);
 assert.throws(()=>quickReplyPayload({content:'caption',image_asset_id:id},false));
});
test('prepared copies are deterministic but isolated by tenant, conversation, version and action',()=>{
 const args=['tenant-a','conversation-a','manual-action',id,'2026-10-13T00:00:00.000Z'] as const;
 const base=quickReplyTransferId(...args);assert.match(base,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
 assert.equal(base,quickReplyTransferId(...args));
 for(let i=0;i<5;i++){const changed=[...args];changed[i]+='changed';assert.notEqual(base,quickReplyTransferId(...changed as [string,string,string,string,string]));}
});
