'use client';
import {useEffect,useRef,useState} from 'react';
import {parseInsightsProfiles,parseInsightsTopics,type InsightsProfiles,type InsightsTopics} from '../lib/customer-insights';
import {piePath,profilePie,topicPie,type InsightPieSlice} from '../lib/customer-insights-charts';

type ChartData={workspace:string;topics:InsightsTopics;profiles:InsightsProfiles};
/** Two bounded saved-result aggregates; never reads chats, grants or model endpoints. */
export function CustomerInsightsDashboard({workspaceId,canManage,locale='zh-CN'}:{workspaceId:string;canManage:boolean;locale?:string}){
 const en=locale==='en',[data,setData]=useState<ChartData|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[chart,setChart]=useState(0);
 const pending=useRef<AbortController|null>(null),scope=useRef(workspaceId);scope.current=workspaceId;
 async function load(){
  if(pending.current)return;
  const current=workspaceId,controller=new AbortController();pending.current=controller;setBusy(true);setError('');
  const timer=setTimeout(()=>controller.abort(),10000);
  try{
   async function get(path:'topics'|'profiles'){
    const response=await fetch('/api/customer-insights/'+path,{method:'GET',headers:{'x-replynest-workspace':current},cache:'no-store',redirect:'error',signal:controller.signal});
    if(!response.ok)throw Error('aggregate_unavailable');return (await response.json()).data;
   }
   const [topics,profiles]=await Promise.all([get('topics'),get('profiles')]);
   const parsed={workspace:current,topics:parseInsightsTopics(topics),profiles:parseInsightsProfiles(profiles)};
   if(scope.current===current&&pending.current===controller)setData(parsed);
  }catch{if(scope.current===current&&pending.current===controller)setError(en?'Charts are temporarily unavailable. Please try refreshing.':'图表暂时无法加载，请稍后刷新。');
  }finally{clearTimeout(timer);if(pending.current===controller){pending.current=null;setBusy(false);}}
 }
 useEffect(()=>{setData(null);setBusy(false);setError('');void load();return()=>{pending.current?.abort();pending.current=null;};},[workspaceId]);
 const current=data?.workspace===workspaceId?data:null;
 return <section id="customer-insights" aria-label={en?'Customer AI notes and insights':'客户 AI 备注与问题画像'} className="scroll-mt-6 rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-white p-5 shadow-[var(--shadow-card)] md:p-6">
  <div className="flex flex-wrap items-start justify-between gap-3">
   <div><h2 className="text-lg font-semibold">{en?'Customer insights':'客户画像与咨询分析'}</h2><p className="mt-1 text-sm leading-6 text-[var(--ink-500)]">{en?'Last 7 days · Saved AI notes only. Viewing does not use AI points.':'近 7 天 · 仅汇总已生成的 AI 备注，查看不扣 AI 点数。'}</p></div>
   <div className="flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={()=>void load()} className="rounded-xl border border-[var(--border-subtle)] px-3 py-2 text-sm disabled:opacity-50">{busy?(en?'Loading…':'正在加载…'):(en?'Refresh charts':'刷新图表')}</button>
    {canManage?<a href="/settings/automatic-reception#customer-insights" className="rounded-xl bg-[var(--brand-600)] px-3 py-2 text-sm font-medium text-white">{en?'Authorization and settings':'授权与设置'}</a>:<p className="self-center text-xs text-[var(--ink-500)]">{en?'Ask your administrator to enable generation.':'生成授权由企业管理员设置'}</p>}
   </div>
  </div>
  {error&&<p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
  {current?<>
   <div className="mt-4 flex flex-wrap gap-2 lg:hidden" aria-label={en?'Choose insight chart':'选择画像图表'}>{(en?['Topics','Needs','Preferences']:['咨询主题','咨询需求','服务偏好']).map((label,index)=><button key={label} type="button" aria-pressed={chart===index} onClick={()=>setChart(index)} className={`rounded-lg border px-3 py-2 text-xs ${chart===index?'border-blue-200 bg-blue-50 text-blue-700':'border-[var(--border-subtle)]'}`}>{label}</button>)}</div>
   <div className="mt-5 grid gap-4 lg:grid-cols-3">
    <div className={chart===0?'min-w-0':'hidden min-w-0 lg:block'}>
    <InsightPie title={en?'Consultation topics':'咨询主题'} slices={topicPie(current.topics,en)} countNote={en?`${current.topics.total} customers with saved results`:`已生成问题画像：${current.topics.total} 位客户`} empty={en?'No saved consultation topics yet.':'暂无已生成的咨询主题'} en={en}/>
    </div><div className={chart===1?'min-w-0':'hidden min-w-0 lg:block'}>
    <InsightPie title={en?'Explicit needs':'明确咨询需求'} slices={profilePie(current.profiles,false,en)} countNote={en?'Share of need-category counts':'按需求类别计数占比'} empty={en?'No classified needs yet.':'暂无已归类的咨询需求'} multi en={en}/>
    </div><div className={chart===2?'min-w-0':'hidden min-w-0 lg:block'}>
    <InsightPie title={en?'Service preferences':'明确服务偏好'} slices={profilePie(current.profiles,true,en)} countNote={en?'Share of preference-category counts':'按偏好类别计数占比'} empty={en?'No classified preferences yet.':'暂无已归类的服务偏好'} multi en={en}/>
    </div>
   </div>
   <p className="mt-4 text-xs leading-5 text-[var(--ink-500)]">{en?`Coverage: ${current.profiles.total} customers with saved notes; ${current.profiles.classified} classified, ${current.profiles.unclassified} unclassified. Topics use each customer's latest result. Needs/preferences may overlap: pie areas show category-count share, not customer share. Charts do not represent all customers.`:`备注覆盖 ${current.profiles.total} 位客户，其中已归类 ${current.profiles.classified} 位、未分类 ${current.profiles.unclassified} 位。咨询主题按每位客户的最新结果统计；需求和偏好可多选，饼图显示各类别计数占比，不是客户人数占比。未生成备注的客户不纳入统计。`}</p>
  </>:!error&&<div className="mt-5 rounded-xl bg-[var(--surface-canvas)] p-6 text-sm text-[var(--ink-500)]" role="status">{en?'Loading saved insights…':'正在读取已有画像统计…'}</div>}
  <p className="mt-3 text-xs leading-5 text-[var(--ink-500)]">{en?'Generation is off by default and requires separate administrator consent and a daily budget. Stopping generation preserves saved results; this page never enables it.':'画像生成默认关闭，需管理员单独授权并设置每日预算；停止生成后仍可查看已有结果。本页不会自动开启生成。'}</p>
 </section>;
}

export function InsightPie({title,slices,countNote,empty,multi=false,en=false}:{title:string;slices:InsightPieSlice[];countNote:string;empty:string;multi?:boolean;en?:boolean}){
 let start=0;
 return <article className="min-w-0 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-canvas)] p-4">
  <h3 className="text-sm font-semibold">{title}</h3><p className="mt-1 text-xs text-[var(--ink-500)]">{countNote}</p>
  {slices.length?<><svg viewBox="0 0 200 200" role="img" aria-label={`${title} · ${slices.map(s=>`${s.label} ${s.share.toFixed(1)}%`).join('，')}`} className="mx-auto my-3 block w-full max-w-[190px]">
   {slices.map(slice=>{const path=piePath(start,slice.share);start+=slice.share;const detail=`${slice.label}：${slice.count} ${en?'customers':'位'} · ${slice.share.toFixed(1)}%${multi?` · ${en?'customer coverage':'客户覆盖'} ${slice.coverage.toFixed(1)}%`:''}`;
    return <path key={slice.key} d={path} fill={slice.color} stroke="white" strokeWidth={slices.length>1?1.5:0} tabIndex={0} aria-label={detail} className="transition-opacity hover:opacity-75 focus:opacity-75"><title>{detail}</title></path>;
   })}
  </svg><ul className="space-y-2">{slices.map(s=><li key={s.key} className="flex items-start justify-between gap-2 text-xs" title={multi?`${en?'Customer coverage':'客户覆盖率'} ${s.coverage.toFixed(1)}%`:undefined}>
   <span className="flex min-w-0 items-start gap-2"><span className="mt-0.5 size-2.5 shrink-0 rounded-full" style={{backgroundColor:s.color}}/><span>{s.label}</span></span>
   <span className="shrink-0 tabular-nums">{s.count} {en?'customers':'位'} · {s.share.toFixed(1)}%</span>
  </li>)}</ul></>:<div className="flex min-h-[240px] flex-col items-center justify-center gap-4 text-center"><div aria-hidden="true" className="size-28 rounded-full border-[18px] border-[var(--border-subtle)]"/><p className="text-xs text-[var(--ink-500)]">{empty}</p></div>}
 </article>;
}
