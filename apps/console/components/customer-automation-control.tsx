'use client';
import {useCallback,useEffect,useState} from 'react';
type State={paused:boolean;paused_until:string|null;revision:string;can_control:boolean};
export function CustomerAutomationControl({conversationId,tenantId,en}:{conversationId:string;tenantId:string;en:boolean}){
 const [state,setState]=useState<State|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const url=`/api/conversations/${conversationId}/customer-automation`;
 const load=useCallback(async(signal?:AbortSignal)=>{
  try{const r=await fetch(url,{cache:'no-store',signal,headers:{'x-replynest-workspace':tenantId}});if(!r.ok)throw Error();const b=await r.json();setState(b.data);setError('');}
  catch{if(!signal?.aborted){setState(null);setError(en?'Could not verify customer reception. Reload to check.':'暂时无法核实该客户接待状态，请重新载入。');}}
 },[url,tenantId,en]);
 useEffect(()=>{setState(null);const c=new AbortController();void load(c.signal);return()=>c.abort();},[load]);
 useEffect(()=>{const c=new AbortController();const timer=setInterval(()=>{void load(c.signal);},15000);return()=>{clearInterval(timer);c.abort();};},[load]);
 async function change(minutes:0|10){
  if(!state?.can_control||busy)return;setBusy(true);setError('');
  try{const r=await fetch(url,{method:'PATCH',headers:{'content-type':'application/json','x-replynest-workspace':tenantId,'x-replynest-action':'customer-automation-v1'},
   body:JSON.stringify({operation:minutes?'pause':'resume',minutes,revision:state.revision})});
   if(!r.ok){setError(r.status===409?(en?'State changed. Reload before changing it again.':'状态已变化，请重新载入后操作。'):(en?'Change not confirmed. Reload before retrying.':'操作未确认成功，请重新载入核实，勿重复提交。'));return;}
   setState((await r.json()).data);
  }catch{setError(en?'Connection failed. Reload to confirm the outcome.':'连接失败，请重新载入确认操作结果。');}finally{setBusy(false);}
 }
 // The native service owns expiry. A client-clock countdown can misstate the
 // ten-minute limit or suggest reception has resumed before the server confirms.
 return <div className="mt-3 space-y-2 border-t border-blue-200 pt-3 text-xs">
  <p className="font-semibold">{en?'Customer AI reception':'该客户 AI 接待'}</p>
  {state&&<p role="status">{state.paused?(en?'Paused · resumes automatically on expiry':'已暂停 · 到期自动恢复'):(en?'No customer pause':'未对该客户暂停')}</p>}
  {state?.can_control&&<div className="flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={()=>void change(10)} className="rounded-lg border border-blue-200 bg-white px-2 py-1.5 disabled:opacity-50">{en?'Pause 10 min':'暂停 10 分钟'}</button>{state.paused&&<button type="button" disabled={busy} onClick={()=>void change(0)} className="rounded-lg border border-blue-200 bg-white px-2 py-1.5 disabled:opacity-50">{en?'Resume now':'提前恢复'}</button>}</div>}
  <p className="leading-5">{en?'Applies to this customer’s conversations in this business. Expiry restores reception for new questions; paused messages are not replayed. Requests already submitted cannot be recalled.':'作用于该客户在本企业的所有会话，到期后恢复新问题接待；暂停期间的问题不会补发。已提交的消息无法撤回。'}</p>
  {error&&<p role="alert" className="text-red-700">{error}</p>}
  <button type="button" disabled={busy} className="underline" onClick={()=>void load()}>{en?'Reload reception state':'重新载入接待状态'}</button>
 </div>;
}
