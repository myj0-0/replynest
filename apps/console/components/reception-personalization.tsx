'use client';
import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {historyPurposeLabels,personalizationMessages,parsePersonalizationView,type HistoryPurpose,type PersonalizationSettings,type PersonalizationView} from '../lib/reception-personalization';
import {ReceptionHistoryJobs} from './reception-history-jobs';
const button='rounded-xl border border-[var(--border-subtle)] px-4 py-2 text-sm font-semibold disabled:opacity-50';
const field='rounded-xl border border-[var(--border-subtle)] bg-white px-3 py-2 text-sm';
const purposes:HistoryPurpose[]=['context','style','knowledgeDraft'];
const tones=[['concise','简洁直接'],['neutral','标准中性'],['friendly_detailed','亲切详细']];
export function ReceptionPersonalization({workspaceId,section='all'}:{workspaceId:string;section?:'all'|'style'|'history'}){
 const [view,setView]=useState<PersonalizationView|null>(null),[form,setForm]=useState<PersonalizationSettings|null>(null);
 const [busy,setBusy]=useState(false),[stale,setStale]=useState(true),[notice,setNotice]=useState('');
 const [pending,setPending]=useState<HistoryPurpose|null>(null),[confirmed,setConfirmed]=useState(false);
 const epoch=useRef(0),heading=useRef<HTMLHeadingElement>(null);
 const api=useCallback(async(path='',body?:unknown):Promise<PersonalizationView>=>{
  const r=await fetch('/api/reception-personalization'+path,{method:body===undefined?'GET':'POST',cache:'no-store',signal:AbortSignal.timeout(9000),
   headers:{'x-replynest-workspace':workspaceId,...(body===undefined?{}:{'content-type':'application/json','x-replynest-action':'reception-personalization-v1'})},
   body:body===undefined?undefined:JSON.stringify(body)});
  const b=await r.json();if(!r.ok||!b?.data)throw Error(personalizationMessages[b?.error?.code]??personalizationMessages.personalization_result_uncertain);return parsePersonalizationView(b.data);
 },[workspaceId]);
 const refresh=useCallback(async()=>{
  const run=++epoch.current;setBusy(true);setStale(true);setPending(null);setConfirmed(false);
  try{const result=await api();if(run!==epoch.current)return false;setView(result);setForm(result.settings);setStale(false);return true;}
  catch(e){if(run===epoch.current)setNotice(e instanceof Error?e.message:personalizationMessages.personalization_result_uncertain);return false;}
  finally{if(run===epoch.current)setBusy(false);}
 },[api]);
 useEffect(()=>{setView(null);setForm(null);setNotice('');void refresh();return()=>{epoch.current++;};},[refresh]);
 useEffect(()=>{if(pending)heading.current?.focus();},[pending]);
 async function mutate(path:string,body:unknown){
  const run=++epoch.current;setBusy(true);setNotice('');
  try{await api(path,body);if(run!==epoch.current)return;const result=await api();if(run!==epoch.current)return;
   setView(result);setForm(result.settings);setPending(null);setConfirmed(false);setStale(false);
   setNotice('配置已保存；实际应用仍以接待模式、下方平台服务状态和单独授权为准。保存配置或授权不等于开始自动回复。');
  }catch(e){if(run===epoch.current){setStale(true);setPending(null);setConfirmed(false);setNotice(e instanceof Error?e.message:personalizationMessages.personalization_result_uncertain);}}
  finally{if(run===epoch.current)setBusy(false);}
 }
 const disabled=busy||stale||!!pending;
 function save(event:FormEvent){event.preventDefault();if(!form||disabled)return;
  void mutate('/settings',{expectedRevision:form.revision,draftTone:form.draftTone,automaticTone:form.automaticTone,learnFromHuman:form.learnFromHuman,timing:form.timing});
 }
 const grant=(p:HistoryPurpose)=>view?.grants.find(g=>g.purpose===p);
 return <section className="mt-6 space-y-5" aria-label="接待语气与历史学习" data-layout-mutation-busy={busy||!!pending?'true':undefined}>
  <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">{section==='history'?'历史聊天用途授权':'接待语气与回复节奏'}</h2>
   <button type="button" className={button} disabled={busy} onClick={()=>{setNotice('');void refresh();}}>刷新语气与历史授权</button></div>
  {notice&&<p role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">{notice}</p>}
  {stale&&<p role="status" className="text-sm text-amber-800">{busy?'正在读取配置…':'状态未确认，请先刷新；暂不保存或授权。'}</p>}
  {view&&form&&<>
   <div hidden={section==='history'} className="space-y-5">
   <div className="rounded-xl bg-slate-50 p-4 text-sm" aria-label="语气与节奏平台服务状态">
    <p>自动草稿语气：{view.availability.draftTone?'平台已启用':'平台未启用'}</p>
    <p>自动接待语气：{view.availability.automaticTone?'平台已启用':'平台未启用'}</p>
    <p>按字数回复节奏：{view.availability.replyTiming?'平台已启用':'平台未启用'}</p>
    <p className="mt-2 text-xs text-[var(--ink-500)]">下方仅保存配置。已启用的服务仍需符合本企业接待模式、单独授权及回复校验条件；未启用的服务不会因保存配置而开始执行。</p>
   </div>
   <form onSubmit={save} className="space-y-4 rounded-2xl border border-[var(--border-subtle)] bg-white p-5">
    <fieldset disabled={disabled} className="space-y-4">
     <div className="grid gap-4 sm:grid-cols-2">{(['draftTone','automaticTone'] as const).map(key=><label key={key} className="space-y-2 text-sm">
      <span className="block">{key==='draftTone'?'自动草稿语气':'自动接待语气'}</span><select className={field+' w-full'} value={form[key]} onChange={e=>setForm({...form,[key]:e.target.value})}>
       {tones.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>)}</div>
     <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.learnFromHuman} disabled={!grant('style')?.enabled}
      onChange={e=>setForm({...form,learnFromHuman:e.target.checked})}/>参考本企业常见人工语气（需先完成下方单独授权）</label>
     <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.timing.enabled} onChange={e=>setForm({...form,timing:{...form.timing,enabled:e.target.checked}})}/>开启按字数渐增的自动回复节奏</label>
     <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm">延迟下限（秒）<input className={field+' mt-2 w-full'} type="number" min="1" max="119" step="1" required value={form.timing.minimumSeconds}
      onChange={e=>setForm({...form,timing:{...form.timing,minimumSeconds:Number(e.target.value)}})}/></label>
      <label className="text-sm">延迟上限（秒）<input className={field+' mt-2 w-full'} type="number" min={form.timing.minimumSeconds+1} max="120" step="1" required value={form.timing.maximumSeconds}
       onChange={e=>setForm({...form,timing:{...form.timing,maximumSeconds:Number(e.target.value)}})}/></label></div>
     <p className="text-xs leading-5 text-[var(--ink-500)]">默认1–30秒，从收到新问题起算；字数越多越接近上限，但不会到达上限。模型、队列及渠道耗时可能导致实际收到更晚。人工发送和团队可见草稿不等待；语气不会补充未经核实的承诺。</p>
     <button type="submit" className={button+' bg-blue-600 text-white'}>保存语气与节奏</button>
    </fieldset>
   </form>
   <section className="rounded-2xl border border-[var(--border-subtle)] bg-white p-5" aria-label="用户端AI标识">
    <h2 className="text-lg font-semibold">用户端 AI 标识</h2>
    {view.publicLabel?<>
     <p className="mt-2 text-sm">当前展示：{view.publicLabel.effective?'开启':'关闭'}；平台默认：{view.publicLabel.platformDefault?'开启':'关闭'}。</p>
     <label className="mt-3 block text-sm">微信公众号与网站聊天
      <select className={field+' ml-3'} disabled={disabled} value={view.publicLabel.override===null?'default':String(view.publicLabel.override)}
       onChange={e=>void mutate('/public-label',{expectedRevision:view.publicLabel!.revision,override:e.target.value==='default'?null:e.target.value==='true'})}>
       <option value="default">跟随平台默认</option><option value="true">开启标识</option><option value="false">关闭标识</option>
      </select></label>
     <p className="mt-3 text-xs leading-5 text-[var(--ink-500)]">适用于保存后新发送的自动接待消息；微信已送达消息的标识不能撤回修改。客服工作台仍显示“答巢自动接待”，内部来源及审计记录不受影响。请依据适用规则履行生成内容告知义务；此设置不授予发送权限。</p>
    </>:<p className="mt-2 text-sm text-[var(--ink-500)]">标识设置服务尚未启用。</p>}
   </section>
   </div><div hidden={section==='style'} className="space-y-5">
   <h2 className="text-lg font-semibold">历史聊天用途授权</h2>
   {!view.availability.history&&<p className="text-sm text-amber-800">历史读取与后台学习服务暂未启用。保存授权不代表已开始读取或调用模型。</p>}
   {purposes.map(p=><section key={p} className="rounded-2xl border border-[var(--border-subtle)] bg-white p-5">
    <h3 className="font-semibold">{historyPurposeLabels[p]}</h3><p className="mt-2 text-sm leading-6">{view.disclosures[p].text}</p>
    <p className="mt-3 text-sm">当前授权：{grant(p)?.enabled?'已保存':'未授权'}</p>
    <div className="mt-3 flex flex-wrap gap-3"><button type="button" className={button} disabled={disabled} onClick={()=>{setPending(p);setConfirmed(false);setNotice('');}}>{grant(p)?.enabled?'重新阅读并确认':'阅读并授权'}</button>
     {grant(p)?.enabled&&<button type="button" className={button} disabled={disabled} onClick={()=>void mutate('/history-grant',{purpose:p,enabled:false,expectedRevision:grant(p)!.revision})}>撤销{historyPurposeLabels[p]}授权</button>}</div>
    {p==='knowledgeDraft'&&<ReceptionHistoryJobs key={workspaceId} workspaceId={workspaceId} authorized={!!grant(p)?.enabled}/>}
   </section>)}
   </div>
   {pending&&<section aria-labelledby="history-confirmation-heading" className="rounded-2xl border border-blue-300 bg-blue-50 p-5">
    <h3 id="history-confirmation-heading" ref={heading} tabIndex={-1} className="font-semibold">确认{historyPurposeLabels[pending]}授权</h3>
    <p className="mt-2 text-sm leading-6">{view.disclosures[pending].text}</p><label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/>我已阅读并仅授权上述历史用途，不包含知识自动发布或营销群发。</label>
    <div className="mt-4 flex gap-3"><button type="button" className={button} disabled={busy} onClick={()=>{setPending(null);setConfirmed(false);}}>取消</button>
     <button type="button" className={button+' bg-blue-600 text-white'} disabled={busy||!confirmed} onClick={()=>void mutate('/history-grant',{
      purpose:pending,enabled:true,expectedRevision:grant(pending)?.revision??'0',confirmed:true,disclosureVersion:view.disclosures[pending].version})}>确认保存本项授权</button></div>
   </section>}
  </>}
 </section>;
}
