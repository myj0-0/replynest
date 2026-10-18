'use client';
import {useEffect,useId,useRef,useState,type ReactNode} from 'react';
type Panel={id:string;label:string;content:ReactNode};
/** Keeps edits mounted; section navigation never submits, fetches or grants access. */
export function ConsoleContentTabs({panels,label,en=false,defaultId}:{panels:Panel[];label:string;en?:boolean;defaultId?:string}) {
 const [active,setActive]=useState(defaultId&&panels.some(p=>p.id===defaultId)?defaultId:panels[0]?.id),[notice,setNotice]=useState('');const root=useRef<HTMLDivElement>(null),prefix=useId();
 useEffect(()=>{const sync=()=>{const id=location.hash.slice(1);if(panels.some(p=>p.id===id))setActive(id);};sync();window.addEventListener('hashchange',sync);return()=>window.removeEventListener('hashchange',sync);},[panels.map(p=>p.id).join('|')]);
 function select(id:string){if(root.current?.querySelector('[data-layout-mutation-busy="true"]')){setNotice(en?'Wait for the current operation before switching.':'请等待当前操作完成或取消确认后再切换。');return false;}setNotice('');setActive(id);history.replaceState(null,'','#'+id);return true;}
 return <div ref={root} className="mt-5">
  <div role="tablist" aria-label={label} className="flex flex-wrap gap-2 rounded-xl border border-[var(--border-subtle)] bg-white p-2">{panels.map((p,index)=><button key={p.id} type="button" role="tab" id={`${prefix}-tab-${p.id}`} aria-controls={`${prefix}-panel-${p.id}`} aria-selected={active===p.id} tabIndex={active===p.id?0:-1} onClick={()=>select(p.id)} onKeyDown={event=>{const delta=event.key==='ArrowRight'?1:event.key==='ArrowLeft'?-1:0;if(!delta&&event.key!=='Home'&&event.key!=='End')return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?panels.length-1:(index+delta+panels.length)%panels.length;if(select(panels[next].id))root.current?.querySelector<HTMLButtonElement>(`[role="tab"][aria-controls="${prefix}-panel-${panels[next].id}"]`)?.focus();}} className={`rounded-lg px-4 py-2.5 text-sm font-medium ${active===p.id?'bg-blue-50 text-blue-700':'text-[var(--ink-700)] hover:bg-slate-50'}`}>{p.label}</button>)}</div>
  {notice&&<p role="status" className="mt-3 text-sm text-amber-800">{notice}</p>}
  {panels.map(p=><div key={p.id} role="tabpanel" tabIndex={0} aria-labelledby={`${prefix}-tab-${p.id}`} id={`${prefix}-panel-${p.id}`} hidden={active!==p.id}>{p.content}</div>)}
 </div>;
}
