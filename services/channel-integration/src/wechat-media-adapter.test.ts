import test from 'node:test';
import assert from 'node:assert/strict';
import {downloadOfficialMedia,inspectWechatMedia,sendOfficialMedia,WechatMediaSendFailure,mediaSendDiagnostic,mediaSendFailureOutcome,mediaSendFailureMessage} from './wechat-media-adapter.js';
import {WeChatSendRejected} from './wechat-send-error.js';
const config={appId:'synthetic-app',appSecret:'synthetic-secret',token:'unused'};
const png=Buffer.from('89504e470d0a1a0a01020304','hex');
const mp4=Buffer.from('000000106674797069736f6d00000000','hex');
const token=async()=> 'synthetic-token';
test('formats are detected from bytes, unsafe and oversized bytes are refused',()=>{
  assert.equal(inspectWechatMedia('image',png).mimeType,'image/png');
  assert.equal(inspectWechatMedia('video',mp4).mimeType,'video/mp4');
  assert.equal(inspectWechatMedia('voice',Buffer.from('#!AMR\nabc')).mimeType,'audio/amr');
  assert.equal(inspectWechatMedia('voice',Buffer.from('OggS---Speex   ---')).mimeType,'audio/speex');
  assert.throws(()=>inspectWechatMedia('image',Buffer.from('<html>')),/format/);
  assert.throws(()=>inspectWechatMedia('video',Buffer.alloc(11*1024*1024)),/size/);
});
test('download uses only the fixed provider origin and rejects redirects/oversized streams',async()=>{
  let calls=0;
  const fetcher:typeof fetch=async(url,options)=>{calls++;assert.equal(new URL(String(url)).hostname,'api.weixin.qq.com');assert.equal(options?.redirect,'error');return new Response(new Uint8Array(png));};
  assert.equal((await downloadOfficialMedia(config,{kind:'image',mediaId:'media-id'},{fetcher,token})).bytes.length,png.length);assert.equal(calls,1);
  await assert.rejects(()=>downloadOfficialMedia(config,{kind:'video',mediaId:'media-id'},{token,fetcher:async()=>new Response(JSON.stringify({video_url:'http://127.0.0.1/secret'}))}),/url_rejected/);
  await assert.rejects(()=>downloadOfficialMedia(config,{kind:'image',mediaId:'media-id'},{token,fetcher:async()=>new Response(new Uint8Array(png),{headers:{'content-length':String(11*1024*1024)}})}),/size/);
  await assert.rejects(()=>downloadOfficialMedia(config,{kind:'image',mediaId:'media-id'},{token,fetcher:async()=>new Response(new Uint8Array(11*1024*1024))}),/size/);
});
test('video URL is HTTPS-upgraded only for the explicit provider hostname',async()=>{
  const urls:string[]=[];
  const result=await downloadOfficialMedia(config,{kind:'video',mediaId:'media-id'},{token,fetcher:async(url,opts)=>{urls.push(String(url));assert.equal(opts?.redirect,'error');return urls.length===1?new Response(JSON.stringify({video_url:'http://video.weixin.qq.com/media/1'})):new Response(new Uint8Array(mp4));}});
  assert.equal(result.mimeType,'video/mp4');assert.equal(urls[1],'https://video.weixin.qq.com/media/1');
});
test('manual media send gates, multipart upload, provider rejection and uncertain outcomes',async()=>{
  const names=['WECHAT_MEDIA_ENABLED','WECHAT_LIVE_ENABLED','SHARED_WECHAT_APP_ID','SHARED_WECHAT_MANUAL_SEND_ENABLED'];const previous=names.map(n=>process.env[n]);
  const file={bytes:png,...inspectWechatMedia('image',png)};let calls=0;
  const fetcher:typeof fetch=async(url,opts)=>{calls++;if(String(url).includes('/media/upload')){assert(opts?.body instanceof FormData);return new Response(JSON.stringify({media_id:'uploaded-media'}));}const payload=JSON.parse(String(opts?.body));assert.equal(payload.msgtype,'image');assert.equal(payload.image.media_id,'uploaded-media');return new Response('{"errcode":0}');};
  try{
    process.env.WECHAT_MEDIA_ENABLED='false';await assert.rejects(()=>sendOfficialMedia(config,'user','image',file,{shared:false},{token,fetcher}),/disabled/);assert.equal(calls,0);
    process.env.WECHAT_MEDIA_ENABLED='true';process.env.WECHAT_LIVE_ENABLED='true';process.env.SHARED_WECHAT_APP_ID='different';
    await sendOfficialMedia(config,'user','image',file,{shared:false},{token,fetcher});assert.equal(calls,2);
    for(const uncertain of [false,true]){
      let sends=0;
      await assert.rejects(()=>sendOfficialMedia(config,'user','image',file,{shared:false},{token,fetcher:async(url)=>{if(String(url).includes('/media/upload'))return new Response('{"media_id":"uploaded-media"}');sends++;if(uncertain)throw Error('lost response');return new Response('{"errcode":45015}');}}),uncertain?/send_transport_failed/:WeChatSendRejected);
      assert.equal(sends,1,'never auto-retry an external send');
    }
    process.env.SHARED_WECHAT_APP_ID=config.appId;process.env.SHARED_WECHAT_MANUAL_SEND_ENABLED='false';await assert.rejects(()=>sendOfficialMedia(config,'user','image',file,{shared:true},{token,fetcher}),/disabled/);
  }finally{names.forEach((n,i)=>{if(previous[i]===undefined)delete process.env[n];else process.env[n]=previous[i];});}
});
test('video preparation diagnostics distinguish token/upload failures and never reach send',async()=>{
  const names=['WECHAT_MEDIA_ENABLED','WECHAT_LIVE_ENABLED','SHARED_WECHAT_APP_ID'];const prior=names.map(n=>process.env[n]);
  try{
    process.env.WECHAT_MEDIA_ENABLED='true';process.env.WECHAT_LIVE_ENABLED='true';process.env.SHARED_WECHAT_APP_ID='different';
    const file={bytes:mp4,...inspectWechatMedia('video',mp4)};
    const cases=[{stage:'token',reason:'token_unavailable',token:async()=>{throw Error('private-secret-url');}},
      {stage:'upload',reason:'transport_failed',fetcher:async()=>{throw Error('private-token');}},
      {stage:'upload',reason:'http_rejected',fetcher:async()=>new Response('private-body',{status:503}),http_status:503},
      {stage:'upload',reason:'provider_rejected',fetcher:async()=>new Response('{"errcode":40007,"errmsg":"private-id"}'),provider_code:40007},
      {stage:'upload',reason:'response_invalid',fetcher:async()=>new Response('null')},
      {stage:'upload',reason:'response_invalid',fetcher:async()=>new Response('private-html')}];
    for(const scenario of cases){let calls=0;
      await assert.rejects(()=>sendOfficialMedia(config,'user','video',file,{shared:false},{token:scenario.token??token,fetcher:async(url)=>{
        calls++;assert.match(String(url),/\/media\/upload/);return scenario.fetcher!();
      }}),error=>{
        assert(error instanceof WechatMediaSendFailure);const diagnostic=mediaSendDiagnostic(error,'send');
        assert.equal(diagnostic.stage,scenario.stage);assert.equal(diagnostic.reason,scenario.reason);
        if(scenario.http_status)assert.equal((diagnostic as any).http_status,scenario.http_status);
        if(scenario.provider_code)assert.equal((diagnostic as any).provider_code,scenario.provider_code);
        assert.deepEqual(mediaSendFailureOutcome(error,true),{uncertain:false,code:'media_not_sent'});
        assert.doesNotMatch(JSON.stringify(diagnostic)+mediaSendFailureMessage('media_not_sent',diagnostic),/private/);return true;
      });assert.equal(calls,scenario.stage==='token'?0:1);
    }
  }finally{names.forEach((n,i)=>{if(prior[i]===undefined)delete process.env[n];else process.env[n]=prior[i];});}
});
test('send-stage uncertainty stays uncertain while explicit rejection is definite; unknown errors are redacted',()=>{
  for(const reason of ['transport_failed','http_rejected','response_invalid'] as const){
    const error=new WechatMediaSendFailure('send',reason,502);
    assert.deepEqual(mediaSendFailureOutcome(error,true),{uncertain:true,code:'send_outcome_uncertain'});
    assert.match(mediaSendFailureMessage('send_outcome_uncertain',mediaSendDiagnostic(error,'send')),/请勿重发/);
  }
  assert.deepEqual(mediaSendFailureOutcome(new WeChatSendRejected(45015),true),{uncertain:false,code:'wechat_media_rejected'});
  assert.deepEqual(mediaSendDiagnostic(Error('https://secret/?token=secret'),'history'),{stage:'history',reason:'stage_failed'});
  assert.deepEqual(mediaSendFailureOutcome(Error('history_failed'),false),{uncertain:false,code:'media_not_sent'});
  assert.deepEqual(mediaSendFailureOutcome(Error('ledger_failed'),true),{uncertain:true,code:'send_outcome_uncertain'});
  assert.deepEqual(mediaSendDiagnostic(new WechatMediaSendFailure('upload','provider_rejected',200,'secret' as any),'send'),{stage:'upload',reason:'provider_rejected',http_status:200});
});
