'use client';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {readAttemptHeader,safeReadTiming} from '../lib/workbench-read-diagnostics';
type Count={tenantId:string;conversationId:string;count:number;capped:boolean};
const eventName='replynest-workbench-read';
export function UnreadBadge({tenantId,conversationId,count,capped=false,available=true,en}:{tenantId:string;conversationId:string;count:number;capped?:boolean;available?:boolean;en:boolean}){
 const [receipt,setReceipt]=useState<Count|null>(null);
 useEffect(()=>{setReceipt(null);const changed=(event:Event)=>{const value=(event as CustomEvent<Count>).detail;
  if(value?.tenantId===tenantId&&value.conversationId===conversationId)setReceipt(value);
 };window.addEventListener(eventName,changed);return()=>window.removeEventListener(eventName,changed);},[tenantId,conversationId,count,capped,available]);
 const value=receipt?.count??count,ready=!!receipt||available;
 if(!ready)return <span className="text-[10px] text-slate-500" title={en?'Unread count unavailable':'未读数暂不可用'}>—</span>;
 if(value<=0)return null;
 return <span className="rounded-full bg-[var(--brand-500)] px-2 py-0.5 text-[10px] font-semibold text-white" title={en?'Unread customer messages · shared by team':'未读客户消息 · 团队共享'}>{receipt?.capped??capped?'1000+':value}</span>;
}
export function WorkbenchReadReceipt({tenantId,conversationId,enabled,en,children}:{tenantId:string;conversationId:string;enabled:boolean;en:boolean;children:ReactNode}){
 const root=useRef<HTMLDivElement>(null),confirmedIds=useRef(new Set<string>()),scope=useRef('');const [error,setError]=useState(false),[retry,setRetry]=useState(0);
 const [diagnostic,setDiagnostic]=useState<{attempt:string;elapsed:number;kind:string;timing:string}|null>(null);
 useEffect(()=>{
  if(!enabled||!root.current)return;
  const key=JSON.stringify([tenantId,conversationId]);if(scope.current!==key){scope.current=key;confirmedIds.current.clear();setError(false);setDiagnostic(null);}
  const scroll=root.current,items=Array.from(scroll.querySelectorAll<HTMLElement>('[data-incoming-message-id]')),visible=new Set<HTMLElement>();
  let disposed=false,busy=false,failed=false,timer:ReturnType<typeof setTimeout>|undefined;const controller=new AbortController();
  const acknowledge=async()=>{
   if(disposed||busy||failed||document.visibilityState!=='visible'||!document.hasFocus()||scroll.getClientRects().length===0)return;
   // Exact visible items; acknowledging one bubble never clears older unseen ones.
   const messageIds=items.filter(node=>{const rect=node.getBoundingClientRect();return visible.has(node)&&rect.bottom>0&&rect.top<window.innerHeight&&rect.right>0&&rect.left<window.innerWidth;})
    .map(node=>node.dataset.incomingMessageId!).filter(id=>id&&!confirmedIds.current.has(id)).slice(0,100);
   if(!messageIds.length)return;
   busy=true;setError(false);setDiagnostic(null);
   const attempt=crypto.randomUUID(),started=performance.now();let timing='',kind='response_invalid';
   let confirmed=false;
   try{const r=await fetch(`/api/conversations/${conversationId}/read`,{method:'POST',cache:'no-store',redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]),
    headers:{'content-type':'application/json','x-replynest-action':'workbench-read-v1','x-replynest-workspace':tenantId,[readAttemptHeader]:attempt},body:JSON.stringify({message_ids:messageIds})});
    timing=safeReadTiming(r.headers.get('server-timing'));if(!r.ok)kind=`http_${r.status}`;
    const value=(await r.json()).data;
    if(!r.ok||value?.conversation_id!==conversationId||!Number.isInteger(value.unread_count)||value.unread_count<0||value.unread_count>1000||typeof value.capped!=='boolean'||value.capped&&value.unread_count!==1000)throw Error();
    confirmed=true;if(!disposed){messageIds.forEach(id=>confirmedIds.current.add(id));window.dispatchEvent(new CustomEvent<Count>(eventName,{detail:{tenantId,conversationId,count:value.unread_count,capped:value.capped}}));}
   }catch(e){if(!disposed){failed=true;setError(true);const failure={attempt,elapsed:Math.round(performance.now()-started),kind:e instanceof Error&&e.name==='TimeoutError'?'browser_timeout':e instanceof Error&&e.name==='TypeError'?'network_or_connection':kind,timing};setDiagnostic(failure);console.warn('workbench_read_browser',failure);}}finally{busy=false;if(confirmed&&!disposed)schedule();}
  };
  const schedule=()=>{clearTimeout(timer);timer=setTimeout(()=>void acknowledge(),300);};
  const observer=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting&&entry.intersectionRatio>=0.25)visible.add(entry.target as HTMLElement);else visible.delete(entry.target as HTMLElement);}schedule();},{root:scroll,threshold:0.25});
  items.forEach(node=>observer.observe(node));document.addEventListener('visibilitychange',schedule);window.addEventListener('focus',schedule);
  return()=>{disposed=true;controller.abort();clearTimeout(timer);observer.disconnect();document.removeEventListener('visibilitychange',schedule);window.removeEventListener('focus',schedule);};
 },[tenantId,conversationId,enabled,retry,children]);
 return <div ref={root} className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">{children}{error&&<p role="status" className="mx-auto mt-3 max-w-3xl text-xs text-amber-800">{en?'Read receipt not confirmed; unread badge has not been cleared.':'未确认已读成功，未清除未读气泡。'} <button type="button" className="underline" onClick={()=>setRetry(n=>n+1)}>{en?'Retry':'重试'}</button>{diagnostic&&<span className="mt-1 block break-all">{en?'Diagnostic ID':'诊断编号'}：{diagnostic.attempt} · {diagnostic.elapsed} ms · {diagnostic.kind}{diagnostic.timing&&` · ${diagnostic.timing}`}</span>}</p>}</div>;
}
