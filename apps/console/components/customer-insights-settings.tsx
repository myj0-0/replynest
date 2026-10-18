'use client';
import {useEffect,useRef,useState} from 'react';
import {insightConsentVersion,insightMessages,parseInsightsSettings,type InsightsSettings} from '../lib/customer-insights';
/** Settings and persisted charts are loaded on demand, never transcripts/models. */
export function CustomerInsightsSettings({workspaceId}:{workspaceId:string}){
 const [settings,setSettings]=useState<InsightsSettings|null>(null),[budget,setBudget]=useState('10'),[confirmed,setConfirmed]=useState(false),
  [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const pending=useRef<AbortController|null>(null),scope=useRef(workspaceId);scope.current=workspaceId;
 useEffect(()=>{setSettings(null);setConfirmed(false);setBudget('10');setError('');setNotice('');setBusy(false);
  return()=>{pending.current?.abort();pending.current=null;};},[workspaceId]);
 async function request(path:'settings',body?:object){
  if(pending.current)return;const controller=new AbortController(),current=workspaceId;pending.current=controller;setBusy(true);setError('');setNotice('');
  const timer=setTimeout(()=>controller.abort(),10000);
  try{
   const response=await fetch('/api/customer-insights/'+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',
    'x-replynest-workspace':current,'x-replynest-action':'customer-insights-v1'},body:body?JSON.stringify(body):undefined,
    cache:'no-store',redirect:'error',signal:controller.signal});
   const result=await response.json();if(scope.current!==current||pending.current!==controller)return;
   if(!response.ok)throw Error(Object.hasOwn(insightMessages,result?.error?.code)?result.error.code:'insights_result_uncertain');
   if(path==='settings'){const value=parseInsightsSettings(result.data);setSettings(value);setBudget(value.daily_budget_points);setConfirmed(false);
    if(body)setNotice(value.enabled?'客户 AI 备注授权已保存；仅处理此用途下的新消息事件。':'客户 AI 备注已停止生成。');
   }
  }catch(e){if(scope.current===current&&pending.current===controller)setError(insightMessages[e instanceof Error?e.message:'']??insightMessages.insights_result_uncertain);
  }finally{clearTimeout(timer);if(pending.current===controller){pending.current=null;setBusy(false);}}
 }
 function save(enabled:boolean){if(!settings)return;void request('settings',{revision:settings.revision,enabled,daily_budget_points:budget,confirmed,consent_version:insightConsentVersion});}
 const button='rounded-xl border border-[var(--border-subtle)] px-4 py-2 text-sm disabled:opacity-50';
 return <section id="customer-insights" data-layout-mutation-busy={busy?'true':undefined} className="mt-6 scroll-mt-6 rounded-2xl border border-[var(--border-subtle)] bg-white p-5">
  <h2 className="text-lg font-semibold">客户 AI 备注与问题画像</h2>
  <p className="mt-2 text-sm leading-6 text-[var(--ink-500)]">根据聊天增量整理跨会话需求备注和当前问题，结果仅团队可见；不替代人工判断，不覆盖人工备注。此用途须单独授权，默认关闭。</p>
  {!settings?<button type="button" className={button+' mt-4'} disabled={busy} onClick={()=>void request('settings')}>{busy?'正在读取…':'查看授权与每日预算'}</button>:<>
   <p className="mt-4 text-sm">当前授权：{settings.enabled?(settings.grant_active?'已开启':'已保存，但授权人权限已失效，请重新确认'):'未开启'}。保存授权不代表执行服务已经启用。</p>
   <div className="mt-4 flex flex-wrap items-end gap-3"><label className="text-sm">每日 AI 点数预算
    <input type="text" inputMode="decimal" value={budget} disabled={busy} onChange={e=>setBudget(e.target.value)} className="mt-1 block rounded-xl border border-[var(--border-subtle)] px-3 py-2"/>
   </label><button type="button" className={button} disabled={busy} onClick={()=>void request('settings')}>刷新授权与用量</button></div>
   <p className="mt-2 text-xs leading-5 text-[var(--ink-500)]">按北京时间每日合并计算；今日已扣 {settings.charged_points} 点，预占 {settings.held_points} 点（{settings.budget_day}）。预占未确认费用不会自动释放或重试，达到预算后不再发起新的模型调用。</p>
   <label className="mt-4 flex items-start gap-2 text-sm leading-6"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)} className="mt-1"/>
    我授权答巢读取本企业当前客户的相关历史聊天，按新消息增量生成内部长期需求备注、当前问题和咨询主题，并按实际模型用量扣取 AI 点数；不推断敏感身份，不自动发给客户。旧语气或知识草稿授权不代替本项授权。团队可纠正或删除结果，图表只统计已保存结果，不再次调用模型扣点。</label>
   <div className="mt-4 flex flex-wrap gap-2"><button type="button" className={button+' bg-[var(--brand-600)] text-white'} disabled={busy||!confirmed} onClick={()=>save(true)}>阅读并保存授权及预算</button>
    <button type="button" className={button} disabled={busy||!settings.enabled} onClick={()=>save(false)}>停止生成</button></div>
   <p className="mt-2 text-xs text-[var(--ink-500)]">停止后不再生成；已有结果不会自动删除。正在调用模型的费用仍需核对。启用不补扫停用期间的已完成事件。</p>
  </>}
  <div className="mt-5 border-t border-[var(--border-subtle)] pt-4"><a href="/#customer-insights" className={button+' inline-flex'}>返回首页查看画像与咨询分析</a><p className="mt-2 text-xs text-[var(--ink-500)]">图表已移至控制台首页；只汇总已有结果，查看不额外扣点。</p></div>
  {error&&<p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}{notice&&<p role="status" className="mt-3 text-sm text-emerald-700">{notice}</p>}
 </section>;
}
