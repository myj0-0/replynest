import {createPrivateKey,createPublicKey} from 'node:crypto';
import {AlipaySdk} from 'alipay-sdk';
import {secretValue} from './secret-value.js';

export type AlipayConfig={appId:string;sellerId:string;privateKey:string;publicKey:string;mode:'sandbox'|'live';notifyUrl:string;returnUrl:string};
export const alipayGateways={live:'https://openapi.alipay.com/gateway.do',sandbox:'https://openapi-sandbox.dl.alipaydev.com/gateway.do'};
function pem(raw:string,label:string){return raw.includes('-----BEGIN')?raw:`-----BEGIN ${label}-----\n${raw.replace(/\s/g,'').match(/.{1,64}/g)?.join('\n')??''}\n-----END ${label}-----`;}
export function normalizeAlipayPrivateKey(raw:string) {
  try {
    let key;try{key=createPrivateKey(pem(raw,'PRIVATE KEY'));}catch{key=createPrivateKey(pem(raw,'RSA PRIVATE KEY'));}
    if(key.asymmetricKeyType!=='rsa'||(key.asymmetricKeyDetails?.modulusLength??0)<2048)throw new Error();
    return key.export({type:'pkcs8',format:'pem'}).toString();
  }catch{throw new Error('alipay_private_key_invalid');}
}
export function createAlipayClient(config:AlipayConfig) {
  if(!/^\d{16}$/.test(config.appId)||!/^2088\d{12}$/.test(config.sellerId)||!['live','sandbox'].includes(config.mode))throw new Error('alipay_config_invalid');
  let publicKey:string;
  try {const k=createPublicKey(pem(config.publicKey,'PUBLIC KEY'));if(k.asymmetricKeyType!=='rsa'||(k.asymmetricKeyDetails?.modulusLength??0)<2048)throw new Error();publicKey=k.export({type:'spki',format:'pem'}).toString();}catch{throw new Error('alipay_public_key_invalid');}
  return new AlipaySdk({appId:config.appId,privateKey:normalizeAlipayPrivateKey(config.privateKey),alipayPublicKey:publicKey,keyType:'PKCS8',signType:'RSA2',camelcase:false,gateway:alipayGateways[config.mode],timeout:10000});
}
export function alipayConfigFromEnv():AlipayConfig {
  const mode=process.env.PAYMENT_MODE;
  if(mode!=='live'&&mode!=='sandbox')throw new Error('alipay_mode_required');
  const get=(name:string)=>secretValue(name)??'';
  return {appId:get('ALIPAY_APP_ID'),sellerId:get('ALIPAY_SELLER_ID'),privateKey:get('ALIPAY_PRIVATE_KEY'),publicKey:get('ALIPAY_PUBLIC_KEY'),mode,notifyUrl:get('ALIPAY_NOTIFY_URL'),returnUrl:get('ALIPAY_RETURN_URL')};
}
export function alipayMinorAmount(value:string):number {
  if(!/^(0|[1-9]\d{0,10})(\.\d{1,2})?$/.test(value))throw new Error('alipay_amount_invalid');
  const [whole,fraction='']=value.split('.');const amount=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  if(!Number.isSafeInteger(amount)||amount<=0)throw new Error('alipay_amount_invalid');return amount;
}
export function alipayDecimalAmount(minor:number):string {
  if(!Number.isSafeInteger(minor)||minor<=0||minor>9999999999999)throw new Error('alipay_amount_invalid');
  return `${Math.floor(minor/100)}.${String(minor%100).padStart(2,'0')}`;
}
function fixedUrl(value:string,expected:string) {if(value!==expected)throw new Error('alipay_callback_url_invalid');return value;}
/** Trusted persisted order only. Never pass client-supplied price or return URLs. Does not call the gateway. */
export function buildAlipayCheckout(config:AlipayConfig,order:{orderNumber:string;amountMinor:number;currency:string;subject:string},device:'desktop'|'mobile') {
  if(process.env.PAYMENT_PROVIDER!=='alipay'||process.env.PAYMENT_LIVE_ENABLED!=='true')throw new Error('payment_provider_disabled');
  if(!['desktop','mobile'].includes(device)||!/^RN[A-Z0-9]{8,62}$/.test(order.orderNumber)||order.currency!=='CNY'||!order.subject||order.subject.length>128)throw new Error('alipay_order_invalid');
  const client=createAlipayClient(config);
  return client.pageExecute(device==='desktop'?'alipay.trade.page.pay':'alipay.trade.wap.pay','GET',{
    notifyUrl:fixedUrl(config.notifyUrl,'https://api.replynest.cn/webhooks/alipay'),
    returnUrl:fixedUrl(config.returnUrl,'https://console.replynest.cn/billing'),
    bizContent:{out_trade_no:order.orderNumber,total_amount:alipayDecimalAmount(order.amountMinor),subject:order.subject,seller_id:config.sellerId,product_code:device==='desktop'?'FAST_INSTANT_TRADE_PAY':'QUICK_WAP_WAY',timeout_express:'15m'}
  });
}
export function parseAlipayNotification(body:Buffer):Record<string,string> {
  if(body.length>65536)throw new Error('alipay_notification_invalid');
  const values:Record<string,string>=Object.create(null);
  for(const [key,value] of new URLSearchParams(body.toString('utf8'))) {
    if(!/^[a-z][a-z0-9_]{0,63}$/.test(key)||Object.hasOwn(values,key))throw new Error('alipay_notification_invalid');
    values[key]=value;
  }
  return values;
}
export type AlipayVerifiedPayment={orderNumber:string;tradeNumber:string;amountMinor:number;paidAt:string;eventId:string};
/** Verify exact form-decoded values once, then bind app and recipient before any DB lookup. */
export function verifyAlipayPayment(config:AlipayConfig,body:Buffer):AlipayVerifiedPayment|null {
  const values=parseAlipayNotification(body);
  if(values.sign_type!=='RSA2'||!values.sign||!createAlipayClient(config).checkNotifySignV2(values))throw new Error('alipay_signature_invalid');
  if(values.app_id!==config.appId||values.seller_id!==config.sellerId)throw new Error('alipay_recipient_mismatch');
  if(!['TRADE_SUCCESS','TRADE_FINISHED'].includes(values.trade_status))return null;
  if(!/^RN[A-Z0-9]{8,62}$/.test(values.out_trade_no??'')||!/^\d{10,64}$/.test(values.trade_no??''))throw new Error('alipay_order_invalid');
  const date=values.gmt_payment??'';
  if(!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(date))throw new Error('alipay_paid_time_invalid');
  const iso=`${date.replace(' ','T')}+08:00`,paidAt=new Date(iso);
  if(!Number.isFinite(paidAt.getTime())||new Date(paidAt.getTime()+8*3600000).toISOString().slice(0,19)!==date.replace(' ','T'))throw new Error('alipay_paid_time_invalid');
  return {orderNumber:values.out_trade_no,tradeNumber:values.trade_no,amountMinor:alipayMinorAmount(values.total_amount??''),paidAt:paidAt.toISOString(),eventId:`alipay:paid:${values.trade_no}`};
}
