import { createHash,randomBytes } from "node:crypto";
import type { IncomingMessage,ServerResponse } from "node:http";
import type { Pool } from "pg";
import type { WeChatConfig } from "./wechat-official.js";
import { readBody } from "./shared.js";

const origin="https://replynest.cn", path="/wechat/merchants";
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
const token=()=>randomBytes(24).toString("hex");
let startWindow=0,startCount=0;
export const escapePortalHtml=(s:string)=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
export function portalAuthorizeUrl(appId:string,state:string,scope='snsapi_userinfo') {
  const u=new URL("https://open.weixin.qq.com/connect/oauth2/authorize");
  u.search=new URLSearchParams({appid:appId,redirect_uri:`${origin}${path}/callback`,response_type:"code",scope,state}).toString();u.hash="wechat_redirect";return u.toString();
}
export function sharedWechatPortalSchemaSql(): string {
  return `CREATE TABLE IF NOT EXISTS shared_wechat_portal_states (
    digest TEXT PRIMARY KEY,browser_digest TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),expires_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS shared_wechat_portal_sessions (
    digest TEXT PRIMARY KEY,app_id TEXT NOT NULL,open_id TEXT NOT NULL,csrf TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS shared_wechat_authorized_profiles(app_id TEXT NOT NULL,open_id TEXT NOT NULL,nickname TEXT NOT NULL,avatar_url TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL,PRIMARY KEY(app_id,open_id));
    ALTER TABLE shared_wechat_portal_sessions ADD COLUMN IF NOT EXISTS profile_checked BOOLEAN NOT NULL DEFAULT FALSE;`;
}
export async function migrateSharedWechatPortal(db:Pool) {
  await db.query(sharedWechatPortalSchemaSql());
}
export async function clearSharedWechatProfile(db:Pool,appId:string,openId:string) {
  await db.query('DELETE FROM shared_wechat_authorized_profiles WHERE app_id=$1 AND open_id=$2',[appId,openId]);
  await db.query('DELETE FROM shared_wechat_portal_sessions WHERE app_id=$1 AND open_id=$2',[appId,openId]);
}
export function safeWechatAvatar(value:unknown) {
  try {const u=new URL(String(value));return u.protocol==='https:' && /(^|\.)qlogo\.cn$/.test(u.hostname)&&!u.username&&!u.password?u.href:'';}catch{return '';}
}
function cookie(req:IncomingMessage,name:string) {
  const value=(req.headers.cookie??"").split(";").map(x=>x.trim()).find(x=>x.startsWith(`${name}=`))?.slice(name.length+1)??"";
  return /^[a-f0-9]{48}$/.test(value)?value:"";
}
function setCookie(name:string,value:string,seconds:number) {return `${name}=${value}; Path=${path}; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;}
function html(res:ServerResponse,title:string,body:string,status=200) {
  res.writeHead(status,{"content-type":"text/html; charset=utf-8","cache-control":"private, no-store","referrer-policy":"no-referrer","x-content-type-options":"nosniff","x-robots-tag":"noindex, nofollow","content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; form-action https://replynest.cn; base-uri 'none'; frame-ancestors 'none'"});
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapePortalHtml(title)} · 答巢</title><style>body{margin:0;background:#f5f8fc;color:#172433;font:16px/1.6 system-ui}main{max-width:560px;margin:32px auto;padding:24px}article{background:white;border:1px solid #dde5ef;border-radius:16px;padding:20px;margin:16px 0}button,.button{display:inline-block;background:#198bfa;color:white;border:0;border-radius:10px;padding:10px 18px;font:inherit;text-decoration:none;cursor:pointer}p{overflow-wrap:anywhere}.muted{color:#64748b;font-size:14px}</style><main><p class="muted">答巢 ReplyNest · 微信共享客服</p><h1>${escapePortalHtml(title)}</h1>${body}</main></html>`);
}
function redirect(res:ServerResponse,url:string,cookies?:string[]) {res.writeHead(303,{location:url,"cache-control":"private, no-store","referrer-policy":"no-referrer",...(cookies?{"set-cookie":cookies}:{})});res.end();}

