'use client';
import {useEffect,useState,type CSSProperties} from 'react';
import type {Definition} from './extension-builder';
import { ArrowLeft, Headphones, Monitor, Moon, Sun } from "lucide-react";
import { BrandLogo } from "./brand-logo";
import { ConsoleLocaleSwitch } from "./console-locale-switch";
import { consoleText, type ConsoleLocale } from "../lib/console-i18n";
import {useWorkbenchTheme} from '../lib/workbench-theme';

export function WorkbenchShell({ locale, workspaceName, preferenceKey, children }: { locale: ConsoleLocale; workspaceName: string; preferenceKey: string; children: React.ReactNode }) {
  const copy = consoleText(locale);
  const en = locale === "en";
  const appearance=useWorkbenchTheme(preferenceKey);
  const [layouts,setLayouts]=useState<{extension_id:string;definition:Definition}[]>([]),[chosen,setChosen]=useState('');
  useEffect(()=>{const controller=new AbortController();fetch('/api/workbench-extensions',{cache:'no-store',signal:controller.signal}).then(r=>r.ok?r.json():{data:[]}).then(r=>{const available=r.data.filter((a:{definition:Definition})=>a.definition.workbench);setLayouts(available);try{const saved=localStorage.getItem(preferenceKey);setChosen(saved&&available.some((a:{extension_id:string})=>a.extension_id===saved)?saved:'');}catch{}}).catch(()=>{});return()=>controller.abort();},[preferenceKey]);
  function choose(value:string){setChosen(value);try{localStorage.setItem(preferenceKey,value);}catch{}}
  const config=layouts.find(a=>a.extension_id===chosen)?.definition.workbench;
  const colors={blue:['#2196ff','#006bd6'],emerald:['#059669','#047857'],violet:['#7c3aed','#6d28d9']};const color=colors[config?.theme??'blue'];
  return <div lang={en ? "en" : "zh-CN"} data-color-scheme={appearance.scheme} data-theme-preference={appearance.preference} data-theme-ready={appearance.ready} data-density={config?.density??'comfortable'} data-tools={config?.tools_position??'before_profile'} style={{'--studio-list':`${config?.list_width??320}px`,'--studio-details':`${config?.details_width??280}px`,'--brand-500':color[0],'--brand-700':color[1],'--studio-action-bg':color[1]} as CSSProperties} className="studio-workbench fixed inset-0 flex min-w-0 flex-col overflow-hidden bg-[var(--surface-app)] text-[var(--ink-900)]">
    <style>{`@media(min-width:1024px){.studio-workbench .studio-grid{grid-template-columns:var(--studio-list) minmax(0,1fr)}}@media(min-width:1280px){.studio-workbench .studio-grid{grid-template-columns:var(--studio-list) minmax(0,1fr) var(--studio-details)}}.studio-workbench[data-density=compact] .studio-conversation{padding:8px 12px}.studio-details-content{display:flex;flex-direction:column}.studio-workbench[data-tools=after_profile] .studio-tools{order:2}`}</style>
    <header className="z-20 flex h-12 md:h-16 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] bg-white px-3 md:px-6">
      <div className="flex min-w-0 items-center gap-3"><div className="studio-brand shrink-0 rounded-lg"><BrandLogo href="/" priority className="[transform:translateZ(0)]"/></div><span className="hidden h-7 w-px bg-[var(--border-subtle)] sm:block"/><div className="hidden min-w-0 sm:block"><p className="flex items-center gap-2 truncate text-sm font-semibold"><Headphones size={16}/>{config?.title??(en ? "Support workspace" : "客服工作台")}</p><p className="truncate text-[11px] text-[var(--ink-500)]">{workspaceName}</p></div></div>
      <div className="flex shrink-0 items-center gap-1 sm:gap-2"><div role="group" aria-label={en?'Workspace color scheme':'工作台配色'} className="inline-flex rounded-lg border border-[var(--border-subtle)] p-0.5">
       {([['light',Sun,en?'Light':'明亮'],['dark',Moon,en?'Dark':'暗黑'],['system',Monitor,en?'System':'跟随系统']] as const).map(([value,Icon,label])=><button key={value} type="button" aria-label={label} title={label} aria-pressed={appearance.preference===value} disabled={!appearance.ready} onClick={()=>appearance.choose(value)} className={`grid size-7 place-items-center rounded-md transition disabled:opacity-50 ${appearance.preference===value?'bg-blue-50 text-[var(--brand-700)]':'text-[var(--ink-500)] hover:bg-slate-100'}`}><Icon size={15}/></button>)}
      </div><ConsoleLocaleSwitch locale={locale} label={copy.language} compact/><a href="/" className="inline-flex items-center gap-2 rounded-xl border border-[var(--border-subtle)] px-2 sm:px-3 py-2 text-xs font-semibold hover:bg-slate-50"><ArrowLeft size={15}/><span className="hidden sm:inline">{en ? "Operations console" : "运营控制台"}</span></a></div>
    </header>
    {layouts.length>0&&<div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-white px-3 py-1 text-xs"><label htmlFor="studio-workbench-style">{en?'Workspace style':'工作台样式'}</label><select id="studio-workbench-style" className="max-w-60 rounded border px-2 py-1" value={chosen} onChange={e=>choose(e.target.value)}><option value="">{en?'ReplyNest default':'答巢默认工作台'}</option>{layouts.map(a=><option key={a.extension_id} value={a.extension_id}>{a.definition.workbench!.title}</option>)}</select>{config&&<button onClick={()=>choose('')} className="text-blue-700">恢复默认</button>}<span className="text-slate-500">仅改变外观与布局，不改变权限及发送规则</span></div>}
    <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
  </div>;
}
