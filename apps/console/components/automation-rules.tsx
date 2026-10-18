'use client';
import {useEffect,useState} from 'react';
type Rule={rule_id:string;name:string;revision:number;active_revision:number|null;enabled:boolean;next_run_at:string|null;schedule_grant_id:string|null};
type Definition={name:string;trigger:string;slots:{assignee_ref:string}[];assignee_ref:string;[key:string]:unknown};
type Run={run_id:string;state:string;scheduled_at:string;schedule_execution_state?:string;schedule_execution_code?:string;result:{planned_count?:number;scanned?:number;code?:string;items?:{conversation_id:string;reason:string;target_member_id:string|null}[]}};
const labels:Record<string,string>={forbidden:'无管理权限或登录状态已失效。',planning_disabled:'平台尚未启用计划调度，草稿可以保存。',rule_member_binding_required:'请将规则中的每个负责人绑定到真实坐席。',rule_member_unavailable:'目标坐席已停用或未同步，请重新选择。',version_conflict:'版本已变化，请重新打开规则。',rule_not_active:'请先授权发布计划。',plan_rate_limited:'每个企业每分钟最多请求一次计划，请稍后重试。',permission_confirmation_required:'请先阅读并确认权限。',invalid_automation_preview:'规则格式不正确。',invalid_definition:'规则包含不支持的字段。',rule_limit:'已达到 20 条规则上限。'};
async function api(path:string,body?:unknown){const r=await fetch(`/api/extensions/${path}`,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});const v=await r.json();if(!r.ok)throw Error(labels[v.error?.code]??'操作失败，请刷新后重试。');return v.data;}
const button='rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-40';
Object.assign(labels,{assignment_disabled:'实际转派暂不可用。',plan_not_executable:'只能执行仍有效的完整计划，请重新生成。',plan_expired:'计划已超过 5 分钟，请重新生成并核对。',plan_snapshot_required:'该计划缺少原子状态快照，请重新生成。',semantic_points_required:'语义分流需要启用 AI 点数计费。'});
Object.assign(labels,{schedule_execution_disabled:'平台定时转派暂不可用，可发布只读计划。',schedule_rule_unsupported:'定时执行需要按周规则，可用星期 1–7 配置每日运行。',schedule_authorization_revoked:'该任务的自动执行授权已失效。'});
export function AutomationRulesPanel({draft}:{draft:unknown}){
 const [rules,setRules]=useState<Rule[]>([]),[members,setMembers]=useState<{member_id:string;display_name:string}[]>([]),[permissions,setPermissions]=useState<string[]>([]),[enabled,setEnabled]=useState(false);
 const [definition,setDefinition]=useState<Definition|null>(null),[selected,setSelected]=useState<Rule|null>(null),[bindings,setBindings]=useState<Record<string,string>>({}),[runs,setRuns]=useState<Run[]>([]);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[confirmed,setConfirmed]=useState(false);
 const [executionEnabled,setExecutionEnabled]=useState(false),[execution,setExecution]=useState<Record<string,unknown>>({});
 const [scheduled,setScheduled]=useState(false),[scheduleEnabled,setScheduleEnabled]=useState(false),[schedulePermissions,setSchedulePermissions]=useState<string[]>([]),[messageEnabled,setMessageEnabled]=useState(false);
 const routingPermissions=definition?[...(definition.trigger==='message_received'?['conversation.message_event']:[]),...((definition.keywords as unknown[])?.length?['conversation.keyword_routing']:[]),...(definition.semantic?['conversation.semantic_routing','ai.points.consume']:[])]:[];
 const refs=definition?[...new Set(definition.trigger==='weekly'?definition.slots.map(s=>s.assignee_ref):[definition.assignee_ref])]:[];
 async function refresh(){const data=await api('automation-rules');setRules(data.rules);setMembers(data.members);setPermissions(data.permissions);setSchedulePermissions(data.schedule_permissions??[]);setScheduleEnabled(data.schedule_execution_enabled===true);setMessageEnabled(data.message_execution_enabled===true);setEnabled(data.planning_enabled);setExecutionEnabled(data.execution_enabled);return data.rules as Rule[];}
 useEffect(()=>{void refresh().catch(e=>setError(e.message));},[]);
 useEffect(()=>{if(draft){setDefinition(draft as Definition);setSelected(null);setScheduled(false);setBindings({});setConfirmed(false);setNotice('请绑定负责人并保存规则草稿。');setRuns([]);}},[draft]);
 async function work(fn:()=>Promise<void>){if(busy)return;setBusy(true);setError('');setNotice('');try{await fn();}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}}
 async function open(rule:Rule){const data=await api(`${rule.rule_id}/rule-versions`);setSelected(data.rule);setDefinition(data.versions[0].definition);setScheduled(false);setBindings({});setConfirmed(false);setRuns((await api(`${rule.rule_id}/rule-runs`)).runs);}
 async function save(){if(!definition)return;await work(async()=>{const mapped=structuredClone(definition);if(mapped.trigger==='weekly')mapped.slots=mapped.slots.map(s=>({...s,assignee_ref:bindings[s.assignee_ref]??s.assignee_ref}));else mapped.assignee_ref=bindings[mapped.assignee_ref]??mapped.assignee_ref;
 const data=await api('automation-rules',{definition:mapped,...(selected?{rule_id:selected.rule_id,expected_revision:selected.revision}:{})});const rows=await refresh();await open(rows.find(r=>r.rule_id===data.rule_id)!);setNotice('草稿已保存，未更改已发布计划。');});}
 return <details data-layout-mutation-busy={busy||confirmed} className="my-5 rounded-2xl border border-slate-200 bg-white p-5" open={Boolean(definition)||undefined}>
  <summary className="cursor-pointer font-semibold">排班预览与消息分流 · 授权后执行</summary>
  <p className="mt-3 text-sm leading-6 text-slate-600">预览规则、绑定坐席后，可授权单次执行轮班、关键词或语义分流计划；按周规则还可启用定时转派。每轮最多扫描最近映射的 100 条会话，语义识别最多 10 条；不完整计划不转派。语义识别将公开入站文本交给 AI 并消耗点数，不读取私人便笺；低置信度保留原负责人。</p>
  <p className="mt-2 text-xs text-slate-500">调度：{enabled?'计划生成已开放':'平台未启用，可先保存草稿'}；自动转派：{scheduleEnabled?'可授权开启':'未启用'}。暂停阻止后续执行，已发出的请求可能完成。晚于计划 5 分钟的任务不补跑。</p>
  <div className="mt-4 flex flex-wrap gap-2">{rules.map(rule=><button key={rule.rule_id} className={button} disabled={busy} onClick={()=>void work(()=>open(rule))}>{rule.name} · {rule.enabled?`计划 V${rule.active_revision}`:'已暂停'} · 草稿 V{rule.revision}</button>)}<button className={button} disabled={busy} onClick={()=>void work(async()=>{await refresh();if(selected)await open(selected);})}>刷新规则与记录</button></div>
  {definition&&<div className="mt-4 space-y-3 border-t pt-4">
   <h3 className="font-medium">{definition.name}{selected?` · 草稿 V${selected.revision}`:' · 新规则'}</h3>
   <p className="text-xs text-slate-500">规则参数来自实验室。修改参数请在实验室编辑后重新选择“保存为持久规则”；这里可以调整负责人绑定并创建新版本。</p>
   {refs.map(ref=><label key={ref} className="block text-sm">负责人占位：{members.find(m=>m.member_id===ref)?.display_name??ref}<select className="mt-1 block w-full rounded-xl border p-2" value={bindings[ref]??(members.some(m=>m.member_id===ref)?ref:'')} disabled={busy} onChange={e=>{setBindings({...bindings,[ref]:e.target.value});setConfirmed(false);}}><option value="">请选择本企业坐席</option>{members.map(m=><option key={m.member_id} value={m.member_id}>{m.display_name}</option>)}</select></label>)}
   <button className={button} disabled={busy||refs.some(ref=>!(bindings[ref]||members.some(m=>m.member_id===ref)))} onClick={()=>void save()}>保存为新草稿版本</button>
   <details><summary className="cursor-pointer text-sm">核对规则 JSON</summary><pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all bg-slate-50 p-3 text-xs">{JSON.stringify(definition,null,2)}</pre></details>
   {selected&&<>
    <p className="text-sm font-medium">当前发布模式：{selected.enabled?(selected.schedule_grant_id?'持续自动转派':'只读计划'):'已暂停'}。下列选择用于本次重新发布。</p>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" disabled={busy||!(definition.trigger==='message_received'?messageEnabled:scheduleEnabled)||!['weekly','message_received'].includes(definition.trigger)} checked={scheduled} onChange={e=>{setScheduled(e.target.checked);setConfirmed(false);}}/>启用持续自动转派（按周时刻或公开消息到达触发；管理员离线也会执行）</label>
    {Boolean(definition.semantic)&&<p className="text-sm text-amber-800">发布同时授权 AI 读取符合规则范围的公开入站文本、识别业务意图并扣 AI 点数；即使未匹配或未转派，已完成的模型调用也可能计费。重新发布或暂停可撤销后续运行。</p>}
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" disabled={busy||Object.keys(bindings).length>0} checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我已核对保存的 V{selected.revision}、负责人、处理范围和数量上限，{scheduled?'授权按计划持续执行真实会话转派，直到暂停或重新发布。':'仅授权读取会话并生成计划，不授权自动转派。'}负责人绑定有修改时须先保存。</label>
    <div className="flex flex-wrap gap-2"><button className={button} disabled={busy||!confirmed||!enabled||Object.keys(bindings).length>0} onClick={()=>void work(async()=>{await api(`${selected.rule_id}/rule-publish`,{revision:selected.revision,expected_active_revision:selected.active_revision,permissions:[...(scheduled?schedulePermissions:permissions),...routingPermissions],execution_mode:scheduled?(definition.trigger==='message_received'?'message_event':'scheduled'):'plan_only',confirm:true});const rows=await refresh();await open(rows.find(r=>r.rule_id===selected.rule_id)!);setNotice(scheduled?'已授权持续自动转派。可随时暂停；查看运行记录及执行回执。':'已发布只读计划规则，未启用自动转派。');})}>{scheduled?'授权发布并开启自动转派':'授权发布只读计划'}</button>
    <button className={button} disabled={busy||!selected.enabled} onClick={()=>void work(async()=>{await api(`${selected.rule_id}/rule-pause`,{});const rows=await refresh();await open(rows.find(r=>r.rule_id===selected.rule_id)!);setNotice('计划规则已暂停。');})}>暂停计划</button>
    <button className={button} disabled={busy||!selected.enabled||!enabled} onClick={()=>void work(async()=>{await api(`${selected.rule_id}/rule-plan`,{});setNotice('已排队，稍后刷新记录。每周规则预览下一个排班时刻，不执行转派。');setRuns((await api(`${selected.rule_id}/rule-runs`)).runs);})}>为已发布版本生成一次真实会话计划</button></div>
    <p className="text-xs text-slate-500">下次定时计划：{selected.next_run_at?new Date(selected.next_run_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'无定时计划（消息规则等待新消息，或只读／已暂停）'}</p>
   </>}
  </div>}
  {error&&<p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}{notice&&<p role="status" className="mt-3 text-sm text-blue-700">{notice}</p>}
  {runs.length>0&&<div className="mt-4 space-y-2"><h3 className="font-medium">最近计划与独立执行回执</h3>
   <p className="text-xs text-slate-500">只有在持续执行授权下产生的定时或消息任务才会自动排队。手动预览仍不执行。状态变化会跳过；不确定结果只核对回执，不自动重发。排队不代表转派成功，请查看回执。</p>
   {runs.map(run=><details key={run.run_id} className="rounded-xl bg-slate-50 p-3 text-sm">
    <summary>{new Date(run.scheduled_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})} · {({pending:'等待处理',running:'处理中',completed:'计划完成',partial:'部分完成',cancelled:'已取消',failed:'失败',interrupted:'执行中断',missed:'超时跳过'} as Record<string,string>)[run.state]??run.state} · 计划 {run.result.planned_count??0} 条{run.schedule_execution_state?` · 定时执行${run.schedule_execution_state==='queued'?'已排队':'已跳过'}`:''}</summary>
    {run.schedule_execution_code&&<p className="mt-2 text-amber-700">{labels[run.schedule_execution_code]??run.schedule_execution_code}</p>}
    <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(run.result,null,2)}</pre>
    <div className="mt-2 flex flex-wrap gap-2"><button className={button} disabled={busy||!executionEnabled||run.state!=='completed'||!run.result.planned_count||Boolean(run.schedule_execution_state)} onClick={()=>void work(async()=>{if(!window.confirm(`这将真实转派本次计划中的 ${run.result.planned_count} 条会话。仅本次授权，负责人或状态变化时会跳过。确认执行？`))return;await api(`${run.run_id}/execute-plan`,{confirm:true,permission:'conversation.assign_plan'});setNotice('本次转派已排队；请查看执行回执。');})}>授权执行本次转派</button><button className={button} disabled={busy} onClick={()=>void work(async()=>{setExecution({...execution,[run.run_id]:await api(`${run.run_id}/execution-status`)});})}>刷新执行回执</button></div>
    {execution[run.run_id]!==undefined&&<pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(execution[run.run_id],null,2)}</pre>}
   </details>)}
  </div>}
 </details>;
}