/** Public visitor identity is independent of console membership. No tenant ID or OpenID from the browser is trusted. */
export async function handleSharedWechatPortal(req:IncomingMessage,res:ServerResponse,url:URL,db:Pool,config:WeChatConfig) {
  if(!url.pathname.startsWith("/public/shared-wechat-portal"))return false;
  const action=url.pathname.slice("/public/shared-wechat-portal".length)||"/";
  try {
    if(req.method==="GET" && action==="/start") {
      if(Date.now()-startWindow>60000){startWindow=Date.now();startCount=0;}
      if(++startCount>60){html(res,"请稍后重试","授权请求较多，请一分钟后再试。",429);return true;}
      const state=token(),browser=token();
      await db.query("DELETE FROM shared_wechat_portal_states WHERE expires_at<NOW()");
      await db.query("DELETE FROM shared_wechat_portal_sessions WHERE expires_at<NOW()");
      await db.query("DELETE FROM shared_wechat_authorized_profiles WHERE expires_at<NOW()");
      await db.query(`INSERT INTO shared_wechat_portal_states(digest,browser_digest,expires_at) VALUES($1,$2,NOW()+INTERVAL '5 minutes')`,[hash(state),hash(browser)]);
      redirect(res,portalAuthorizeUrl(config.appId,state,url.searchParams.get('basic')==='1'?'snsapi_base':'snsapi_userinfo'),[setCookie("rn_wechat_oauth",browser,300)]);return true;
    }
    if(req.method==="GET" && action==="/callback") {
      const state=url.searchParams.get("state")??"",code=url.searchParams.get("code")??"",browser=cookie(req,"rn_wechat_oauth");
      if(!/^[a-f0-9]{48}$/.test(state)||!browser||!code||code.length>512)throw new Error("invalid_oauth");
      const used=await db.query("DELETE FROM shared_wechat_portal_states WHERE digest=$1 AND browser_digest=$2 AND expires_at>NOW() RETURNING digest",[hash(state),hash(browser)]);
      if(!used.rows[0])throw new Error("expired_oauth");
      const endpoint=new URL("https://api.weixin.qq.com/sns/oauth2/access_token");
      endpoint.search=new URLSearchParams({appid:config.appId,secret:config.appSecret,code,grant_type:"authorization_code"}).toString();
      const response=await fetch(endpoint,{redirect:"error",signal:AbortSignal.timeout(8000)});
      const data=await response.json() as Record<string,unknown>;
      if(!response.ok||data.errcode||typeof data.openid!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(data.openid)||data.is_snapshotuser===1)throw new Error("oauth_failed");
      // Use the short-lived token only in this request; never persist it or return it to the browser.
      if(typeof data.scope==='string' && data.scope.split(',').includes('snsapi_userinfo') && typeof data.access_token==='string') {
        const infoUrl=new URL('https://api.weixin.qq.com/sns/userinfo');infoUrl.search=new URLSearchParams({access_token:data.access_token,openid:data.openid,lang:'zh_CN'}).toString();
        const infoResponse=await fetch(infoUrl,{redirect:'error',signal:AbortSignal.timeout(5000)});
        const info=await infoResponse.json() as Record<string,unknown>;
        if(infoResponse.ok && !info.errcode && info.openid===data.openid && typeof info.nickname==='string') {
          await db.query(`INSERT INTO shared_wechat_authorized_profiles(app_id,open_id,nickname,avatar_url,expires_at) VALUES($1,$2,$3,$4,NOW()+INTERVAL '30 days') ON CONFLICT(app_id,open_id) DO UPDATE SET nickname=$3,avatar_url=$4,expires_at=EXCLUDED.expires_at`,[config.appId,data.openid,info.nickname.slice(0,100),safeWechatAvatar(info.headimgurl)]);
        }
      }
      const session=token();
      await db.query(`INSERT INTO shared_wechat_portal_sessions(digest,app_id,open_id,csrf,expires_at,profile_checked) VALUES($1,$2,$3,$4,NOW()+INTERVAL '1 day',TRUE)`,[hash(session),config.appId,data.openid,token()]);
      redirect(res,`${origin}${path}`,[setCookie("rn_wechat_session",session,86400),setCookie("rn_wechat_oauth","",0)]);return true;
    }
    const sessionToken=cookie(req,"rn_wechat_session");
    const session=sessionToken?(await db.query("SELECT app_id,open_id,csrf,profile_checked FROM shared_wechat_portal_sessions WHERE digest=$1 AND app_id=$2 AND expires_at>NOW()",[hash(sessionToken),config.appId])).rows[0]:undefined;
    if(session && !session.profile_checked && req.method==='GET'){redirect(res,`${origin}${path}/start`);return true;}
    if(!session) {
      if(/MicroMessenger/i.test(req.headers['user-agent']??'')) {redirect(res,`${origin}${path}/start`);return true;}
      html(res,"查看咨询商家",`<p>请在微信中打开。授权昵称和头像后，将向您已关联商家的客服展示，便于识别您的咨询；不读取通讯录或手机号。</p><a class="button" href="${path}/start">授权并继续</a><p><a href="${path}/start?basic=1">暂不提供昵称头像，继续咨询</a></p>`);return true;
    }
    if(req.method==="POST" && action==="/select") {
      if(req.headers.origin!==origin)throw new Error("invalid_origin");
      const bytes=await readBody(req);if(bytes.length>4096)throw new Error("invalid_form");
      const form=new URLSearchParams(bytes.toString("utf8"));
      if(form.get("csrf")!==session.csrf)throw new Error("invalid_csrf");
      const tenant=form.get("merchant")??"";
      const client=await db.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`shared-wechat:${session.app_id}:${session.open_id}`]);
        const found=await client.query(`SELECT s.state FROM shared_wechat_routing_states s JOIN shared_wechat_accounts a ON a.app_id=s.app_id AND a.enabled=TRUE
          JOIN shared_wechat_enrollments e ON e.app_id=s.app_id AND e.tenant_id=$3 AND e.enabled=TRUE
          JOIN tenants t ON t.tenant_id=e.tenant_id AND t.status IN ('active','test')
          WHERE s.app_id=$1 AND s.open_id=$2 FOR UPDATE OF s`,[session.app_id,session.open_id,tenant]);
        const state=found.rows[0]?.state;
        if(!state?.associations?.some((x:{tenantId:string})=>x.tenantId===tenant))throw new Error("merchant_not_associated");
        const now=Date.now();state.selected={tenantId:tenant,expiresAt:now+30*60000};delete state.choices;state.version+=1;state.lastTransitionAt=Math.max(now,state.lastTransitionAt+1);
        await client.query("UPDATE shared_wechat_routing_states SET state=$3,updated_at=NOW() WHERE app_id=$1 AND open_id=$2",[session.app_id,session.open_id,state]);
        await client.query("COMMIT");
      } catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
      redirect(res,`${origin}${path}?selected=1`);return true;
    }
    if(req.method!=="GET"||action!=="/"){html(res,"页面不存在","",404);return true;}
    const merchants=await db.query(`SELECT t.tenant_id,t.name,p.introduction,p.website,s.state->'selected' AS selected FROM shared_wechat_routing_states s
      JOIN shared_wechat_accounts a ON a.app_id=s.app_id AND a.enabled=TRUE
      JOIN shared_wechat_enrollments e ON e.app_id=s.app_id AND e.enabled=TRUE
      JOIN tenants t ON t.tenant_id=e.tenant_id AND t.status IN ('active','test')
      LEFT JOIN shared_wechat_merchant_profiles p ON p.tenant_id=t.tenant_id
      WHERE s.app_id=$1 AND s.open_id=$2 AND EXISTS(SELECT 1 FROM jsonb_array_elements(s.state->'associations') x WHERE x->>'tenantId'=t.tenant_id)
      ORDER BY t.name`,[session.app_id,session.open_id]);
    const single=merchants.rows.length===1,selected=url.searchParams.get('selected')==='1';
    const guide=(single||selected)?`<aside style="background:#eaf4ff;border-radius:14px;padding:16px;border:1px solid #99caff"><span style="font-size:42px;line-height:1" aria-hidden="true">↖</span><strong>${selected?'切换完成':'当前咨询商家'}</strong><p>点击微信页面左上角的 × 关闭本页，回到公众号聊天窗口，直接发送您的问题。</p><small>部分手机显示为返回箭头，请返回公众号聊天。</small></aside>`:'';
    html(res,single?'商家详情':'我的咨询商家',`${guide}${merchants.rows.length?merchants.rows.map(m=>`<article><h2>${escapePortalHtml(m.name)}</h2><p style="white-space:pre-wrap">${escapePortalHtml(m.introduction||'欢迎咨询，请返回公众号直接发送您的问题。')}</p>${m.website?`<p><a rel="noreferrer noopener" href="${escapePortalHtml(m.website)}">访问商家网站 ↗</a></p>`:''}<p class="muted">${single||(m.selected?.tenantId===m.tenant_id&&m.selected.expiresAt>Date.now())?'当前咨询中':'已关联商家'}</p>${single?'':`<form method="post" action="${path}/select"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="merchant" value="${escapePortalHtml(m.tenant_id)}"><button>切换至此商家</button></form>`}</article>`).join(''):'<article>尚未关联商家，请先扫描商家提供的答巢公众号二维码。</article>'}<p class="muted">只显示您已关联的商家。授权昵称头像仅用于关联商家识别咨询；可在微信授权管理中撤回。</p><a href="${path}/start">更新昵称头像授权</a>`);
  } catch {html(res,"暂时无法完成操作",`<p>授权可能已取消、过期或商家已停用。请重试，或不提供昵称头像继续咨询。</p><a class="button" href="${path}/start">重新验证</a><p><a href="${path}/start?basic=1">暂不提供昵称头像，继续咨询</a></p>`,400);}
  return true;
}
