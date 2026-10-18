import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync,sign } from 'node:crypto';
import { createServer } from 'node:http';
import { createAlipayClient,type AlipayConfig } from './alipay-provider.js';
import { createAlipayOperations,signedAlipayCall } from './alipay-operations.js';

const app=generateKeyPairSync('rsa',{modulusLength:2048}),alipay=generateKeyPairSync('rsa',{modulusLength:2048});
const config:AlipayConfig={appId:'2021000000000001',sellerId:'2088000000000001',privateKey:app.privateKey.export({format:'pem',type:'pkcs8'}).toString(),publicKey:alipay.publicKey.export({format:'pem',type:'spki'}).toString(),mode:'sandbox',notifyUrl:'',returnUrl:''};
const order={provider:'alipay' as const,order_number:'RN20260922ABCDEF123456',provider_order_id:'20260922220000000001',amount_minor:9900,currency:'CNY',payment_mode:'sandbox',expires_at:'2020-01-01T00:00:00Z'};
const base={code:'10000',out_trade_no:order.order_number,trade_no:order.provider_order_id,total_amount:'99.00'};

test('official SDK response verification rejects forged/missing signatures and strips sensitive errors',async()=>{
  let forged=false,missing=false;
  const server=createServer(async(req,res)=>{for await(const _ of req){}const data={...base,trade_status:'TRADE_SUCCESS',send_pay_date:'2026-09-22 10:00:00'};
    const signature=sign('RSA-SHA256',Buffer.from(JSON.stringify(data)),forged?app.privateKey:alipay.privateKey).toString('base64');
    res.setHeader('content-type','application/json');res.end(JSON.stringify({alipay_trade_query_response:data,...missing?{}:{sign:signature}}));});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
    const sdk=createAlipayClient(config);sdk.config.gateway=`http://127.0.0.1:${(server.address() as {port:number}).port}/gateway.do`;
    const call=signedAlipayCall(config,sdk);
    assert.equal((await call('alipay.trade.query',{})).trade_status,'TRADE_SUCCESS');
    forged=true;await assert.rejects(call('alipay.trade.query',{}),/^Error: alipay_transport_or_signature_error$/);
    forged=false;missing=true;await assert.rejects(call('alipay.trade.query',{}),/^Error: alipay_transport_or_signature_error$/);
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
test('query/close/refund semantics fail closed and handle races',async t=>{
  const saved={...process.env};Object.assign(process.env,{PAYMENT_PROVIDER:'alipay',PAYMENT_ORDER_QUERY_ENABLED:'true',ALIPAY_ORDER_CLOSE_ENABLED:'true',ALIPAY_REFUND_ENABLED:'true'});
  try {
    await t.test('paid query binds order, cents and provider transaction; missing time fails',async()=>{
      const paid={...base,trade_status:'TRADE_SUCCESS',send_pay_date:'2026-09-22 10:00:00'};
      assert.equal((await createAlipayOperations(config,async()=>paid).query(order)).state,'paid');
      for(const changed of [{out_trade_no:'other'},{total_amount:'0.01'},{trade_no:'20260922220000000099'},{seller_id:'other'},{send_pay_date:''}])await assert.rejects(createAlipayOperations(config,async()=>({...paid,...changed})).query(order),/mismatch|incomplete/);
    });
    await t.test('timeout close racing with payment reconciles paid instead of cancelling',async()=>{
      const calls:string[]=[];
      const adapter=createAlipayOperations(config,async method=>{calls.push(method);return calls.length===1?{...base,trade_status:'WAIT_BUYER_PAY'}:method==='alipay.trade.close'?{code:'40004'}:{...base,trade_status:'TRADE_SUCCESS',send_pay_date:'2026-09-22 10:00:00'};});
      assert.equal((await adapter.query(order)).state,'paid');assert.deepEqual(calls,['alipay.trade.query','alipay.trade.close','alipay.trade.query']);
    });
    await t.test('unknown trade and previously paid closed trade are not unpaid cancellations',async()=>{
      assert.equal((await createAlipayOperations(config,async()=>({code:'40004',sub_code:'ACQ.TRADE_NOT_EXIST'})).query(order)).state,'unknown');
      assert.equal((await createAlipayOperations(config,async()=>({...base,trade_status:'TRADE_CLOSED',send_pay_date:'2026-09-22 10:00:00'})).query(order)).state,'unknown');
      assert.equal((await createAlipayOperations(config,async()=>({...base,trade_status:'TRADE_CLOSED'})).query(order)).state,'unknown');
      assert.equal((await createAlipayOperations(config,async method=>method==='alipay.trade.query'?{...base,trade_status:'WAIT_BUYER_PAY'}:base).query(order)).state,'closed');
    });
    await t.test('refund timeout recovery queries stable request ID and only trusts confirmed receipt',async()=>{
      const number='RNR'+'a'.repeat(32);let confirmed=false;const calls:{method:string;biz:Record<string,unknown>}[]=[];
      const adapter=createAlipayOperations(config,async(method,biz)=>{calls.push({method,biz});
        if(method==='alipay.trade.refund'){confirmed=true;throw new Error('simulated_timeout');}
        return confirmed?{...base,out_request_no:number,refund_status:'REFUND_SUCCESS',refund_amount:'99.00',gmt_refund_pay:'2026-09-22 10:05:00'}:{code:'40004',sub_code:'ACQ.TRADE_NOT_EXIST'};});
      await assert.rejects(adapter.refund(order,number,9900,'customer requested full refund'),/simulated_timeout/);
      assert.equal((await adapter.refund(order,number,9900,'customer requested full refund')).amount_minor,9900);
      assert.equal(calls.filter(c=>c.method==='alipay.trade.refund').length,1);
      assert.ok(calls.every(c=>c.biz.out_request_no===number));
      assert.deepEqual(calls[0].biz.query_options,['gmt_refund_pay']);
      await assert.rejects(createAlipayOperations(config,async()=>({...base,out_request_no:'other',refund_status:'REFUND_SUCCESS',refund_amount:'99.00',gmt_refund_pay:'2026-09-22 10:05:00'})).refund(order,number,9900,'customer requested full refund'),/mismatch/);
    });
    await t.test('policy refund binds deducted amount while validating original order total',async()=>{
      const number='RNR'+'b'.repeat(32);
      const receipt={...base,out_request_no:number,refund_status:'REFUND_SUCCESS',refund_amount:'98.01',gmt_refund_pay:'2026-09-22 10:05:00'};
      assert.equal((await createAlipayOperations(config,async()=>receipt).refund(order,number,9801,'policy refund after platform fee')).amount_minor,9801);
      for(const change of [{total_amount:'98.01'},{refund_amount:'99.00'}])await assert.rejects(createAlipayOperations(config,async()=>({...receipt,...change})).refund(order,number,9801,'policy refund after platform fee'),/mismatch/);
      for(const amount of [0,-1,9901,98.01])await assert.rejects(createAlipayOperations(config,async()=>receipt).refund(order,number,amount,'invalid refund amount'),/mismatch/);
    });
    await t.test('switches prevent any network calls',async()=>{
      delete process.env.PAYMENT_ORDER_QUERY_ENABLED;delete process.env.ALIPAY_REFUND_ENABLED;
      let calls=0;const adapter=createAlipayOperations(config,async()=>{calls++;return base;});
      await assert.rejects(adapter.query(order),/disabled/);await assert.rejects(adapter.refund(order,'RNR'+'a'.repeat(32),9900,'valid refund request'),/disabled/);assert.equal(calls,0);
    });
  }finally{for(const key of ['PAYMENT_PROVIDER','PAYMENT_ORDER_QUERY_ENABLED','ALIPAY_ORDER_CLOSE_ENABLED','ALIPAY_REFUND_ENABLED'])if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}
});
