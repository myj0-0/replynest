'use client';
import { useEffect, useState } from 'react';

export function AutomationPreviewPanel({definition,capabilityVersion,onSaveRule}:{definition:unknown;capabilityVersion:string;onSaveRule?:(value:unknown)=>void}) {
  const [json,setJson]=useState('');
  const [samples,setSamples]=useState(JSON.stringify([{id:'示例-1',text:'我想申请退款',status:'open',assignee_ref:null},{id:'示例-2',text:'咨询商品',status:'open',assignee_ref:'客服C'}],null,2));
  const [instant,setInstant]=useState('2026-09-27T16:00:00Z');
  const [result,setResult]=useState<null|{planned_count:number;executed:boolean;warning:string;results:{sample_id:string;reason:string;target:string|null}[];next_runs:{at:string;assignee_ref:string}[]}>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [semanticConfirmed,setSemanticConfirmed]=useState(false);
  const semantic=(()=>{try{return Boolean(JSON.parse(json).semantic);}catch{return false;}})();
  useEffect(()=>{setJson(JSON.stringify(definition,null,2));setResult(null);setError('');setSemanticConfirmed(false);},[definition]);
  const reasons:Record<string,string>={would_assign:'计划转派（未执行）',not_scheduled_now:'当前不在计划时间',status_excluded:'会话状态不在范围',keyword_not_matched:'未命中关键词',semantic_not_matched:'意图不匹配或置信度不足',semantic_requires_ai:'需要授权 AI 识别',already_assigned:'已由目标客服负责',preserve_manual_assignment:'保留已有负责人',action_limit:'达到本次处理上限'};
  async function simulate(){if(busy)return;setBusy(true);setError('');setResult(null);try{
    const response=await fetch('/api/extensions/automation-preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({definition:JSON.parse(json),samples:JSON.parse(samples),instant,capability_version:capabilityVersion,semantic_confirmed:semanticConfirmed})});const body=await response.json();
    if(!response.ok)throw Error(body.error?.code==='forbidden'?'当前账号无模拟权限。':body.error?.code==='capability_version_mismatch'?'能力版本已更新，请刷新页面。':'规则或样本不符合当前能力。请检查星期、时间、会话状态和字段格式。');setResult(body.data);
  }catch(e){setError(e instanceof SyntaxError?'JSON 格式不正确。':e instanceof Error?e.message:'模拟失败，请重试。');}finally{setBusy(false);}}
  return <section data-layout-mutation-busy={busy||semanticConfirmed} className="my-5 rounded-2xl border border-amber-200 bg-white p-5" aria-label="自动化规则模拟">
    <h2 className="font-semibold">排班预览 · 授权后可启用定时转派</h2>
    <p className="mt-2 text-sm leading-6 text-slate-600">先用样本预览轮班、关键词或 AI 语义分流，不读取或转派真实会话。保存、绑定坐席并授权后，可单次执行完整计划；按周规则还可授权定时执行。关键词是文字匹配；语义识别会调用 AI 并消耗点数。</p>
    <p className="mt-2 text-xs text-slate-500">时区固定 Asia/Shanghai，星期 1–7 为周一至周日；max_actions 限制每次数量，overwrite_assigned=false 保留已有负责人。每天执行可填写星期 1–7；不同日期可绑定不同客服。AI 只生成草稿，不代替发布授权。</p>
    <div className="mt-4 grid gap-4 lg:grid-cols-2"><label className="text-sm">规则 JSON<textarea className="mt-2 min-h-64 w-full rounded-xl border p-3 font-mono text-xs" value={json} disabled={busy} maxLength={16000} onChange={e=>{setJson(e.target.value);setResult(null);setSemanticConfirmed(false);}}/></label><label className="text-sm">合成会话样本 JSON<textarea className="mt-2 min-h-64 w-full rounded-xl border p-3 font-mono text-xs" value={samples} disabled={busy} maxLength={12000} onChange={e=>{setSamples(e.target.value);setResult(null);setSemanticConfirmed(false);}}/></label></div>
    <label className="mt-3 block text-sm">模拟时刻（UTC ISO，例如北京时间周一零点为前一天 16:00Z）<input className="mt-2 w-full rounded-xl border p-3 text-sm" value={instant} disabled={busy} onChange={e=>{setInstant(e.target.value);setResult(null);}}/></label>
    {semantic&&<label className="mt-3 flex gap-2 text-sm"><input type="checkbox" checked={semanticConfirmed} disabled={busy} onChange={e=>setSemanticConfirmed(e.target.checked)}/>同意将本次最多 10 条样本文本交给 AI 识别业务意图，并按实际用量扣 AI 点数；不转派真实会话。</label>}
    <button type="button" className="mt-3 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={busy||(semantic&&!semanticConfirmed)} onClick={()=>void simulate()}>{busy?'预览中…':'运行样本预览（不执行转派）'}</button>
    {onSaveRule&&<button type="button" className="ml-2 mt-3 rounded-xl border px-4 py-2 text-sm disabled:opacity-40" disabled={busy||!result} onClick={()=>{try{onSaveRule(JSON.parse(json));}catch{setError('请先修正 JSON 并重新模拟。');}}}>保存为持久规则（需绑定坐席）</button>}
    {error&&<p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    {result&&<div className="mt-4 space-y-3 text-sm" role="status"><p className="font-semibold">计划影响 {result.planned_count} 条样本；实际执行 0 次。</p><p>{result.warning}</p><ul className="space-y-2">{result.results.map(r=><li key={r.sample_id} className="rounded-lg bg-slate-50 p-2">{r.sample_id}：{reasons[r.reason]??r.reason}{r.target?` → ${r.target}`:''}</li>)}</ul>{result.next_runs.length>0&&<><h3 className="font-medium">接下来 7 个计划时刻（北京时间，仅预览）</h3><ul>{result.next_runs.map(r=><li key={r.at}>{new Date(r.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})} → {r.assignee_ref}</li>)}</ul></>}</div>}
  </section>;
}
