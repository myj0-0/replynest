'use client';
import {useState, type ReactNode} from 'react';
import {privacyTerminalStatuses} from '../lib/page-list-filter';

/** All rows belong to the already fetched page. No token, network access or global status counts. */
export function PrivacyHistoryFilter({items,en}:{items:{id:string;status:string;content:ReactNode}[];en:boolean}) {
  const [view,setView]=useState<'all'|'pending'|'closed'>('all');
  const filtered=items.filter(item=>view==='all'||((view==='closed')===privacyTerminalStatuses.has(item.status)));
  const pending=items.filter(item=>!privacyTerminalStatuses.has(item.status)).length;
  return <div className="mt-3">
    <div aria-label={en?'Filter this page':'筛选本页申请'} className="flex flex-wrap gap-2">{([
      ['all',en?'All on this page':'本页全部',items.length],['pending',en?'In progress on this page':'本页处理中',pending],['closed',en?'Closed on this page':'本页已结束',items.length-pending]
    ] as const).map(([key,title,count])=><button key={key} type="button" aria-pressed={view===key} onClick={()=>setView(key)} className={`rounded-lg border px-3 py-2 text-sm ${view===key?'border-blue-200 bg-blue-50 text-blue-700':'bg-white'}`}>{title} · {count}</button>)}</div>
    <p className="mt-2 text-xs text-slate-500">{en?'Counts cover only this loaded page. Use pagination for earlier requests.':'数量仅对应已加载的本页，不是全部历史总数；更早申请请翻页。'}</p>
    <div className="mt-3 divide-y">{filtered.map(item=><div key={item.id}>{item.content}</div>)}</div>
    {!filtered.length&&<p role="status" className="py-6 text-center text-sm text-slate-500">{en?'No matching requests on this page.':'本页暂无符合此状态的申请。'}</p>}
  </div>;
}
