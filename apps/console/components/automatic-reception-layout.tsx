'use client';
import {useEffect,useId,useRef,useState} from 'react';
import {AutomaticReceptionManagement} from './automatic-reception-management';
import {ReceptionPersonalization} from './reception-personalization';
import {CustomerInsightsSettings} from './customer-insights-settings';
const choices=[['sending','发送授权'],['style','语气与节奏'],['history','历史用途'],['customer-insights','客户画像与预算']] as const;
type Section=typeof choices[number][0];
/** Retain one instance of each editor: changing sections cannot lose an in-flight result. */
export function AutomaticReceptionLayout({workspaceId,personalization,insights}:{workspaceId:string;personalization:boolean;insights:boolean}) {
 const [section,setSection]=useState<Section>('sending'),[notice,setNotice]=useState('');
 const root=useRef<HTMLDivElement>(null),id=useId();
 const tabs=choices.filter(([key])=>key==='sending'||key==='customer-insights'?key==='sending'||insights:personalization);
 useEffect(()=>{const sync=()=>{const key=location.hash.slice(1);if(tabs.some(([value])=>value===key))setSection(key as Section);};sync();window.addEventListener('hashchange',sync);return()=>window.removeEventListener('hashchange',sync);},[personalization,insights]);
 function select(next:Section){
  if(root.current?.querySelector('[data-layout-mutation-busy="true"]')){setNotice('当前操作尚未确认，请等待结果或取消确认后再切换。');return;}
  setNotice('');setSection(next);history.replaceState(null,'','#'+next);
 }
 return <div ref={root} className="mt-5">
  <div className="flex flex-wrap gap-2 rounded-xl border border-[var(--border-subtle)] bg-white p-2" aria-label="AI 接待设置分区">{tabs.map(([key,label])=><button key={key} type="button" aria-pressed={section===key} aria-controls={`${id}-${key==='style'||key==='history'?'personalization':key}`} onClick={()=>select(key)} className={`rounded-lg px-4 py-2.5 text-sm font-medium ${section===key?'bg-blue-50 text-blue-700':'text-[var(--ink-700)] hover:bg-slate-50'}`}>{label}</button>)}</div>
  {notice&&<p role="status" className="mt-3 text-sm text-amber-800">{notice}</p>}
  <div id={`${id}-sending`} hidden={section!=='sending'}><p className="mt-4 text-sm text-[var(--ink-500)]">接待模式在企业设置中管理；此处按渠道分别核对发送授权。</p><a className="mt-2 inline-block text-sm text-blue-700" href="/settings/communications">查看接待模式 →</a><AutomaticReceptionManagement workspaceId={workspaceId}/></div>
  {personalization&&<div id={`${id}-personalization`} hidden={section!=='style'&&section!=='history'}><ReceptionPersonalization workspaceId={workspaceId} section={section==='history'?'history':'style'}/></div>}
  {insights&&<div id={`${id}-customer-insights`} hidden={section!=='customer-insights'}><CustomerInsightsSettings workspaceId={workspaceId}/></div>}
 </div>;
}
