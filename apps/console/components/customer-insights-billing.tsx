'use client';
import {useEffect,useRef,useState} from 'react';
import {insightJobStates,insightMessages,parseInsightsBilling,type InsightsBilling} from '../lib/customer-insights';
export function CustomerInsightsBilling({workspaceId}:{workspaceId:string}){
 const [data,setData]=useState<InsightsBilling|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState<string|null>(null);
 const pending=useRef<AbortController|null>(null),scope=useRef(workspaceId);scope.current=workspaceId;
 useEffect(()=>{setData(null);setError('');setNotice('');setBusy(false);setConfirm(null);return()=>{pending.current?.abort();pending.current=null;};},[workspaceId]);
 async function request(before?:string,reconcile?:string){
  if(pending.current)return;const controller=new AbortController(),current=workspaceId;pending.current=controller;setBusy(true);setError('');setNotice('');
  const timer=setTimeout(()=>controller.abort(),10000);
  try{
   const response=await fetch('/api/customer-insights/billing'+(reconcile?'/'+reconcile+'/reconcile':before?'?before='+before:''),{method:reconcile?'POST':'GET',cache:'no-store',redirect:'error',signal:controller.signal,
    headers:{'content-type':'application/json','x-replynest-workspace':current,'x-replynest-action':'customer-insights-v1'},body:reconcile?JSON.stringify({confirmed:true}):undefined});
   const result=await response.json();if(scope.current!==current||pending.current!==controller)return;
   if(!response.ok)throw Error(result?.error?.code??'insights_result_uncertain');
   if(reconcile){if(typeof result?.data?.repeated!=='boolean')throw Error('insights_result_uncertain');setConfirm(null);setData(null);setNotice('已核对现有账本凭证；没有重复扣点、重试模型或恢复旧备注。请重新加载第一页查看最新记录。');}
   else setData(parseInsightsBilling(result.data));
  }catch(e){if(scope.current===current&&pending.current===controller)setError(insightMessages[e instanceof Error?e.message:'']??insightMessages.insights_result_uncertain);}
  finally{clearTimeout(timer);if(pending.current===controller){pending.current=null;setBusy(false);}}
 }
 const button='rounded-xl border border-[var(--border-subtle)] px-3 py-2 text-sm disabled:opacity-50';
 return <section className="mt-6 rounded-2xl border border-[var(--border-subtle)] bg-white p-5">
  <h2 className="text-lg font-semibold">客户 AI 备注与画像扣费</h2>
  <p className="mt-2 text-sm text-slate-500">每页 10 条，按需加载。生成按实际模型用量扣点；结果未采用也可能产生费用。查看、纠正备注和图表不额外扣点。</p>
  <button type="button" className={button+' mt-4'} disabled={busy} onClick={()=>void request()}>{busy?'处理中…':data?'重新加载第一页':'加载扣费记录'}</button>
  {notice&&<p role="status" className="mt-3 text-sm text-emerald-700">{notice}</p>}{error&&<p role="alert" className="mt-3 text-sm text-red-700">{error} 操作不自动重试，请刷新核实。</p>}
  {data&&<>
   {!data.records.length&&<p className="mt-3 text-sm text-slate-500">暂无该用途的执行记录。</p>}
   {data.records.map(r=><article key={r.job_id} className="mt-4 space-y-2 border-t border-[var(--border-subtle)] pt-3 text-sm">
    <div className="flex flex-wrap justify-between gap-2"><b>{insightJobStates[r.job_state]}</b><time>{new Date(r.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}</time></div>
    <p>AI 账本已扣：{r.charged_points===null?'尚未确认':r.charged_points+' 点'}；此用途日预算预占：{r.budget_hold_points} 点。</p>
    <p className="text-xs text-slate-500">调用前预留上限：{r.reserved_points} 点；任务编号：{r.job_id}</p>
    {r.budget_state==='unknown'&&<p className="text-xs text-amber-700">执行／费用不确定，预占不会自动释放，同客户后续生成会等待费用核对。不会自动重试本次模型调用。</p>}
    {r.can_reconcile&&<div className="space-y-2">
     <label className="flex gap-2 text-xs"><input type="checkbox" disabled={busy} checked={confirm===r.job_id} onChange={e=>setConfirm(e.target.checked?r.job_id:null)}/>仅同步已结算的 AI 账本凭证，不修改已扣费用或重试模型。</label>
     <button type="button" className={button} disabled={busy||confirm!==r.job_id} onClick={()=>void request(undefined,r.job_id)}>核对已入账费用</button>
    </div>}
    {r.budget_state==='unknown'&&!r.can_reconcile&&<a href="/contact" className="text-xs text-blue-700 underline">联系客服核对费用，并提供任务编号</a>}
   </article>)}
   {data.next_before&&<button type="button" className={button+' mt-4'} disabled={busy} onClick={()=>{setConfirm(null);void request(data.next_before!);}}>加载下一页</button>}
  </>}
 </section>;
}
