'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {formatHistoryPoints,historyJobLabels,historyJobMessages,parseHistoryJobsPage,type HistoryJobsPage} from '../lib/reception-history-jobs';
const button='rounded-xl border px-4 py-2 text-sm font-semibold disabled:opacity-50';
const uncertain='提交结果暂时无法确认。请先核对本次任务，不要重新创建；重试仅使用同一任务标识。';
export function ReceptionHistoryJobs({workspaceId,authorized}:{workspaceId:string;authorized:boolean}){
 const [page,setPage]=useState<HistoryJobsPage|null>(null),[busy,setBusy]=useState(false),[stale,setStale]=useState(true),[notice,setNotice]=useState('');
 const [confirming,setConfirming]=useState(false),[confirmed,setConfirmed]=useState(false),[unresolved,setUnresolved]=useState(false);
 const epoch=useRef(0),submission=useRef<string|null>(null),inflight=useRef(false),wasAuthorized=useRef(authorized);
 const api=useCallback(async(query='',body?:unknown)=>{
  const r=await fetch('/api/reception-personalization/knowledge-jobs'+query,{method:body===undefined?'GET':'POST',cache:'no-store',signal:AbortSignal.timeout(9000),
   headers:{'x-replynest-workspace':workspaceId,...(body===undefined?{}:{'content-type':'application/json','x-replynest-action':'reception-personalization-v1'})},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await r.json();if(!r.ok)throw Error(historyJobMessages[result?.error?.code]??'任务状态暂时无法确认，请刷新核实。');return parseHistoryJobsPage(result?.data);
 },[workspaceId]);
 const refresh=useCallback(async(cursor?:string)=>{
  if(inflight.current)return;inflight.current=true;const run=++epoch.current;setBusy(true);setStale(true);setConfirming(false);setConfirmed(false);
  try{const pending=submission.current,result=await api(pending?'?requestId='+pending:cursor?'?cursor='+encodeURIComponent(cursor):'');if(run!==epoch.current)return;
   setPage(result);setStale(false);
   if(pending&&result.items.some(j=>j.requestId===pending)){submission.current=null;setUnresolved(false);setNotice('已核对本次任务；请以任务状态和费用为准。');}
   else if(pending){setUnresolved(true);setNotice('尚未查到本次任务。可继续核对，或在再次确认后重试同一次提交；不会改用新的任务标识。');}
   else setNotice('');
  }catch(e){if(run===epoch.current)setNotice(e instanceof Error?e.message:'任务状态暂时无法确认。');}
  finally{if(run===epoch.current){inflight.current=false;setBusy(false);}}
 },[api]);
 useEffect(()=>{inflight.current=false;submission.current=null;setPage(null);setUnresolved(false);setNotice('');void refresh();return()=>{epoch.current++;};},[refresh]);
 useEffect(()=>{if(wasAuthorized.current!==authorized){wasAuthorized.current=authorized;epoch.current++;inflight.current=false;setBusy(false);setStale(true);setConfirming(false);setConfirmed(false);}},[authorized]);
 async function submit(){
  if(inflight.current||!confirmed||!authorized||stale||!page?.canGenerate)return;
  inflight.current=true;const run=++epoch.current;setBusy(true);setNotice('');
  submission.current??=crypto.randomUUID();const requestId=submission.current;
  try{const result=await api('',{confirmed:true,requestId});if(run!==epoch.current)return;
   if(!result.items.some(j=>j.requestId===requestId))throw Error('unconfirmed_job');
   setPage(result);submission.current=null;setUnresolved(false);setStale(false);setNotice('任务已提交。结果仅作为待核对草稿，不会直接发布或回复客户。');
  }catch{if(run===epoch.current){setStale(true);setUnresolved(true);setNotice(uncertain);}}
  finally{if(run===epoch.current){inflight.current=false;setBusy(false);setConfirming(false);setConfirmed(false);}}
 }
 const active=page?.items.some(j=>!['succeeded','failed','uncertain'].includes(j.state));
 return <section className="mt-4 space-y-3 border-t pt-4" aria-label="历史知识草稿任务">
  <h4 className="font-semibold">从历史聊天整理知识库草稿</h4>
  <p className="text-sm leading-6">参考近30天已授权的客户问题和人工答案，每次最多整理5条。历史答复可能过时或错误，请核对、编辑并确认发布后再使用。生成消耗 AI 点数；确认发布后的索引另按实际调用计费。</p>
  {notice&&<p role="status" className="text-sm text-amber-800">{notice}</p>}
  {!authorized&&<p className="text-sm text-amber-800">请先保存上方“历史知识草稿”用途授权，再刷新任务。</p>}
  {page&&!page.canGenerate&&<p className="text-sm text-amber-800">生成服务尚未开放；现有任务可查看，不会开始读取历史或调用模型。</p>}
  <div className="flex flex-wrap gap-3"><button type="button" className={button} disabled={busy} onClick={()=>void refresh()}>{unresolved?'核对本次任务':'刷新草稿任务'}</button>
   <button type="button" className={button} disabled={busy||stale||!authorized||!page?.canGenerate||!!active} onClick={()=>{setConfirming(true);setConfirmed(false);}}>{unresolved?'重试同一次提交':'生成待核对知识草稿'}</button>
   {page?.nextCursor&&!unresolved&&<button type="button" className={button} disabled={busy} onClick={()=>void refresh(page.nextCursor!)}>下一页任务</button>}</div>
  {confirming&&<div className="space-y-3 rounded-xl bg-blue-50 p-4"><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/>我确认整理已授权的历史聊天并消耗 AI 点数；没有可用草稿也可能发生模型费用。内容不会自动发布或发送。</label>
   <button type="button" className={button} disabled={busy} onClick={()=>{setConfirming(false);setConfirmed(false);}}>取消生成</button>{' '}
   <button type="button" className={button} disabled={busy||!confirmed} onClick={()=>void submit()}>确认生成草稿</button></div>}
  {stale&&<p className="text-xs text-amber-800">{busy?'正在核对任务状态…':'任务状态未确认，请先刷新。'}</p>}
  {page&&<ul className="space-y-3">{page.items.map(j=><li key={j.jobId} className="rounded-xl border p-4 text-sm">
   <p>{historyJobLabels[j.state]} · {new Date(j.createdAt).toLocaleString('zh-CN')}</p>
   <p className="mt-2">{j.billing.state==='charged'?`已扣 ${formatHistoryPoints(j.billing.chargedMicros!)} AI 点数`:j.billing.state==='reserved'?`预留 ${formatHistoryPoints(j.billing.reservedMicros!)} AI 点数，尚未完成结算`:j.billing.state==='not_requested'?'尚未调用模型':j.billing.state==='not_charged'?'结算记录确认未扣点':'费用或调用结果待核实，请勿重复生成'}</p>
   {j.documentId&&<a className="mt-2 inline-block text-blue-700" href={`/knowledge/${j.documentId}/review`}>核对并编辑草稿</a>}
   {j.state==='uncertain'&&<p className="mt-2 text-amber-800">任务不会自动重试，请联系管理员核实。</p>}
  </li>)}</ul>}
 </section>;
}
