import { alipayConfigFromEnv, alipayDecimalAmount, alipayMinorAmount, createAlipayClient, type AlipayConfig } from './alipay-provider.js';
import { validatePaymentQueryResult, type PaymentQueryOrder, type PaymentQueryResult } from './payment-query-core.js';

export type AlipayCall=(method:string,biz:Record<string,unknown>)=>Promise<Record<string,any>>;
export function signedAlipayCall(config:AlipayConfig,sdk:Pick<ReturnType<typeof createAlipayClient>,'exec'>=createAlipayClient(config)):AlipayCall {
  return async(method,biz)=>{
    try { return await sdk.exec(method,{bizContent:biz},{validateSign:true}); }
    // SDK errors can contain complete signed requests and buyer details. Never persist them.
    catch { throw new Error('alipay_transport_or_signature_error'); }
  };
}
function enabled(operation:'query'|'close'|'refund') {
  const flag=operation==='query'?'PAYMENT_ORDER_QUERY_ENABLED':operation==='close'?'ALIPAY_ORDER_CLOSE_ENABLED':'ALIPAY_REFUND_ENABLED';
  if(process.env.PAYMENT_PROVIDER!=='alipay'||process.env[flag]!=='true')throw new Error('alipay_operation_disabled');
}
function success(r:Record<string,any>) {
  if(r.code!=='10000')throw new Error('alipay_business_response_error');
}
function identity(order:PaymentQueryOrder,r:Record<string,any>) {
  if(r.out_trade_no!==order.order_number||typeof r.trade_no!=='string'||!/^\d{10,64}$/.test(r.trade_no)
    ||(order.provider_order_id&&r.trade_no!==order.provider_order_id))throw new Error('alipay_order_mismatch');
}
export function alipayTime(raw:unknown) {
  if(typeof raw!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw))throw new Error('alipay_time_incomplete');
  const date=new Date(raw.replace(' ','T')+'+08:00');
  if(!Number.isFinite(date.getTime())||new Date(date.getTime()+28800000).toISOString().slice(0,19)!==raw.replace(' ','T'))throw new Error('alipay_time_incomplete');
  return date.toISOString();
}
export function createAlipayOperations(config:AlipayConfig=alipayConfigFromEnv(),call:AlipayCall=signedAlipayCall(config)) {
  async function query(order:PaymentQueryOrder):Promise<PaymentQueryResult> {
    enabled('query');
    if(order.provider!=='alipay'||(order.payment_mode&&order.payment_mode!==config.mode))throw new Error('alipay_mode_mismatch');
    const r=await call('alipay.trade.query',{out_trade_no:order.order_number});
    // Not-found is not proof of cancellation: a saved checkout URL can still be opened later.
    if(r.code==='40004'&&r.sub_code==='ACQ.TRADE_NOT_EXIST')return {provider:'alipay',merchant_order_number:order.order_number,state:'unknown'};
    success(r);identity(order,r);
    if(r.total_amount===undefined||alipayMinorAmount(String(r.total_amount))!==order.amount_minor||(r.trans_currency&&r.trans_currency!=='CNY'))throw new Error('alipay_amount_mismatch');
    if(r.seller_id&&r.seller_id!==config.sellerId)throw new Error('alipay_recipient_mismatch');
    const base={provider:'alipay' as const,merchant_order_number:order.order_number,provider_order_id:r.trade_no};
    if(['TRADE_SUCCESS','TRADE_FINISHED'].includes(r.trade_status))return validatePaymentQueryResult(order,{...base,state:'paid',provider_transaction_id:r.trade_no,amount_minor:order.amount_minor,currency:'CNY',paid_at:alipayTime(r.send_pay_date)});
    if(r.trade_status==='WAIT_BUYER_PAY')return {...base,state:'pending'};
    // TRADE_CLOSED also represents a fully refunded payment. Do not erase payment history.
    if(r.trade_status==='TRADE_CLOSED')return {...base,state:'unknown'};
    return {...base,state:'unknown'};
  }
  async function queryAndClose(order:PaymentQueryOrder) {
    const result=await query(order);
    if(result.state!=='pending'||process.env.ALIPAY_ORDER_CLOSE_ENABLED!=='true'||!order.expires_at||new Date(order.expires_at).getTime()>Date.now())return result;
    enabled('close');
    // Only a successful, verified close call proves that WE closed an unpaid order.
    // A query-only TRADE_CLOSED may instead mean a full refund and must be reviewed.
    const r=await call('alipay.trade.close',{out_trade_no:order.order_number,trade_no:result.provider_order_id});
    if(r.code==='10000'){identity({...order,provider_order_id:result.provider_order_id},r);return {...result,state:'closed' as const};}
    // A close can race with payment. A failed close never cancels locally; query again.
    return query(order);
  }
  async function refund(order:PaymentQueryOrder,requestNumber:string,amount:number,reason:string) {
    enabled('refund');
    if(order.payment_mode!==config.mode||order.provider!=='alipay'||!order.provider_order_id||!Number.isSafeInteger(amount)||amount<=0||amount>order.amount_minor||!/^RNR[a-f0-9]{32}$/.test(requestNumber))throw new Error('alipay_refund_facts_mismatch');
    const biz={out_trade_no:order.order_number,trade_no:order.provider_order_id,out_request_no:requestNumber};
    // Query first on every attempt; a timeout must not cause a different refund request number.
    let r=await call('alipay.trade.fastpay.refund.query',{...biz,query_options:['gmt_refund_pay']});
    if(r.code==='10000'&&r.refund_status==='REFUND_SUCCESS')return verifiedRefund(r);
    if(!(r.code==='40004'&&r.sub_code==='ACQ.TRADE_NOT_EXIST') && !(r.code==='10000'&&!r.refund_status))throw new Error('alipay_refund_pending');
    const sent=await call('alipay.trade.refund',{...biz,refund_amount:alipayDecimalAmount(amount),refund_reason:reason.slice(0,256)});
    success(sent);identity(order,sent);
    if(alipayMinorAmount(String(sent.refund_fee))!==amount)throw new Error('alipay_refund_amount_mismatch');
    // Acknowledgement/fund_change alone is not our final refund receipt.
    // Official guidance recommends waiting >10 seconds before confirmation; the durable worker retries later.
    throw new Error('alipay_refund_pending');
    function verifiedRefund(receipt:Record<string,any>) {
      success(receipt);identity(order,receipt);
      if(receipt.out_request_no!==requestNumber||receipt.refund_status!=='REFUND_SUCCESS'
        ||alipayMinorAmount(String(receipt.refund_amount))!==amount||alipayMinorAmount(String(receipt.total_amount))!==order.amount_minor)throw new Error('alipay_refund_receipt_mismatch');
      return {amount_minor:amount,occurred_at:alipayTime(receipt.gmt_refund_pay)};
    }
  }
  return {query:queryAndClose,refund};
}
