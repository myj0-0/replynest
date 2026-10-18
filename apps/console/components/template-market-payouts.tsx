'use client';
import {useEffect,useState} from 'react';

type Payout={payout_id:string;seller_tenant_id:string;amount_minor:number;fee_minor:number;net_minor:number;status:string;review_note:string|null;payment_reference:string|null;payee_id:string|null};
type Earnings={available_minor:string;frozen_minor:string;reserved_minor:string;pending_payment_minor:string;paid_minor:string;debt_minor:string};
const money=(value:string|number)=>`¥${(Number(value)/100).toFixed(2)}`;
const names:Record<string,string>={requested:'待审核（收益已冻结）',approved:'已批准，待手动打款',paid:'已登记打款',rejected:'已拒绝，冻结已释放'};
const errors:Record<string,string>={market_payout_recheck_failed:'收益已因退款等原因变化，请拒绝旧申请后重新申请。',market_confirm_unpaid_required:'请先核实没有实际打款，再勾选未打款确认。',market_payout_conflict:'申请状态已变化，请刷新后核对。',market_receipt_conflict:'已登记的打款凭证不同，请核对，不能重复打款。'};

function Review({item,done}:{item:Payout;done:()=>void}) {
 const [action,setAction]=useState('reject'),[busy,setBusy]=useState(false),[error,setError]=useState('');
 return <form className="mt-3 space-y-3" onSubmit={async e=>{
  e.preventDefault();const form=new FormData(e.currentTarget);setBusy(true);setError('');
  try{const response=await fetch('/api/platform-admin/template-market/payout-review',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payout_id:item.payout_id,action,note:form.get('note'),payment_reference:form.get('reference'),confirmed:form.get('confirmed')==='on',confirmed_unpaid:form.get('unpaid')==='on'})});const result=await response.json();if(!response.ok)throw Error(errors[result.error?.code]??'操作未完成，请刷新核对状态；不要重复打款。');done();}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}
 }}>
  <p className="break-all text-xs text-slate-500">绑定收款资料编号：{item.payee_id??'历史申请未绑定，禁止批准'}。请核对同一资料编号，不要使用其他版本账号打款。</p>
  <div className="flex flex-wrap gap-2"><select aria-label="提现处理方式" value={action} onChange={e=>setAction(e.target.value)} className="rounded-lg border p-2"><option value="reject">拒绝并释放冻结</option>{item.status==='requested'?<option value="approve">批准，进入手动打款流程</option>:<option value="paid">登记已完成的手动打款</option>}</select><input aria-label="提现处理说明" name="note" required minLength={10} maxLength={500} placeholder="处理说明，至少 10 字" className="min-w-0 rounded-lg border p-2"/></div>
  {action==='paid'&&<input name="reference" aria-label="打款交易凭证编号" required minLength={5} maxLength={200} placeholder="已实际打款的唯一交易凭证编号" className="w-full rounded-lg border p-2"/>}
  {item.status==='approved'&&action==='reject'&&<label className="block text-sm"><input name="unpaid" type="checkbox" required/> 我已核实此申请没有实际打款；若转账状态不明，不得释放冻结。</label>}
  <label className="block text-sm"><input key={action} name="confirmed" type="checkbox" required/> {action==='paid'?'我已核对实际收款主体、金额与凭证，打款已经完成。':'我已核对申请及收款主体，确认本次处理。'}</label>
  {error&&<p role="alert" className="text-sm text-red-700">{error}</p>}<button className="rounded-lg border px-3 py-2 disabled:opacity-40" disabled={busy}>确认处理（不会自动转账）</button>
 </form>;
}

export function TemplateMarketPayouts({admin=false}:{admin?:boolean}) {
 const [items,setItems]=useState<Payout[]>([]),[earnings,setEarnings]=useState<Earnings|null>(null),[offset,setOffset]=useState(0),[next,setNext]=useState<number|null>(null),[revision,setRevision]=useState(0),[loading,setLoading]=useState(true),[error,setError]=useState('');
 useEffect(()=>{let active=true;const controller=new AbortController();setLoading(true);setError('');
  const base=admin?'/api/platform-admin/template-market':'/api/template-market';
  async function get(path:string){const response=await fetch(base+path,{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error('收益与提现信息暂不可用，请刷新重试。');return (await response.json()).data;}
  Promise.all([get('/payouts?offset='+offset),admin?Promise.resolve(null):get('/earnings')]).then(([page,funds])=>{if(active){setItems(page.items);setNext(page.next_offset);setEarnings(funds);}}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;controller.abort();};
 },[admin,offset,revision]);
 return <section className="space-y-4 rounded-xl border bg-white p-5"><h2 className="font-semibold">{admin?'卖家收益提现审批':'我的模板收益'}</h2><p className="text-sm text-slate-500">收益冻结 7 天，提现另扣 1% 手续费。收益独立记账，不属于充值退款；退款欠款由后续收益抵扣，欠款未清零不能再次提现。当前提现申请尚未开放。</p>{admin&&<p className="text-sm text-amber-800">先批准并锁定金额，再线下核实收款主体并手动打款，最后登记凭证。状态不明时先查账，不要重复转账或释放冻结。</p>}
  {error&&<p role="alert" className="text-red-700">{error}</p>}{loading?<p role="status">正在加载收益…</p>:<>{earnings&&<dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{[['可提现收益',earnings.available_minor],['冻结期收益',earnings.frozen_minor],['申请冻结',earnings.reserved_minor],['已结算（含提现手续费）',earnings.paid_minor],['待偿金额',earnings.debt_minor]].map(([label,value])=><div key={label} className="rounded-lg bg-slate-50 p-3"><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-2 font-semibold">{money(value)}</dd></div>)}</dl>}
  {!items.length?<p className="text-sm text-slate-500">暂无提现申请。</p>:items.map(item=><article key={item.payout_id} className="rounded-xl border p-4"><h3 className="font-medium">申请 {money(item.amount_minor)} · {names[item.status]}</h3><p className="text-sm">手续费 {money(item.fee_minor)} · 实际打款 {money(item.net_minor)}</p>{admin&&<p className="break-all text-xs text-slate-500">企业：{item.seller_tenant_id}</p>}<p className="break-all text-xs text-slate-500">申请号：{item.payout_id}</p>{item.review_note&&<p className="text-sm">处理说明：{item.review_note}</p>}{item.payment_reference&&<p className="break-all text-sm">打款凭证：{item.payment_reference}</p>}{admin&&['requested','approved'].includes(item.status)&&<Review item={item} done={()=>setRevision(n=>n+1)}/>}</article>)}<div className="flex gap-3">{offset>0&&<button onClick={()=>setOffset(0)}>返回首页</button>}{next!==null&&<button onClick={()=>setOffset(next)}>下一页</button>}<button onClick={()=>setRevision(n=>n+1)}>刷新收益与申请</button></div></>}
 </section>;
}
