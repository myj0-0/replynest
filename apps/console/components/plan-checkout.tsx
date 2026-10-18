'use client';
import { useEffect, useRef, useState } from 'react';
import type { PlanCatalogItem } from '../lib/billing';
const formatMinor=(value:string,currency:string)=>new Intl.NumberFormat('zh-CN',{style:'currency',currency}).format(Number(value)/100);

export function PlanCheckout({plans,canPurchase,en}:{plans:PlanCatalogItem[];canPurchase:boolean;en:boolean}) {
  const [enabled,setEnabled]=useState(false),[selected,setSelected]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [period,setPeriod]=useState('monthly'),[accepted,setAccepted]=useState(false);
  const attempt=useRef<{plan:string;key:string}|null>(null);
  useEffect(()=>{const controller=new AbortController();fetch('/api/billing/checkout',{cache:'no-store',signal:controller.signal}).then(r=>r.json()).then(r=>setEnabled(r.data?.enabled===true)).catch(()=>{});return()=>controller.abort();},[]);
  const eligible=plans.filter(p=>['starter','professional'].includes(p.plan_code)&&p.billing_period==='monthly'&&Number(p.price_minor)>0);
  const plan=eligible.find(p=>p.plan_version_id===selected);
  async function pay(){
    if(!plan||busy||!accepted)return;
    setBusy(true);setError('');
    if(attempt.current?.plan!==selected+period)attempt.current={plan:selected+period,key:crypto.randomUUID()};
    try {
      const response=await fetch('/api/billing/checkout',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({plan_version_id:selected,billing_period:period,idempotency_key:attempt.current!.key,device:/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)?'mobile':'desktop'})});
      const body=await response.json();
      if(!response.ok){
        const code=body.error?.code;
        if(code==='checkout_expired')attempt.current=null;
        const messages:Record<string,string>={checkout_disabled:'收款尚未开放，请稍后再试。',checkout_expired:'该订单已结束或支付入口已过期，请先刷新订单列表确认支付状态。',checkout_in_progress:'已有待付款或待开通订单，请先确认原订单；支付入口有效期为15分钟。',plan_change_requires_review:'当前套餐尚未到期；跨套餐或人工套餐变更请联系支持。',plan_unavailable:'套餐版本已更新，请刷新页面。',forbidden:'仅企业管理员本人可购买套餐。',unauthorized:'登录已失效，请重新登录。'};
        throw new Error(en?'Checkout unavailable. Refresh orders before retrying.':messages[code]??'暂时无法创建支付，请刷新订单列表确认后重试。');
      }
      const target=new URL(body.data.checkout_url);
      if(target.protocol!=='https:'||!['openapi.alipay.com','openapi-sandbox.dl.alipaydev.com'].includes(target.hostname))throw new Error(en?'Invalid payment destination':'支付地址校验失败');
      window.location.assign(target.href);
    }catch(e){setError(e instanceof Error?e.message:'Checkout unavailable');setBusy(false);}
  }
  return <section className="mt-6 rounded-2xl border border-[var(--border-subtle)] bg-white p-5">
    <h2 className="font-semibold">{en?'Alipay checkout':'支付宝套餐收银台'}</h2>
    <p className="mt-2 text-sm text-[var(--ink-500)]">{en?'One-time monthly or annual payment. Annual costs 8 months for 12 months of service. No automatic renewal.':'支持月付和年付，不自动续费；年付为月付价格的 8 倍，享受 12 个月服务。同套餐续费从原到期日顺延。'}</p>
    <p className="mt-3 rounded-xl bg-slate-50 p-3 text-sm leading-6">{en?'Refund policy: measured from successful payment. Within 24 hours, a 1% platform fee is deducted. After 24 and through 168 hours, the deduction is actual payment ÷ total days in the purchased term × used days, plus 1% of actual payment. Partial days count as one day; each deduction is rounded to cents. No standard refund after 168 hours. Approval is required and the refunded term’s remaining service ends.':'退款规则：从付款成功时起算，24 小时内扣实付金额的 1% 平台手续费；超过 24 小时、168 小时以内，应退 = 实付金额 −（实付金额 ÷ 所购套餐周期总天数 × 已使用天数）− 实付金额的 1%。使用不足一天按一天计，各项扣费四舍五入到分，申请时固定计算结果。年付按优惠后的实付金额计算。超过 168 小时不支持常规退款；退款须经管理员审批，退款确认后对应购买期的剩余服务终止。'}</p>
    {!enabled?<p role="status" className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">{en?'Payments are not open yet. No charges will be created.':'收款尚未开放，当前不会创建真实支付。'}</p>:!canPurchase?<p className="mt-3 text-sm">{en?'Only a workspace administrator may purchase.':'仅企业管理员可购买套餐。'}</p>:<>
      <label className="mt-4 block text-sm">{en?'Billing period':'付费周期'}<select value={period} disabled={busy} onChange={e=>{setPeriod(e.target.value);setAccepted(false);}} className="ml-3 rounded-xl border p-2"><option value="monthly">{en?'Monthly':'月付'}</option><option value="annual">{en?'Annual · 8 months price':'年付 · 8 个月价格'}</option></select></label>
      <label className="mt-4 block text-sm">{en?'Choose a plan':'选择套餐'}<select value={selected} onChange={e=>{setSelected(e.target.value);setError('');}} disabled={busy} className="mt-2 block w-full rounded-xl border p-3"><option value="">{en?'Select':'请选择'}</option>{eligible.map(p=><option key={p.plan_version_id} value={p.plan_version_id}>{p.name} · {formatMinor(p.price_minor!,p.currency)} / {en?'month':'月'} · V{p.version}</option>)}</select></label>
      {plan&&<p className="mt-3 text-sm">{en?'Amount due':'本次应付'}：{formatMinor(String(Number(plan.price_minor)*(period==='annual'?8:1)),plan.currency)}。{en?'Payment is confirmed by the server, not the return page.':'付款后以服务端核验结果开通权益；返回页面不代表付款成功。试用将转为所购套餐。'}</p>}
      <label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" checked={accepted} onChange={e=>setAccepted(e.target.checked)} disabled={busy}/>{en?'I have reviewed the price, service term and refund policy above.':'我已阅读并确认本次价格、服务期限及上述退款规则。'}</label>
      <button onClick={pay} disabled={!plan||busy||!accepted} className="mt-4 rounded-xl bg-[var(--brand-500)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy?(en?'Preparing…':'正在准备…'):(en?'Confirm and pay with Alipay':'确认套餐并前往支付宝')}</button>
    </>}
    {error&&<p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
  </section>;
}
