'use client';
import {useEffect,useRef,useState} from 'react';
import {insightMessages,parseInsightsProfile,type InsightsProfile} from '../lib/customer-insights';

/** Saved, team-only projections. Opening the panel does not read history or
 * call a model. Never reuse display can_edit as server mutation authority. */
export function CustomerInsightsProfile({workspaceId,conversationId}:{workspaceId:string;conversationId:string}){
 const [data,setData]=useState<InsightsProfile|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [facts,setFacts]=useState(''),[issue,setIssue]=useState(''),[confirmed,setConfirmed]=useState(false),[editing,setEditing]=useState(false);
 const scope=workspaceId+':'+conversationId,live=useRef(scope),request=useRef<AbortController|null>(null);
 live.current=scope;
 useEffect(()=>{setData(null);setError('');setBusy(false);setEditing(false);setConfirmed(false);setFacts('');setIssue('');
  return()=>{request.current?.abort();request.current=null;};},[scope]);
 async function perform(action?:'correct'|'delete'|'resume'){
  if(request.current||action&&(!data?.profile||!data.can_edit||!confirmed))return;
  const controller=new AbortController();request.current=controller;setBusy(true);setError('');
  const captured=scope;
  try{
   const r=await fetch('/api/customer-insights/conversations/'+conversationId,{method:action?'POST':'GET',cache:'no-store',redirect:'error',signal:controller.signal,
    headers:{'content-type':'application/json','x-replynest-workspace':workspaceId,'x-replynest-action':'customer-insights-v1'},
    body:action?JSON.stringify({revision:data!.profile!.revision,change:action==='correct'?{action,facts:facts.split('\n').map(s=>s.trim()).filter(Boolean),issue}:{action}}):undefined});
   const value=await r.json();if(!r.ok)throw Error(value?.error?.code??'insights_result_uncertain');
   const parsed=parseInsightsProfile(value.data);if(live.current!==captured||controller.signal.aborted)return;
   setData(parsed);setFacts(parsed.profile?.long_term.join('\n')??'');setIssue(parsed.profile?.current_issue??'');setEditing(false);setConfirmed(false);
  }catch(e){if(live.current===captured&&!controller.signal.aborted)setError(insightMessages[e instanceof Error?e.message:'']??insightMessages.insights_result_uncertain);}
  finally{if(request.current===controller)request.current=null;if(live.current===captured&&!controller.signal.aborted)setBusy(false);}
 }
 const button='rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-xs disabled:opacity-50';
 return <section className="space-y-3 border-t border-[var(--border-subtle)] pt-4">
  <h3 className="text-sm font-semibold">AI 客户备注 · 仅团队可见</h3>
  <p className="text-xs text-[var(--ink-500)]">长期需求与当前会话问题，供客服参考；不覆盖人工备注。查看和纠正已有结果不额外扣点。</p>
  <button type="button" className={button} disabled={busy} onClick={()=>void perform()}>{busy?'处理中…':data?'刷新 AI 备注':'按需加载 AI 备注'}</button>
  {error&&<p role="alert" className="text-xs text-red-600">{error} 未确认的操作请刷新核实，不会自动重试。</p>}
  {data&&!data.profile&&<p className="text-xs text-[var(--ink-500)]">暂无已生成的 AI 备注。企业管理员需单独授权，之后的新消息才会进入处理。</p>}
  {data?.profile&&<>
   {data.profile.suppressed?<p className="text-xs">此客户的 AI 备注已删除并暂停生成；不影响自动接待。</p>:<>
    <p className="text-xs font-semibold">长期需求备注</p>
    {data.profile.long_term.length?<ul className="list-disc space-y-1 pl-4 text-xs">{data.profile.long_term.map((text,i)=><li key={i}>{text}</li>)}</ul>:<p className="text-xs">暂无长期需求备注。</p>}
    <p className="text-xs font-semibold">当前会话问题</p><p className="whitespace-pre-wrap text-xs">{data.profile.current_issue||'暂无当前会话总结。'}</p>
   </>}
   {!data.can_edit&&<p className="text-xs text-[var(--ink-500)]">仅当前负责客服、主管或管理员可纠正、删除或恢复。</p>}
   {data.can_edit&&<>
    {!data.profile.suppressed&&!editing&&data.profile.current_issue!==null&&<button className={button} type="button" disabled={busy} onClick={()=>{setEditing(true);setConfirmed(false);}}>纠正 AI 备注</button>}
    {editing&&<div className="space-y-2">
     <label className="block text-xs">长期需求（每行一条，最多 12 条，每条 200 字）<textarea className="mt-1 w-full rounded-lg border border-[var(--border-subtle)] p-2" value={facts} maxLength={2411} rows={4} onChange={e=>{setFacts(e.target.value);setConfirmed(false);}}/></label>
     <label className="block text-xs">当前会话问题（最多 600 字）<textarea className="mt-1 w-full rounded-lg border border-[var(--border-subtle)] p-2" value={issue} maxLength={600} rows={3} onChange={e=>{setIssue(e.target.value);setConfirmed(false);}}/></label>
    </div>}
    <label className="flex gap-2 text-xs"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/>{data.profile.suppressed?'确认恢复后仅根据后续新消息生成，不恢复已删除内容。':editing?'我已核对内容；保存纠正结果，不修改人工备注。':'确认删除该客户在本企业的全部 AI 备注并暂停后续生成；不影响人工备注及自动接待。'}</label>
    {editing?<div className="flex gap-2"><button className={button} type="button" disabled={busy||!confirmed} onClick={()=>void perform('correct')}>保存纠正</button><button className={button} type="button" disabled={busy} onClick={()=>{setEditing(false);setConfirmed(false);}}>取消</button></div>:
     <button className={button} type="button" disabled={busy||!confirmed} onClick={()=>void perform(data.profile!.suppressed?'resume':'delete')}>{data.profile.suppressed?'恢复 AI 备注生成':'删除并暂停 AI 备注'}</button>}
   </>}
  </>}
 </section>;
}
