'use client';
import {useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import type {PlanCatalogItem} from '../lib/billing';
type Quote={quote_id:string;direction:string;plan_name:string;billing_period:string;carry_minor:number;due_minor:number;target_term_minor:number;period_end:string;expires_at:string;payment:{cash_minor:number;gift_minor:number};available_cash_minor:number};
const money=(n:number)=>new Intl.NumberFormat('zh-CN',{style:'currency',currency:'CNY'}).format(n/100);
const errors:Record<string,string>={plan_change_requires_review:'当前套餐不是有限期的余额购买套餐，请联系管理员调整。',same_plan_use_renewal:'当前已使用该套餐，请在套餐目录续费。',plan_unavailable:'目标价格已更新，请刷新页面。',plan_quote_changed:'价格、余额或权益发生变化，请重新核算。',plan_quote_expired:'报价已过期，请重新核算。',refund_in_progress:'存在退款申请，请等待处理完成。',checkout_in_progress:'存在未完成订单，请先处理。',insufficient_balance:'现金余额不足，请先充值。',plan_value_requires_review:'剩余权益需要管理员核对，请联系客服。',plan_conversion_requires_review:'折算时长超出自助范围，请联系客服。',forbidden:'仅企业管理员本人可变更套餐。'};
export function PlanChangePanel({plans,en=false,onChanged}:{plans:PlanCatalogItem[];en?:boolean;onChanged:()=>Promise<void>}){
 const router=useRouter(),[target,setTarget]=useState(''),[quote,setQuote]=useState<Quote|null>(null),[accepted,setAccepted]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const inflight=useRef(false),retry=useRef<{body:string;key:string}|null>(null);
 async function act(execute=false){if(inflight.current||execute&&!accepted)return;inflight.current=true;setBusy(true);setMessage('');
  const input=execute?{quote_id:quote?.quote_id,accepted:true}:{plan_version_id:target},body=JSON.stringify(input);
  if(retry.current?.body!==body)retry.current={body,key:crypto.randomUUID()};
  try{const response=await fetch('/api/billing/wallet/'+(execute?'plan-change':'plan-quote'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...input,idempotency_key:retry.current.key})}),json=await response.json();
   if(!response.ok)throw Error(json.error?.code??'unavailable');
   if(execute){setQuote(null);setAccepted(false);retry.current=null;setMessage(en?'Plan changed. The AI cycle and usage are preserved.':'套餐变更成功；AI 点数周期及已用量保持不变。');await onChanged();router.refresh();}
   else{setQuote(json.data);setAccepted(false);retry.current=null;}
  }catch(error){const code=error instanceof Error?error.message:'';setMessage(errors[code]??'操作未确认，请先查看账务记录。同一请求重试不会重复扣款。');if(['plan_quote_changed','plan_quote_expired'].includes(code)){setQuote(null);retry.current=null;}}
  finally{setBusy(false);inflight.current=false;}
 }
 return <section data-layout-mutation-busy={busy} className="rounded-2xl border border-[var(--border-subtle)] bg-white p-5 shadow-[var(--shadow-card)]"><h2 className="text-lg font-semibold">{en?'Upgrade / downgrade':'升级／降级套餐'}</h2><p className="mt-2 text-sm leading-6 text-slate-500">适用于有限期的余额购买套餐。升级保持到期日、补差价；降级立即生效，剩余价值折算时长，不退现金。人工赠送／长期授权请联系管理员。</p>
  <div className="mt-4 flex flex-wrap gap-3"><select aria-label="目标套餐" value={target} disabled={busy} onChange={e=>{setTarget(e.target.value);setQuote(null);setAccepted(false);retry.current=null;}} className="rounded-xl border border-slate-200 p-3"><option value="">选择目标套餐</option>{plans.filter(p=>['starter','professional'].includes(p.plan_code)).map(p=><option key={p.plan_version_id} value={p.plan_version_id}>{p.name}</option>)}</select><button type="button" disabled={!target||busy} onClick={()=>void act()} className="rounded-xl border border-blue-200 px-4 py-2 text-sm font-semibold text-blue-700 disabled:opacity-40">{busy?'正在核算…':'核算差价与期限（不扣款）'}</button></div>
  {quote&&<div className="mt-4 rounded-xl border border-blue-100 bg-blue-50 p-4 text-sm leading-7"><b>{quote.direction==='upgrade'?'升级':'降级'}至 {quote.plan_name} · {quote.billing_period==='annual'?'沿用年付优惠':'沿用月付'}</b><p>原订单剩余价值 {money(quote.carry_minor)}；目标当前{quote.billing_period==='annual'?'年':'月'}价 {money(quote.target_term_minor)}。</p><p>本次补差价 {money(quote.due_minor)}＝赠送 {money(quote.payment.gift_minor)} ＋ 现金 {money(quote.payment.cash_minor)}。</p><p>变更后到期：<strong>{new Date(quote.period_end).toLocaleString()}</strong></p><p className="text-slate-600">原价值按原订单实付金额与剩余时长核算，不随调价改变。保留 AI 点数周期及已用量；降级超额时当期套餐可用点数为 0，额外点数仍可用。报价有效至 {new Date(quote.expires_at).toLocaleTimeString()}。</p><label className="mt-3 flex items-start gap-2"><input type="checkbox" checked={accepted} disabled={busy} onChange={e=>setAccepted(e.target.checked)} className="mt-2"/>我确认金额、期限及即时变更；降级不返现金，退款期限仍从原付款起算。</label><button type="button" onClick={()=>void act(true)} disabled={busy||!accepted||quote.payment.cash_minor>quote.available_cash_minor} className="mt-3 rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white disabled:opacity-40">确认变更{quote.due_minor>0?'并扣款':''}</button>{quote.payment.cash_minor>quote.available_cash_minor&&<p className="text-red-700">现金余额不足，请先充值后重新核算。</p>}</div>}
  {message&&<p role="status" className="mt-3 text-sm text-blue-700">{message}</p>}
 </section>;
}
