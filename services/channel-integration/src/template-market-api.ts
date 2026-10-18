import type {IncomingMessage,ServerResponse} from 'node:http';
import {readBody,sendJson} from './shared.js';
import * as market from './template-market.js';
import {TemplateMarketError} from './template-market-core.js';
import {EntitlementLimitError} from './subscriptions.js';
type Auth={tenant_id:string;platform_user_id:string|null;role:string;auth_kind:string;impersonation_id?:string|null;session_scope?:string|null};
export async function handleTemplateMarketApi(req:IncomingMessage,res:ServerResponse,url:URL,auth:Auth,id:string) {
 if(!url.pathname.startsWith('/api/v1/template-market'))return false;
 const reply=(status:number,body:unknown)=>sendJson(res,status,{request_id:id,...body as object});
 if(auth.auth_kind!=='console_session'||auth.role!=='tenant_admin'||!auth.platform_user_id||auth.impersonation_id||auth.session_scope==='copilot_embed'){reply(403,{error:{code:'market_forbidden'}});return true;}
 try {
  const path=url.pathname.slice('/api/v1/template-market'.length),tenant=auth.tenant_id,user=auth.platform_user_id;let data:unknown;
  if(req.method==='GET'&&path==='')data=await market.browseMarketTemplates({kind:url.searchParams.get('kind')||undefined,category:url.searchParams.get('category')||undefined,cursor:url.searchParams.has('cursor')?JSON.parse(url.searchParams.get('cursor')!):undefined});
  else if(req.method==='GET'&&path==='/mine')data=await market.marketWorkspace(tenant,user,url.searchParams.get('view')??'submitted',Number(url.searchParams.get('offset')??0),url.searchParams.get('kind')||undefined);
  else if(req.method==='GET'&&path==='/earnings')data=await market.marketEarnings(tenant,user);
  else if(req.method==='GET'&&path==='/payee')data=await market.marketPayees(user,tenant);
  else if(req.method==='GET'&&path==='/payouts')data=await market.marketPayouts(user,tenant,Number(url.searchParams.get('offset')??0));
  else if(req.method==='GET'&&/^\/content\/[0-9a-f-]{36}$/i.test(path))data=await market.acquiredMarketContent(tenant,user,path.split('/')[2]);
  else if(req.method==='POST') {
   const body=JSON.parse((await readBody(req)).toString());if(!body||typeof body!=='object'||Array.isArray(body))throw new TemplateMarketError('invalid_market_request');
   if(path==='/submit')data=await market.submitMarketTemplate(tenant,user,body,id);
   else if(path==='/payee')data=await market.submitMarketPayee(tenant,user,body,id);
   else if(path==='/payout')throw new TemplateMarketError('market_payout_not_enabled');
   else if(path==='/acquire') {
    // Paid purchases remain closed until the independent seller-payout workflow is complete.
    if(body.expected_price_minor!==0)throw new TemplateMarketError('market_paid_not_enabled');
    data=await market.buyMarketTemplate(tenant,user,body,id);
   }else if(path==='/import'&&typeof body.order_id==='string'&&/^[0-9a-f-]{36}$/i.test(body.order_id))data=await market.importMarketReplies(tenant,user,body.order_id,id);
   else if(path==='/refund'&&typeof body.order_id==='string'&&/^[0-9a-f-]{36}$/i.test(body.order_id))data=await market.requestMarketRefund(tenant,user,body.order_id,String(body.reason??''),id);
   else {reply(404,{error:{code:'not_found'}});return true;}
  }else {reply(404,{error:{code:'not_found'}});return true;}
  reply(200,{data});
 }catch(e){reply(e instanceof TemplateMarketError||e instanceof EntitlementLimitError?409:e instanceof SyntaxError?400:503,{error:{code:e instanceof EntitlementLimitError?'knowledge_capacity_exceeded':e instanceof TemplateMarketError?e.message:'market_unavailable'}});}
 return true;
}
