import type { IncomingMessage, ServerResponse } from "node:http";
import { ledgerBalances, listLedgerTransactions } from "./ledger.js";
import { sendJson, readBody } from "./shared.js";
import { checkoutEnabled } from "./plan-checkout.js";
import { paymentDiagnostics } from "./payment-provider.js";
import { listPaymentOrders, paymentOperationsOverview } from "./payment-operations.js";
import { hasPermission } from "./access-control.js";
import { catalog, usageOverview } from "./subscriptions.js";
import { walletOverview, walletTopup, walletPurchase, walletRequest } from './wallet.js';
import {quoteWalletPlanChange,executeWalletPlanChange} from './plan-changes.js';
import { WalletError } from './wallet-core.js';
import { aiPointsOverview } from './ai-points.js';
import {aiPackRecords,purchaseAiPack,requestAiPackRefund} from './ai-point-packs.js';

type Auth = { tenant_id: string; role: "tenant_admin" | "supervisor" | "agent"; actor_id?: string; auth_kind?: string; session_scope?: string|null; impersonation_id?: string|null };

export async function handleBillingApi(request: IncomingMessage, response: ServerResponse, url: URL, auth: Auth, requestId: string) {
  if (!url.pathname.startsWith("/api/v1/billing")) return false;
  if (!hasPermission({ domain: "tenant", role: auth.role }, "tenant.billing.read")) {
    sendJson(response, 403, { request_id: requestId, error: { code: "forbidden", message: "当前角色不能查看企业账务" } }); return true;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/billing/payment-provider") {
    sendJson(response, 200, { request_id: requestId, data: paymentDiagnostics() });
    return true;
  }
  if(url.pathname==='/api/v1/billing/wallet'&&request.method==='GET'){
    const view=url.searchParams.get('view')??'full';
    if(!['full','summary','purchases','requests'].includes(view)){sendJson(response,400,{error:{code:'invalid_request'}});return true;}
    try{sendJson(response,200,{data:await walletOverview(auth.tenant_id,view as 'full'|'summary'|'purchases'|'requests')});}catch{sendJson(response,503,{error:{code:'wallet_unavailable',message:'余额暂不可用，请稍后重试'}});}return true;
  }
  if(url.pathname==='/api/v1/billing/ai-points'&&request.method==='GET'){
    const view=url.searchParams.get('view')??'full';
    if(!['full','summary'].includes(view)){sendJson(response,400,{error:{code:'invalid_request'}});return true;}
    try{sendJson(response,200,{data:{...await aiPointsOverview(auth.tenant_id),...(view==='summary'?{purchases:[],refunds:[]}:await aiPackRecords(auth.tenant_id))}});}catch{sendJson(response,503,{error:{code:'ai_points_unavailable',message:'AI 点数暂不可用，请稍后重试'}});}return true;
  }
  if(request.method==='POST'&&['/api/v1/billing/ai-points/purchase','/api/v1/billing/ai-points/refund'].includes(url.pathname)){
    if(auth.role!=='tenant_admin'||auth.auth_kind!=='console_session'||auth.session_scope!=='console'||auth.impersonation_id||!auth.actor_id){sendJson(response,403,{error:{code:'forbidden'}});return true;}
    try{const buffer=await readBody(request);if(buffer.length>2048)throw new WalletError('invalid_request',400);const input=JSON.parse(buffer.toString('utf8'));
      sendJson(response,200,{data:await (url.pathname.endsWith('/purchase')?purchaseAiPack:requestAiPackRefund)(auth.tenant_id,auth.actor_id,input,requestId)});
    }catch(e){sendJson(response,e instanceof WalletError?e.status:e instanceof SyntaxError?400:503,{error:{code:e instanceof WalletError?e.code:'ai_points_unavailable'}});}return true;
  }
  const walletAction=url.pathname.match(/^\/api\/v1\/billing\/wallet\/(topup|purchase|requests|plan-quote|plan-change)$/);
  if(walletAction&&request.method==='POST'){
    if(auth.role!=='tenant_admin'||auth.auth_kind!=='console_session'||auth.session_scope!=='console'||auth.impersonation_id||!auth.actor_id){sendJson(response,403,{error:{code:'forbidden',message:'仅企业管理员本人可操作资金'}});return true;}
    try{const body=await readBody(request);if(body.length>2048)throw new WalletError('invalid_request',400);const input=JSON.parse(body.toString('utf8'));
      const fn=walletAction[1]==='topup'?walletTopup:walletAction[1]==='purchase'?walletPurchase:walletAction[1]==='plan-quote'?quoteWalletPlanChange:walletAction[1]==='plan-change'?executeWalletPlanChange:walletRequest;
      sendJson(response,200,{data:await fn(auth.tenant_id,auth.actor_id,input,requestId)});
    }catch(e){sendJson(response,e instanceof WalletError?e.status:e instanceof SyntaxError?400:503,{error:{code:e instanceof WalletError?e.code:'wallet_unavailable'}});}return true;
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/billing/checkout') {
    sendJson(response,200,{request_id:requestId,data:{enabled:checkoutEnabled()}}); return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/v1/billing/checkout') {
    if(auth.role!=='tenant_admin'||auth.auth_kind!=='console_session'||auth.session_scope!=='console'||auth.impersonation_id||!auth.actor_id){sendJson(response,403,{error:{code:'forbidden'}});return true;}
    sendJson(response,409,{error:{code:'wallet_checkout_required',message:'请刷新套餐页面，充值后使用余额购买套餐'}});return true;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/billing/plans") {
    sendJson(response, 200, { request_id: requestId, data: await catalog() }); return true;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/billing/subscription") {
    sendJson(response, 200, { request_id: requestId, data: await usageOverview(auth.tenant_id) }); return true;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/billing/balances") {
    const currency = String(url.searchParams.get("currency") ?? "CNY").toUpperCase();
    try { sendJson(response, 200, { request_id: requestId, data: await ledgerBalances(auth.tenant_id, currency) }); }
    catch { sendJson(response, 400, { request_id: requestId, error: { code: "invalid_currency", message: "币种格式不正确" } }); }
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/billing/ledger") {
    const rawLimit = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 50;
    const rawOffset=Number(url.searchParams.get('offset')??0);
    const offset=Number.isSafeInteger(rawOffset)?Math.min(100000,Math.max(0,rawOffset)):0;
    const rows=await listLedgerTransactions(auth.tenant_id,limit+1,offset);
    sendJson(response, 200, { request_id: requestId, data: rows.slice(0,limit), pagination: { limit,offset,has_next:rows.length>limit } }); return true;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/billing/payment-orders") {
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
    const rawLimit = Number(url.searchParams.get("limit") ?? 20);
    const limit = Number.isInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 20;
    try {
      const result = await listPaymentOrders(auth.tenant_id, { page, limit, status: url.searchParams.get("status") ?? undefined });
      sendJson(response, 200, { request_id: requestId, ...result });
    } catch {
      sendJson(response, 400, { request_id: requestId, error: { code: "invalid_status", message: "支付订单状态不正确" } });
    }
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/billing/payment-overview") {
    const days = Number(url.searchParams.get("window_days") ?? 30);
    sendJson(response, 200, { request_id: requestId, data: await paymentOperationsOverview(auth.tenant_id, days) });
    return true;
  }
  sendJson(response, 404, { request_id: requestId, error: { code: "not_found", message: "账务接口不存在" } }); return true;
}
