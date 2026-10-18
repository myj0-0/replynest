import test from 'node:test';
import assert from 'node:assert/strict';
import {officialMedia,mediaNotice,mediaOnlyMessage,notificationMediaMetadata} from './wechat-media-core.js';
import {webhookPayload} from './notification-webhook-adapter.js';
import {routeSharedEvent,type RoutingState} from './shared-wechat-routing.js';
const id='f4e98bea-a0d3-4bb1-8990-b0762742f632';
test('media parser validates identifiers and does not retain callback URLs',()=>{
  for(const type of ['image','video','shortvideo','voice']){
    const parsed=officialMedia({MsgType:type,MsgId:'123',MediaId:'safe-id',PicUrl:'http://127.0.0.1/secret',Format:'amr'});
    assert.equal(parsed?.kind,type==='shortvideo'?'video':type);assert.doesNotMatch(JSON.stringify(parsed),/127\.0\.0\.1/);
  }
  for(const raw of [{MsgType:'image',MediaId:'x'},{MsgType:'image',MsgId:'1',MediaId:'../x'},{MsgType:'voice',MsgId:'1',MediaId:'x',Format:'html'}] as Record<string,string>[])assert.throws(()=>officialMedia(raw),/invalid_wechat/);
  assert.equal(officialMedia({MsgType:'location'}),undefined);
});
test('public media notification is an allowlist with authenticated attachment references',()=>{
  const media:any={message_type:'image',attachment_count:1,attachment_id:id,view_path:`/workbench?conversation=${id}`,mediaId:'private-provider-id',recognition:'private-transcript',url:'https://secret/?token=private-token'};
  const output:any=webhookPayload('custom',{event_id:'e',title:'新消息',summary:'图片',severity:'info',occurred_at:'2026-10-11',media});
  assert.equal(output.media.attachments[0].content_path,`/api/v1/attachments/${id}/content`);
  assert.equal(output.media.attachments[0].authentication_required,true);
  assert.equal((webhookPayload('custom',{event_id:'e',title:'新消息',summary:'图片',severity:'info',occurred_at:'now',media:{...media,processing_status:'ready'}}) as any).media.processing_status,'ready');
  assert.doesNotMatch(JSON.stringify(output),/private-provider-id|private-transcript|private-token/);
  for(const provider of ['wecom','dingtalk','feishu'] as const){const bot=JSON.stringify(webhookPayload(provider,{event_id:'e',title:'新消息',summary:'图片',severity:'info',occurred_at:'now',media}));assert.match(bot,/消息类型：图片/);assert.match(bot,/console.replynest.cn/);assert.doesNotMatch(bot,/private-/);}
  assert.deepEqual(mediaNotice({...media,view_path:'https://evil.test',attachment_id:'../../secret'}),{message_type:'image',attachment_count:1});
  assert.equal(mediaNotice({...media,attachment_count:999}),undefined);
});
test('media cannot route to the wrong merchant, expired choices do not silently fall back',()=>{
  const now=1800000000000;
  const state:RoutingState={appId:'app',openId:'user',associations:[{tenantId:'A',name:'A'},{tenantId:'B',name:'B'}],version:0,lastTransitionAt:0};
  const event={appId:'app',openId:'user',eventId:'image-1',occurredAt:now,kind:'media' as const};
  const active=new Set(['A','B']);
  assert.equal(routeSharedEvent(state,event,active,now).action,'choose');
  state.selected={tenantId:'A',expiresAt:now+10000};
  assert.equal(routeSharedEvent(state,event,active,now).tenantId,'A');
  assert.notEqual(routeSharedEvent(state,event,new Set(['B']),now).tenantId,'B');
  state.selected.expiresAt=now;
  assert.equal(routeSharedEvent(state,event,active,now).action,'choose');
  assert.throws(()=>routeSharedEvent(state,{...event,openId:'different'},active,now),/identity_mismatch/);
});
test('media placeholder and native attachment messages cannot become AI text questions',()=>{
  assert.equal(mediaOnlyMessage({content:'[公众号消息] 图片'}),true);
  assert.equal(mediaOnlyMessage({content:'',attachments:[{id:1}]}),true);
  assert.equal(mediaOnlyMessage({content:'你好'}),false);
});
test('event metadata preserves validated media and strips provider credentials before persistence',()=>{
  for(const message_type of ['image','video','voice']){
    const input={message_type,attachment_count:1,media_view_path:`/workbench?conversation=${id}`,media_attachment_id:id,media_status:'ready',OpenID:'secret',MediaId:'secret',recognition:'secret',token:'secret'};
    const output=notificationMediaMetadata(input);assert.equal(output.message_type,message_type);assert.equal(output.media_attachment_id,id);assert.doesNotMatch(JSON.stringify(output),/secret/);
    const payload:any=webhookPayload('custom',{event_id:id,title:'合成通知',summary:'无客户数据',severity:'info',occurred_at:'now',media:{message_type:output.message_type,attachment_count:output.attachment_count,attachment_id:output.media_attachment_id,processing_status:output.media_status} as any});
    assert.equal(payload.media.attachments[0].authentication_required,true);
  }
  assert.deepEqual(notificationMediaMetadata({message_type:'video',attachment_count:999,media_attachment_id:id}),{});
  assert.deepEqual(notificationMediaMetadata({message_type:'voice',attachment_count:1,media_attachment_id:'https://secret/?token=x',media_view_path:'https://secret'}),{message_type:'voice',attachment_count:1,media_attachment_id:null,media_view_path:null,media_status:null});
});
