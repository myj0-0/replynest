"use client";
import { useEffect,useState } from "react";
type Scene={digest:string;expires_at:string|null;revoked:boolean};
type Overview={available:boolean;requested:boolean;enabled:boolean;entry_ready:boolean;scenes:Scene[];profile?:{introduction:string;website:string}};
type Qr={digest:string;expires_at:string|null;image_url:string};
export function SharedWechatSetup({en,admin}:{en:boolean;admin:boolean}) {
  const [introduction,setIntroduction]=useState(''),[website,setWebsite]=useState('');
  const [state,setState]=useState<Overview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(""),[qr,setQr]=useState<Qr|null>(null),[now,setNow]=useState(Date.now());
  async function refresh() {
    const response=await fetch("/api/channels/shared-wechat",{cache:"no-store"});
    if(!response.ok)throw new Error("load");const body=await response.json();setState(body.data);setIntroduction(body.data.profile?.introduction??'');setWebsite(body.data.profile?.website??'');
  }
  useEffect(()=>{if(admin)void refresh().catch(()=>setError(en?"Could not load channel settings. Refresh to retry.":"读取渠道配置失败，请刷新重试。"));},[admin,en]);
  useEffect(()=>{if(!qr)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[qr]);
  async function act(action:string,digest?:string,permanent=false) {
    if(busy)return;
    if(action==="disable" && !window.confirm(en?"Disable this channel and revoke all its QR entries?":"停用共享渠道并撤销全部二维码入口？"))return;
    setBusy(true);setError("");
    try {
      const response=await fetch("/api/channels/shared-wechat",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action,...(digest?{digest}:{}),...(action==="create_qr"?{permanent}:{}),...(action==='save_profile'?{introduction,website}:{})})});
      const body=await response.json();
      if(!response.ok) {
        const code=body.error?.code;
        throw new Error(code==="entry_not_ready"?(en?"The scan entry is not ready yet.":"扫码入口尚未完成验收，暂不可生成二维码。"):
          ["qr_rate_limited","qr_limit_reached"].includes(code)?(en?"QR limit reached. Wait before creating another.":"二维码生成频率或数量已达上限，请稍后再试。"):
          (en?"Operation not confirmed. Refresh before retrying.":"操作结果未确认，请先刷新核实再重试。"));
      }
      if(action==="create_qr"){setQr(body.data);setNow(Date.now());}
      if(action==="disable" || (action==="revoke_qr" && qr?.digest===digest))setQr(null);
      await refresh();
    } catch(e){setError(e instanceof Error?e.message:"Error");}finally{setBusy(false);}
  }
  const visibleQr=qr && state?.entry_ready && (qr.expires_at===null || now<Date.parse(qr.expires_at)) && state.scenes.some(s=>s.digest===qr.digest && !s.revoked);
  const button="rounded-lg border px-3 py-2 text-sm disabled:opacity-50";
  return <section id="shared-wechat" className="mt-6 rounded-2xl border border-[var(--border-subtle)] bg-white p-5 shadow-sm">
    <h2 className="font-semibold">{en?"Shared WeChat official account · Preview":"官方共享公众号 · 体验渠道"}</h2>
    <p className="mt-2 text-sm leading-6 text-slate-500">{en?"Try WeChat support through ReplyNest’s official account without your own certified account. Shared quotas and availability apply; keep website chat as a backup.":"通过「答巢AI客服助手」体验微信客服，无需自备认证公众号。此渠道用于过渡体验，共享额度及可用性，请保留网站客服作为备用入口。"}</p>
    {!admin?<p className="mt-3 text-sm">{en?"Only workspace admins can manage this channel.":"请由企业管理员管理此渠道。"}</p>:!state?<p className="mt-3 text-sm">{error?"":en?"Loading…":"正在读取…"}</p>:<div className="mt-4 space-y-3">
      <p className="text-sm">{!state.available?(en?"Preview applications are not open yet.":"体验申请暂未开放。") : state.entry_ready?(en?"Scan entry available":"扫码入口可用"):state.enabled?(en?"Provisioned · scan entry awaiting verification":"已开通 · 扫码入口待验收"):state.requested?(en?"Application recorded · awaiting platform activation":"已记录申请 · 等待平台开通"):en?"Not requested":"尚未申请"}</p>
      {!state.entry_ready && <p className="text-xs leading-5 text-amber-800">{en?"Live scanning is unavailable until the public callback and message delivery have been verified. No non-working QR code will be issued.":"公网回调与消息收发完成验收前，不提供实际扫码入口。提交申请不会自动开启渠道或 AI 回复。"}</p>}
      <div className="space-y-2 rounded-xl border p-3"><label className="block text-sm">{en?'Merchant introduction':'商家简介 · 扫码后自动欢迎回复'}<textarea value={introduction} onChange={e=>setIntroduction(e.target.value)} maxLength={300} rows={3} className="mt-1 w-full rounded-lg border p-2"/></label><label className="block text-sm">{en?'Website (HTTPS)':'商家网址（HTTPS，可选）'}<input type="url" value={website} onChange={e=>setWebsite(e.target.value)} maxLength={400} placeholder="https://" className="mt-1 w-full rounded-lg border p-2"/></label><p className="text-xs text-slate-500">{en?'Public information shown to customers. Do not include private data.':'以上内容将向客户公开展示，请勿填写内部信息。'}</p><button className={button} disabled={busy} onClick={()=>void act('save_profile')}>{en?'Save introduction':'保存商家介绍'}</button></div>
      <div className="flex flex-wrap gap-2">
        {state.available && !state.enabled && !state.requested && <button className={button} disabled={busy} onClick={()=>void act("request")}>{en?"Request preview access":"申请体验"}</button>}
        {state.entry_ready && <button className={button} disabled={busy} onClick={()=>void act("create_qr")}>{en?"Create temporary QR":"生成临时二维码"}</button>}
        {state.entry_ready && <button className={button} disabled={busy} onClick={()=>void act("create_qr",undefined,true)}>{en?"Create permanent merchant QR":"生成长期商家二维码"}</button>}
        <p className="w-full text-xs text-slate-500">{en?"Permanent QR codes are public merchant entries, not visitor-binding credentials. Revoking an entry stops new scans; it does not remove existing conversations.":"长期码用于网站或海报上的商家公开入口，不是用户绑定凭据。撤销后停止新扫码进入，不删除已有会话。"}</p>
        {state.enabled && <button className={button} disabled={busy} onClick={()=>void act("disable")}>{en?"Disable channel":"停用渠道"}</button>}
        <button className={button} disabled={busy} onClick={()=>{setError("");void refresh().catch(()=>setError(en?"Refresh failed.":"刷新失败。"));}}>{en?"Refresh":"刷新"}</button>
      </div>
      {visibleQr && <div className="rounded-xl border p-3"><img src={qr.image_url} alt={en?"Merchant entry QR code":"商家专属入口二维码"} referrerPolicy="no-referrer" className="h-48 w-48 max-w-full"/><p className="mt-2 text-xs">{qr.expires_at===null?(en?"Permanent merchant entry · until revoked":"长期商家入口 · 撤销前有效"):new Date(qr.expires_at).toLocaleString(en?"en-US":"zh-CN")}</p><a href={qr.image_url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="mt-2 inline-block text-sm text-blue-700">{en?"Open image to save":"打开二维码图片并保存"}</a><p className="mt-1 text-xs text-slate-500">{en?"This image is shown only after creation. Refreshing the page clears the image, not the entry.":"二维码图片仅在生成后展示；刷新页面会清除图片，不会撤销入口。"}</p></div>}
      {!!state.scenes.length && <ul className="space-y-2">{state.scenes.map(scene=><li key={scene.digest} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 p-3 text-xs"><span>{scene.expires_at===null?(en?"Permanent merchant entry":"长期商家入口"):new Date(scene.expires_at).toLocaleString(en?"en-US":"zh-CN")} · {scene.revoked?(en?"Revoked":"已撤销"):(en?"Active":"有效")}</span>{!scene.revoked && <button className={button} disabled={busy} onClick={()=>void act("revoke_qr",scene.digest)}>{en?"Revoke":"撤销"}</button>}</li>)}</ul>}
    </div>}
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
  </section>;
}
