import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
export type SecurityMetadata={client_ip:string|null;user_agent:string|null;ip_source:'verified_proxy'|'unavailable'};
export function cleanAgent(value:unknown){return typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,'').slice(0,512):null;}
export function metadataBinding(method:string,path:string,authorization:string,payload:string){return `${method}\n${path}\n${createHash('sha256').update(authorization).digest('hex')}\n${payload}`;}
export function verifiedMetadata(headers:Record<string,string|string[]|undefined>,method:string,path:string,key:string|undefined,now=Date.now()):SecurityMetadata{
 const empty:SecurityMetadata={client_ip:null,user_agent:null,ip_source:'unavailable'},raw=headers['x-replynest-activity'],sig=headers['x-replynest-activity-signature'];
 if(!key||key.length<32||typeof raw!=='string'||raw.length>1800||typeof sig!=='string'||!/^[a-f0-9]{64}$/.test(sig))return empty;
 const actual=createHmac('sha256',key).update(metadataBinding(method,path,typeof headers.authorization==='string'?headers.authorization:'',raw)).digest();
 if(!timingSafeEqual(actual,Buffer.from(sig,'hex')))return empty;
 try{const v=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));if(v.v!==1||!Number.isSafeInteger(v.ts)||Math.abs(now-v.ts)>60000||typeof v.nonce!=='string'||!/^[a-f0-9-]{36}$/.test(v.nonce))return empty;
  return{client_ip:typeof v.ip==='string'&&isIP(v.ip)?v.ip:null,user_agent:cleanAgent(v.ua),ip_source:typeof v.ip==='string'&&isIP(v.ip)?'verified_proxy':'unavailable'};
 }catch{return empty}
}
// Never retain query strings, tokens or arbitrary user-controlled path segments.
const words=new Set('api v1 auth login logout select-workspace reset-password accept-invitation customers conversations messages resolve reopen assign labels recommendations actions automation automatic-reception grants personalization wechat files file-transfers content download attachments knowledge ai documents draft index quick-replies billing wallet checkout recharge refund-request withdraw points packs purchase refunds subscriptions growth trial claim referrals invite-code payouts open-apps revoke keys channels shared-wechat credentials callback-credentials synthetic-validate members invitations message-campaigns approve schedule pause resume cancel retry mass-batches review execute extensions records automation-rules plan notifications browser-push destinations registration'.split(' '));
export function safeActivityRoute(path:string){return path.split('/').slice(0,12).map(s=>s===''||words.has(s)?s:':id').join('/').slice(0,320);}
export function shouldRecordOperation(method:string,path:string){return ['POST','PUT','PATCH','DELETE'].includes(method)||method==='GET'&&/(\/content|\/download)$/.test(path);}
export function securityFilters(params:URLSearchParams){
 const category=params.get('category')??'all',result=params.get('result')??'all',q=(params.get('q')??'').trim(),cursor=params.get('before')??'';
 if(!['all','login','operation'].includes(category)||!['all','success','failure'].includes(result)||q.length>100)throw Error('invalid_security_filter');
 if(cursor.length>512)throw Error('invalid_security_cursor');
 let before:{at:string;id:string}|null=null;if(cursor){try{before=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(!before||typeof before.at!=='string'||!Number.isFinite(Date.parse(before.at))||!/^\d{4}-\d{2}-\d{2}T/.test(before.at)||!/^[-a-f0-9]{36}$/i.test(before.id))throw Error();}catch{throw Error('invalid_security_cursor')}}
 return{category,result,q,before};
}
