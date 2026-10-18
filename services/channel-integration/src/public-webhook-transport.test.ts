import assert from 'node:assert/strict';
import test from 'node:test';
import { postPublicWebhook, publicIpv4 } from './public-webhook-transport.js';
import { fakeWebhookResponse } from './webhook-test-transport.js';
import { EventEmitter } from 'node:events';

test('egress rejects private, reserved, mapped IPv6, hex, and alternate representations',()=>{
  for(const address of ['127.0.0.1','10.0.0.1','172.31.0.1','192.168.0.1','169.254.169.254',
    '0.0.0.0','100.64.0.1','198.18.0.1','224.0.0.1','192.0.2.1','::ffff:7f00:1','::ffff:a00:1','::ffff:ac10:1',
    '::ffff:c0a8:1','::ffff:127.0.0.1','2606:4700::1111','2130706433','0x7f000001'])assert.equal(publicIpv4(address),false,address);
});
test('only validated IP is supplied to both Node lookup modes; host/TLS URL preserved',async()=>{
  let lookups=0;
  const deps=fakeWebhookResponse(200,'ok',options=>{
    assert.equal(options.agent,false);assert.equal(options.family,4);assert.equal(options.rejectUnauthorized,true);
    options.lookup('attacker.example',{all:false},(error:any,ip:string,family:number)=>{assert.equal(error,null);assert.equal(ip,'8.8.8.8');assert.equal(family,4);lookups++;});
    options.lookup('attacker.example',{all:true},(error:any,list:any)=>{assert.equal(error,null);assert.deepEqual(list,[{address:'8.8.8.8',family:4}]);lookups++;});
  });
  assert.equal(await postPublicWebhook(new URL('https://example.test'),'{}',{},true,deps),'ok');assert.equal(lookups,2);
});

test('hung HTTP requests time out and shared egress concurrency is bounded',async context=>{
  context.mock.timers.enable({apis:['setTimeout']});
  let destroyed=0;
  const deps={resolve4:async()=>['8.8.8.8'],request:((_url:any,_options:any,_callback:any)=>{
    const req=new EventEmitter() as any;req.end=()=>{};req.destroy=()=>{destroyed++;req.emit('close');};return req;
  }) as never};
  const pending=Array.from({length:8},()=>assert.rejects(postPublicWebhook(new URL('https://example.test'),'{}',{},true,deps),/webhook_timeout/));
  await new Promise<void>(resolve=>setImmediate(resolve));
  await assert.rejects(postPublicWebhook(new URL('https://example.test'),'{}',{},true,deps),/capacity_exceeded/);
  context.mock.timers.tick(10001);await Promise.all(pending);assert.equal(destroyed,8);
  assert.equal(await postPublicWebhook(new URL('https://example.test'),'{}',{},true,fakeWebhookResponse(200,'ok')),'ok');
});
test('mixed public/private DNS response never opens a socket',async()=>{
  let opened=false;const deps=fakeWebhookResponse();deps.resolve4=async()=>['8.8.8.8','127.0.0.1'];deps.request=(()=>{opened=true;}) as never;
  await assert.rejects(postPublicWebhook(new URL('https://example.test'),'{}',{},true,deps),/non_public/);assert.equal(opened,false);
});
test('redirects fail and large or compressed responses are bounded',async()=>{
  const url=new URL('https://example.test');
  await assert.rejects(postPublicWebhook(url,'{}',{},true,fakeWebhookResponse(302)),/http_302/);
  await assert.rejects(postPublicWebhook(url,'{}',{},true,fakeWebhookResponse(200,'x'.repeat(16385))),/response_limit/);
  await assert.rejects(postPublicWebhook(url,'{}',{},true,fakeWebhookResponse(200,'',undefined,{'content-length':'20000'})),/response_limit/);
  await assert.rejects(postPublicWebhook(url,'{}',{},true,fakeWebhookResponse(200,'',undefined,{'content-encoding':'gzip'})),/response_limit/);
  await assert.rejects(postPublicWebhook(url,'x'.repeat(65537),{},true,fakeWebhookResponse()),/request_too_large/);
});
