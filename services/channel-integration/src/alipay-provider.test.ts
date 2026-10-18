import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,verify} from 'node:crypto';
import {createServer} from 'node:http';
import {createAlipayClient,buildAlipayCheckout,verifyAlipayPayment,alipayMinorAmount,alipayDecimalAmount,parseAlipayNotification,type AlipayConfig} from './alipay-provider.js';
import {handleAlipayNotify} from './alipay-notify.js';
const app=generateKeyPairSync('rsa',{modulusLength:2048}),provider=generateKeyPairSync('rsa',{modulusLength:2048});
const config:AlipayConfig={appId:'2021000000000001',sellerId:'2088000000000001',privateKey:app.privateKey.export({format:'pem',type:'pkcs8'}).toString(),publicKey:provider.publicKey.export({format:'pem',type:'spki'}).toString(),mode:'sandbox',notifyUrl:'https://api.replynest.cn/webhooks/alipay',returnUrl:'https://console.replynest.cn/billing'};
const facts={app_id:config.appId,seller_id:config.sellerId,sign_type:'RSA2',out_trade_no:'RN20260922ABCDEF12',trade_no:'202609222200000000000001',trade_status:'TRADE_SUCCESS',total_amount:'99.00',gmt_payment:'2026-09-22 12:34:56',subject:'答巢 + % 套餐'};
function notification(overrides:Record<string,string>={}) {
 const data:Record<string,string>={...facts,...overrides};
 const canonical=Object.keys(data).filter(k=>!['sign','sign_type'].includes(k)&&data[k]!=='').sort().map(k=>`${k}=${data[k]}`).join('&');
 data.sign=sign('RSA-SHA256',Buffer.from(canonical),provider.privateKey).toString('base64');return Buffer.from(new URLSearchParams(data).toString());
}
test('integer cents round-trip without floating-point or exponent coercion',()=>{
 for(const [text,minor] of [['0.01',1],['99.9',9990],['100',10000]] as const){assert.equal(alipayMinorAmount(text),minor);assert.equal(alipayMinorAmount(alipayDecimalAmount(minor)),minor);}
 for(const amount of ['0','-1','1.001','1e2',' 1.00','NaN','01.00'])assert.throws(()=>alipayMinorAmount(amount));
});
test('official SDK signs both website flows and pins gateway/callbacks; default off',()=>{
 const old=[process.env.PAYMENT_PROVIDER,process.env.PAYMENT_LIVE_ENABLED];
 const order={orderNumber:facts.out_trade_no,amountMinor:9900,currency:'CNY',subject:'答巢套餐'};
 try {
  process.env.PAYMENT_PROVIDER='alipay';process.env.PAYMENT_LIVE_ENABLED='false';assert.throws(()=>buildAlipayCheckout(config,order,'desktop'),/disabled/);
  process.env.PAYMENT_LIVE_ENABLED='true';
  for(const device of ['desktop','mobile'] as const){const url=new URL(buildAlipayCheckout(config,order,device));assert.equal(url.hostname,'openapi-sandbox.dl.alipaydev.com');assert.equal(url.searchParams.get('sign_type'),'RSA2');
   const params=Object.fromEntries(url.searchParams);const canonical=Object.keys(params).filter(k=>k!=='sign'&&params[k]!=='').sort().map(k=>`${k}=${params[k]}`).join('&');assert(verify('RSA-SHA256',Buffer.from(canonical),app.publicKey,Buffer.from(params.sign,'base64')));
   const biz=JSON.parse(params.biz_content);assert.equal(biz.total_amount,'99.00');assert.equal(biz.seller_id,config.sellerId);assert.equal(biz.product_code,device==='desktop'?'FAST_INSTANT_TRADE_PAY':'QUICK_WAP_WAY');}
  assert.throws(()=>buildAlipayCheckout({...config,returnUrl:'https://evil.example'},order,'mobile'));
 }finally{['PAYMENT_PROVIDER','PAYMENT_LIVE_ENABLED'].forEach((k,i)=>{if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i];});}
});
test('notification verifies exact once-decoded values and pins recipient',()=>{
 const paid=verifyAlipayPayment(config,notification());assert.equal(paid?.amountMinor,9900);assert.equal(paid?.paidAt,'2026-09-22T04:34:56.000Z');
 const invalid:Record<string,string>[]=[{app_id:'2021000000000002'},{seller_id:'2088000000000002'},{sign_type:'RSA'},{total_amount:'99.001'},{gmt_payment:'2026-02-31 12:00:00'}];
 for(const override of invalid)assert.throws(()=>verifyAlipayPayment(config,notification(override)));
 const tampered=notification().toString().replace('99.00','1.00');assert.throws(()=>verifyAlipayPayment(config,Buffer.from(tampered)),/signature/);
 assert.equal(verifyAlipayPayment(config,notification({trade_status:'WAIT_BUYER_PAY'})),null);
 assert.equal(verifyAlipayPayment(config,notification({trade_status:'TRADE_FINISHED'}))?.eventId,paid?.eventId);
 assert.throws(()=>parseAlipayNotification(Buffer.concat([notification(),Buffer.from('&total_amount=1.00')])));
 assert.throws(()=>parseAlipayNotification(Buffer.alloc(65537)));
});
test('PKCS1 tool export supported; wrong public key never verifies callback',()=>{
 assert(createAlipayClient({...config,privateKey:app.privateKey.export({type:'pkcs1',format:'pem'}).toString()}));
 assert.throws(()=>verifyAlipayPayment({...config,publicKey:app.publicKey.export({type:'spki',format:'pem'}).toString()},notification()));
});
test('HTTP callback acknowledges only committed trusted payments; errors stay generic',async()=>{
 let enabled=false,failed=false,writes=0;const deps={get enabled(){return enabled;},config:()=>config,record:async()=>{if(failed)throw new Error('DO_NOT_EXPOSE');writes++;}};
 const server=createServer(async(req,res)=>{await handleAlipayNotify(req,res,new URL(req.url!,'http://local'),deps);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}/webhooks/alipay`;
 const post=(body=notification())=>fetch(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});
 try {
  assert.equal((await post()).status,404);enabled=true;assert.equal((await fetch(url)).status,405);
  assert.equal(await (await post()).text(),'success');assert.equal(writes,1);
  assert.equal((await post(notification({seller_id:'2088000000000002'}))).status,400);assert.equal(writes,1);
  failed=true;const res=await post();assert.equal(res.status,400);assert.equal(await res.text(),'failure');assert.equal(writes,1);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
