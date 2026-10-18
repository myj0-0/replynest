'use client';
import {useEffect,useRef,useState} from 'react';
import {automaticMessages,automaticKnowledgeStatusText,automaticSenderStatusText,automaticStateLabels,automaticReasonText,automaticGenerationReasonText,automaticWechatOutcomeText,automaticWechatHistoryText,automaticBillingText,automaticBillingReviewText,automaticMutationRefreshUncertain,aiPointText,type AutomaticView,type AutomaticWeChatChannel,type AutomaticTask} from '../lib/automatic-reception';
const button='rounded-xl border border-[var(--border-subtle)] px-4 py-2 text-sm font-semibold disabled:opacity-50';
export function AutomaticReceptionManagement({workspaceId}:{workspaceId:string}){
 const [view,setView]=useState<AutomaticView|null>(null);
 const [busy,setBusy]=useState(false),[stale,setStale]=useState(true),[notice,setNotice]=useState('');
 const [wechatChannels,setWechatChannels]=useState<AutomaticWeChatChannel[]>([]);
 const [pending,setPending]=useState<{path:string;body:unknown;title:string;description:string}|null>(null),[confirmed,setConfirmed]=useState(false);
 const serial=useRef(0),confirmHeading=useRef<HTMLHeadingElement>(null);
 async function api(path:string,body?:unknown){
  const r=await fetch('/api/automatic-reception'+path,{method:body===undefined?'GET':'POST',cache:'no-store',signal:AbortSignal.timeout(9000),
   headers:{'x-replynest-workspace':workspaceId,...(body===undefined?{}:{'content-type':'application/json','x-replynest-action':'automatic-reception-v1'})},body:body===undefined?undefined:JSON.stringify(body)});
  const b=await r.json();if(!r.ok||!b.data)throw Error(automaticMessages[b.error?.code]??automaticMessages.management_result_uncertain);return b.data;
 }
 async function refresh(){
  const n=++serial.current;setBusy(true);setStale(true);
  try{
   const v=await api('?limit=10');
   if(n!==serial.current)return false;
   setView(v);setWechatChannels(v.wechat?.grant?.enabled?v.wechat.grant.channels:[]);
   setPending(null);setConfirmed(false);setStale(false);return true;
  }catch(e){if(n===serial.current)setNotice(e instanceof Error?e.message:automaticMessages.management_result_uncertain);return false;}
  finally{if(n===serial.current)setBusy(false);}
 }
 useEffect(()=>{void refresh();return()=>{serial.current++;};},[workspaceId]); // Workspace is fixed for this page; the proxy also verifies it on every action.
 useEffect(()=>{if(pending)confirmHeading.current?.focus();},[pending]);
 function ask(path:string,body:unknown,title:string,description:string){setConfirmed(false);setPending({path,body,title,description});setNotice('');}
 async function mutate(path:string,body:unknown){
  setBusy(true);setNotice('');
  try{await api(path,body);setPending(null);setConfirmed(false);const refreshed=await refresh();
   if(refreshed)setNotice('操作已保存；请以刷新后的授权状态为准。');
   else setNotice(previous=>automaticMutationRefreshUncertain+(previous?' '+previous:''));}
  catch(e){setPending(null);setConfirmed(false);setStale(true);setNotice(e instanceof Error?e.message:automaticMessages.management_result_uncertain);}
  finally{setBusy(false);}
 }
 const disabled=busy||stale||!!pending;
 return <div className="mt-6 space-y-5" data-layout-mutation-busy={busy||!!pending?'true':undefined}>
  <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-[var(--ink-500)]">{view?.wechat?'网站聊天与公众号分别授权。':'目前仅适用于网站聊天。'}保存授权不代表执行服务已经启用。</p>
   <button type="button" disabled={busy} onClick={()=>{setNotice('');void refresh();}} className={button}>刷新授权状态</button></div>
  {notice&&<p role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">{notice}</p>}
  {stale&&<p className="text-sm text-amber-800">{busy?'正在读取当前状态…':'状态未确认，授权操作暂时不可用。请先刷新。'}</p>}
  {view&&<>
   <section className="rounded-2xl border border-[var(--border-subtle)] bg-white p-5">
    <h2 className="text-lg font-semibold text-[var(--ink-900)]">{view.wechat?'基础发送授权（网站聊天）':'网站聊天发送授权'}</h2>
    <p className="mt-3 text-sm leading-6">{view.disclosure}</p>
    <p className="mt-3 text-sm font-semibold">当前授权：{view.grant?.enabled?'已开启':'未开启'}</p>
    <p className="mt-2 text-sm" role="status">{automaticKnowledgeStatusText(view.grant?.enabled===true,view.grant?.knowledge_confirmed===true,view.knowledge_available===true,view.semantic_available===true)}</p>
    <p className="mt-2 text-sm" role="status">{automaticSenderStatusText(view.execution?.sender_state)}</p>
    <p className="mt-2 text-xs leading-5 text-[var(--ink-500)]">撤销后不会再生成或提交新回复；已经提交的请求不能撤回。金额、退款、订单、个人凭据和不确定问题仍需人工处理。</p>
    <div className="mt-4 flex flex-wrap gap-3">
     {!view.grant?.enabled?<button type="button" disabled={disabled} className={button+' bg-blue-600 text-white'} onClick={()=>ask('/grant',{
      enabled:true,expected_authorization_id:view.grant?.authorization_id??null,confirmed:true,consent_version:view.consent_version,disclosure_version:view.disclosure_version},'确认开启自动发送授权',view.disclosure)}>阅读并开启授权</button>:
      <button type="button" disabled={disabled} className={button} onClick={()=>void mutate('/grant',{enabled:false,expected_authorization_id:view.grant!.authorization_id})}>撤销发送授权</button>}
     <a href="/settings/communications" className={button}>返回接待模式设置</a>
     {view.grant?.enabled&&!view.grant.knowledge_confirmed&&<button type="button" disabled={disabled} className={button+' bg-blue-600 text-white'}
      onClick={()=>ask('/grant',{enabled:true,expected_authorization_id:view.grant!.authorization_id,confirmed:true,consent_version:view.consent_version,disclosure_version:view.disclosure_version},
       '确认新版知识库接待授权',`更新基础授权后，原公众号授权将失效，需要重新确认公众号渠道。\n\n${view.disclosure}`)}>重新阅读并更新授权</button>}
    </div>
   </section>
   {view.wechat&&<section className="rounded-2xl border border-[var(--border-subtle)] bg-white p-5">
    <h2 className="text-lg font-semibold">公众号自动回复授权</h2>
    <p className="mt-3 text-sm leading-6">{view.wechat.disclosure}</p>
    <p className="mt-3 text-sm font-semibold">当前公众号授权：{view.wechat.grant?.enabled?'已开启':'未开启或已失效'}</p>
    <p className="mt-2 text-sm" role="status">{automaticKnowledgeStatusText(view.wechat.grant?.enabled===true,view.grant?.knowledge_confirmed===true&&view.wechat.grant?.knowledge_confirmed===true,view.knowledge_available===true,view.semantic_available===true)}</p>
    {!view.grant?.enabled&&<p className="mt-2 text-sm text-amber-800">请先完成上方基础发送授权，再单独授权公众号。重建基础授权后，公众号需重新确认；公众号授权不会开启网站执行服务。</p>}
    <fieldset disabled={disabled||!view.grant?.enabled} className="mt-4 flex flex-wrap gap-4">
     {view.wechat.channels.map(channel=><label key={channel} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={wechatChannels.includes(channel)}
      onChange={e=>setWechatChannels(previous=>e.target.checked?[...previous,channel]:previous.filter(c=>c!==channel))}/>{channel==='shared_wechat'?'官方共享公众号（仅当前商家咨询）':'本企业独立公众号'}</label>)}
    </fieldset>
    <div className="mt-4 flex flex-wrap gap-3"><button type="button" className={button+' bg-blue-600 text-white'} disabled={disabled||!view.grant?.enabled||!wechatChannels.length}
     onClick={()=>ask('/wechat-grant',{enabled:true,expected_authorization_id:view.grant!.authorization_id,expected_grant_id:view.wechat!.grant?.grant_id??null,
      channels:[...wechatChannels],confirmed:true,consent_version:view.wechat!.consent_version,disclosure_version:view.wechat!.disclosure_version},
      '确认公众号自动回复授权',`本次授权渠道：${wechatChannels.map(c=>c==='shared_wechat'?'官方共享公众号':'本企业独立公众号').join('、')}。\n\n${view.wechat!.disclosure}`)}>阅读并保存公众号授权</button>
     {view.wechat.grant?.enabled&&<button type="button" className={button} disabled={disabled} onClick={()=>void mutate('/wechat-grant',{
      enabled:false,expected_authorization_id:view.grant!.authorization_id,expected_grant_id:view.wechat!.grant!.grant_id})}>撤销公众号授权</button>}
    </div>
    <p className="mt-3 text-xs leading-5 text-[var(--ink-500)]">未勾选的渠道不会获得授权；更改渠道仅适用于确认之后的新消息。不授权营销群发。</p>
   </section>}
   {pending&&<section role="dialog" aria-modal="false" aria-labelledby="automatic-confirm-heading" className="rounded-2xl border-2 border-blue-300 bg-blue-50 p-5">
    <h2 id="automatic-confirm-heading" tabIndex={-1} ref={confirmHeading} className="font-semibold">{pending.title}</h2><p className="mt-3 max-h-80 overflow-y-auto whitespace-pre-wrap text-sm leading-6">{pending.description}</p>
    <label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy||stale} onChange={e=>setConfirmed(e.target.checked)} className="mt-1"/>我已阅读以上内容，并确认本次操作。</label>
    <div className="mt-4 flex gap-3"><button type="button" className={button} disabled={busy} onClick={()=>{setPending(null);setConfirmed(false);}}>取消</button>
     <button type="button" className={button+' bg-blue-600 text-white'} disabled={!confirmed||busy||stale} onClick={()=>void mutate(pending.path,pending.body)}>确认并保存</button></div>
   </section>}
   <section className="rounded-2xl border border-[var(--border-subtle)] bg-white p-5">
    <h2 className="text-lg font-semibold">知识库自动接待</h2>
    <p className="mt-3 text-sm leading-6">AI 从已发布、当前有效的知识库检索相关内容，核对来源、适用条件、冲突和风险后回答相近问法。未达到接待阈值、没有可靠来源或属于高风险问题时交人工处理。</p>
    <p className="mt-2 text-sm text-[var(--ink-500)]">知识只需在知识库管理，无需逐条配置问题样例。历史聊天整理的草稿必须先由管理员核对并发布；客服仍可暂停客户接待 10 分钟或提前恢复。</p>
    <a href="/knowledge" className={button+' mt-4 inline-block'}>管理知识库</a>
   </section>
   <a href="/billing/history?view=reception" className={button+' inline-block'}>前往套餐与账务核对 AI 点数</a>
  </>}
 </div>;
}

