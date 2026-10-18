'use client';
import {useEffect,useState} from 'react';
type Tenant={tenant_id:string;name:string;plan_code:string|null;status:string};
export function AdminTenantPicker(){
 const [query,setQuery]=useState(''),[page,setPage]=useState(1),[items,setItems]=useState<Tenant[]>([]),[selected,setSelected]=useState(''),[busy,setBusy]=useState(true),[error,setError]=useState(false),[more,setMore]=useState(false),[retry,setRetry]=useState(0);
 useEffect(()=>{const controller=new AbortController();const timer=setTimeout(async()=>{
  try{const response=await fetch(`/api/platform-admin/tenant-search?q=${encodeURIComponent(query)}&page=${page}`,{signal:controller.signal,cache:'no-store'});if(!response.ok)throw Error();const data=await response.json();if(controller.signal.aborted)return;setItems(data.items);setMore(data.has_more);setBusy(false);}
  catch{if(!controller.signal.aborted){setError(true);setBusy(false);}}
 },250);return()=>{clearTimeout(timer);controller.abort();};},[query,page,retry]);
 function change(q:string,p:number){setQuery(q);setPage(p);setSelected('');setItems([]);setBusy(true);setError(false);setMore(false);}
 return <div className="space-y-2 md:col-span-2"><label className="block text-xs text-slate-600">搜索租户<input type="search" value={query} maxLength={100} onChange={e=>change(e.target.value,1)} onKeyDown={e=>{if(e.key==='Enter')e.preventDefault();}} placeholder="企业名称、租户 ID、成员邮箱或手机号" className="mt-1 w-full rounded-xl border p-3 text-sm"/></label>
 <label className="block text-xs text-slate-600">选择租户<select name="tenant_id" value={selected} onChange={e=>setSelected(e.target.value)} required aria-busy={busy} className="mt-1 w-full rounded-xl border p-3 text-sm"><option value="">{busy?'正在搜索…':error?'搜索失败':items.length?'请选择搜索结果':'没有匹配的租户'}</option>{items.map(t=><option key={t.tenant_id} value={t.tenant_id}>{t.name} · {t.tenant_id} · {t.plan_code??'未开通'}</option>)}</select></label>
 <div className="flex items-center gap-3 text-xs text-slate-500" aria-live="polite">{error?<><span role="alert">暂时无法查询租户。</span><button type="button" onClick={()=>{change(query,page);setRetry(v=>v+1);}}>重试</button></>:<><span>第 {page} 页 · 每页最多 20 家</span><button type="button" disabled={busy||page===1} onClick={()=>change(query,page-1)} className="disabled:opacity-40">上一页</button><button type="button" disabled={busy||!more} onClick={()=>change(query,page+1)} className="disabled:opacity-40">下一页</button></>}</div></div>;
}