/** Read-only ledger review. Uses the existing administrator-only, workspace-bound API. */
export function AutomaticReceptionRecords({workspaceId}:{workspaceId:string}){
 const [page,setPage]=useState<{workspaceId:string;jobs:AutomaticTask[];next:string|null}|null>(null);
 const [busy,setBusy]=useState(true),[notice,setNotice]=useState('');
 const serial=useRef(0);
 const current=page?.workspaceId===workspaceId?page:null;
 async function load(after?:string){
  const n=++serial.current;setBusy(true);setNotice('');
  try{
   const r=await fetch('/api/automatic-reception/tasks?limit=10'+(after?'&after='+encodeURIComponent(after):''),{
    method:'GET',cache:'no-store',signal:AbortSignal.timeout(9000),headers:{'x-replynest-workspace':workspaceId}});
   const b=await r.json();
   if(!r.ok||!Array.isArray(b.data?.jobs))throw Error(automaticMessages[b.error?.code]??automaticMessages.management_result_uncertain);
   if(n!==serial.current)return;
   setPage({workspaceId,jobs:b.data.jobs,next:b.data.next_cursor??null});
  }catch(e){if(n===serial.current)setNotice(e instanceof Error?e.message:automaticMessages.management_result_uncertain);}
  finally{if(n===serial.current)setBusy(false);}
 }
 useEffect(()=>{void load();return()=>{serial.current++;};},[workspaceId]);
 return <section id="automatic-reception-costs" data-testid="automatic-reception-costs" className="mt-6 scroll-mt-24 rounded-2xl border border-[var(--border-subtle)] bg-white p-5 shadow-[var(--shadow-card)] md:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">执行记录与 AI 点数</h2><button type="button" className={button} disabled={busy} onClick={()=>void load()}>刷新第一页记录</button></div>
    <p className="mt-2 text-sm text-[var(--ink-500)]">知识库自动接待的扣费明细，每页 10 条。可分别核对检索、生成和核验所消耗的点数。</p>
    <p className="mt-2 text-sm leading-6 text-[var(--ink-500)]">“平台已受理”不代表送达或已读；不确定任务不会自动重发。检索、生成与独立核验分别按实际用量计费；未找到来源、转人工或发送失败也可能已消耗点数。</p>
    {notice&&<p role="alert" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{notice}{current?' 当前仍展示上次读取的记录。':''}</p>}
    {busy&&<p role="status" className="mt-4 text-sm">正在读取执行记录…</p>}
    {!busy&&!current&&!notice&&<p className="mt-4 text-sm">记录尚未确认，请刷新查看。</p>}
    {current&&!current.jobs.length&&<p className="mt-4 text-sm">暂无执行记录。</p>}
    <div className="mt-4 space-y-3">{current?.jobs.map(t=><article key={t.job_id} className="rounded-xl border border-[var(--border-subtle)] p-4 text-sm">
     <div className="flex flex-wrap justify-between gap-2"><strong>{automaticStateLabels[t.state]??'待核查'} · {t.channel==='web_chat'?'网站聊天':'微信渠道'}</strong><time>{new Date(t.created_at).toLocaleString('zh-CN')}</time></div>
     <p className="mt-2">已扣 {aiPointText(t.model_costs?(t.model_costs.every(cost=>cost.charged_micros!==null&&/^\d+$/.test(cost.charged_micros))?t.model_costs.reduce((sum,cost)=>sum+BigInt(cost.charged_micros!),0n).toString():null):t.charged_micros)} AI 点数</p>
     <details className="mt-2"><summary className="cursor-pointer text-blue-700">查看扣费及执行详情</summary>
     {t.model_costs?<ul className="mt-2 space-y-2">{t.model_costs.map(cost=><li key={cost.stage}>
      {({retrieval:'知识检索',generation:'答复生成',verification:'独立核验'} as Record<string,string>)[cost.stage]??'模型步骤'}：{cost.state?automaticStateLabels[cost.state]??'待核查':'尚未调用'}；已扣 {aiPointText(cost.charged_micros)} AI 点数；占用 {aiPointText(cost.held_micros)} AI 点数
      <p className="mt-1 text-xs text-[var(--ink-500)]">{automaticBillingReviewText(cost.billing_review)}{cost.reason?'；'+automaticReasonText(cost.reason):''}</p>
     </li>)}</ul>:<p className="mt-2">生成：{t.generation_state?automaticStateLabels[t.generation_state]??'待核查':'尚未调用模型'}；已扣 {aiPointText(t.charged_micros)} AI 点数；占用 {aiPointText(t.held_micros)} AI 点数</p>}
     <p className="mt-2">执行：{automaticReasonText(t.reason)}</p>{automaticWechatOutcomeText(t)&&<p className="mt-2">微信发送：{automaticWechatOutcomeText(t)}</p>}{t.generation_reason&&<p className="mt-2">生成备注：{automaticGenerationReasonText(t.generation_reason,t.billing_state)}；计费：{automaticBillingText(t.billing_state)}</p>}
     {automaticWechatHistoryText(t)&&<p className="mt-2">聊天记录：{automaticWechatHistoryText(t)}</p>}
     {t.billing_review&&<p className="mt-2">费用核查：{automaticBillingReviewText(t.billing_review)}</p>}<p className="mt-2 break-all text-xs text-[var(--ink-500)]">任务编号：{t.job_id}</p></details>
    </article>)}</div><div className="mt-4 flex flex-wrap items-center gap-3"><button type="button" className={button} disabled={busy||!current?.next} onClick={()=>void load(current!.next!)}>下一页记录</button><a href="/settings/automatic-reception" className="text-sm text-blue-700 underline">管理自动接待授权</a></div>
   </section>;
}
