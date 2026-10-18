"use client";
import {useState} from 'react';
import {automaticChannelNames,automaticModeStatusText,type ConversationAutomationSettings as Settings} from '../lib/automatic-reception';
type Mode='manual'|'draft'|'automatic';
const modeOf=(s:Settings):Mode=>s.automatic_sending_enabled?'automatic':s.ai_auto_reply_enabled?'draft':'manual';
export function ConversationAutomationControls({initial,en,workspaceId}:{initial:Settings;en:boolean;workspaceId:string}) {
  const [settings,setSettings]=useState(initial),[mode,setMode]=useState<Mode>(modeOf(initial));
  const [threshold,setThreshold]=useState(initial.ai_auto_send_confidence_threshold_percent);
  const [saving,setSaving]=useState(false),[notice,setNotice]=useState('');
  const [pending,setPending]=useState<{mode:Mode;threshold:number}|null>(null),[confirmed,setConfirmed]=useState(false);
  const prompt=mode==='automatic'
    ?(en?'Eligible AI replies may be sent without agent review and consume AI points. Only separately authorized channels are included.':'自动接待会消耗 AI 点数，并可能不经客服逐条确认，直接向客户发送符合条件的 AI 回复。仅处理已单独授权的渠道。')
    :(en?'Automatic drafts consume AI points but are not sent to customers.':'自动草稿会消耗 AI 点数，但不会直接发给客户。');
  function requestSave(){
    if(mode==='manual'){void save({mode,threshold});return;}
    setConfirmed(false);setNotice('');setPending({mode,threshold});
  }
  async function save(selected:{mode:Mode;threshold:number}){
    setSaving(true);setNotice('');
    try {
      const r=await fetch('/api/conversation-automation',{method:'PATCH',headers:{'content-type':'application/json',
        'x-replynest-workspace':workspaceId,'x-replynest-action':'conversation-automation-v1'},body:JSON.stringify({
        reception_mode:selected.mode,ai_auto_send_confidence_threshold_percent:selected.threshold,confirm_enable:selected.mode!=='manual',
        reason:`Tenant administrator selected reception mode: ${selected.mode}`})});
      const body=await r.json() as {data?:Settings;error?:{message?:string}};
      if(!r.ok||!body.data)throw new Error(body.error?.message??(en?'Save failed':'保存失败'));
      setSettings(body.data);setMode(modeOf(body.data));setThreshold(body.data.ai_auto_send_confidence_threshold_percent);
      setNotice(automaticModeStatusText(body.data,en));
    }catch(e){setNotice(e instanceof Error?e.message:'保存失败');}finally{setSaving(false);setPending(null);setConfirmed(false);}
  }
  const options:{id:Mode;title:string;description:string}[]=en?[
    {id:'manual',title:'Agent assisted',description:'Generate suggestions on demand; review and send manually.'},
    {id:'draft',title:'Automatic drafts',description:'Generate drafts for new messages; agents review and send.'},
    {id:'automatic',title:'Automatic reception',description:'Generate and send eligible replies; escalate cases needing review.'}
  ]:[
    {id:'manual',title:'人工辅助',description:'按需生成 AI 建议，由客服核对并点击发送。'},
    {id:'draft',title:'自动草稿',description:'客户来消息后自动生成回复草稿，由客服核对后发送。'},
    {id:'automatic',title:'自动接待',description:'自动生成并发送符合条件的回复；需要核实的问题交给人工。'}
  ];
  return <section className="mt-5 rounded-2xl border border-[var(--border-subtle)] bg-white p-5">
    <h2 className="font-semibold">{en?'AI reception mode':'AI 接待模式'}</h2>
    <fieldset disabled={saving||!!pending} className="mt-4 grid gap-3 md:grid-cols-3"><legend className="sr-only">{en?'Choose mode':'选择接待模式'}</legend>
      {options.map(m=><label key={m.id} className={`cursor-pointer rounded-xl border p-4 ${mode===m.id?'border-blue-500 bg-blue-50':'border-[var(--border-subtle)]'}`}>
        <span className="flex items-center gap-2"><input type="radio" name="reception-mode" value={m.id} disabled={m.id==='automatic'&&!settings.automatic_reception_available} checked={mode===m.id} onChange={()=>setMode(m.id)}/><span className="font-semibold">{m.title}{m.id==='automatic'&&!settings.automatic_reception_available&&(en?' (coming soon)':'（尚未开放）')}</span></span>
        <span className="mt-2 block text-xs leading-5 text-[var(--ink-500)]">{m.description}</span>
      </label>)}
    </fieldset>
    {mode==='automatic'&&<label className="mt-4 flex flex-wrap items-center gap-3 text-sm">{en?'Minimum evidence confidence (%)':'最低依据置信度（%）'}
      <input type="number" min={50} max={100} step={1} value={threshold} disabled={saving||!!pending} onChange={e=>setThreshold(Number(e.target.value))} className="w-24 rounded-lg border px-3 py-2"/>
      <span className="text-xs text-[var(--ink-500)]">{en?'A screening score, not an accuracy guarantee.':'这是发送筛选分数，不代表回答正确率保证。'}</span>
    </label>}
    {mode==='automatic'?<div className="mt-4 rounded-lg bg-blue-50 p-3 text-xs leading-5 text-blue-900">
      <p>{en?'Available execution channels: ':'当前执行服务支持：'}{automaticChannelNames(settings.automatic_supported_channels,en)||(en?'Not available':'尚未开放')}</p>
      <p className="mt-2">{en?'Your authorized channels: ':'本企业已授权渠道：'}{automaticChannelNames(settings.automatic_authorized_channels,en)||(en?'None':'尚未授权')}</p>
      <p className="mt-2">{en?'Provider windows, quotas and permission checks still apply. Acknowledgement does not guarantee delivery.':'仍受渠道回复窗口、频率及权限限制；平台或微信受理不代表用户送达。'}</p>
      <a href="/settings/automatic-reception" className="mt-2 inline-flex font-semibold underline">{en?'Manage separate sending approvals':'管理独立发送授权'}</a>
    </div>:<p className="mt-4 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">{!settings.runtime_executor_available
      ?(en?'Automatic execution is unavailable. Preferences do not send messages; continue handling conversations manually.':'自动执行尚未开放：以上选择仅保存偏好，当前仍需人工处理客户消息。')
      :(en?'Automatic drafts support independent WeChat accounts, shared WeChat and Web Chat. Drafts appear as team-only notes and may consume AI points; agents send manually.':'自动草稿支持独立公众号、共享公众号和网站聊天。草稿以仅团队可见的便笺展示，生成可能消耗 AI 点数，仍需客服发送。')}</p>}
    <p className="mt-2 text-xs">{en?'Saved mode: ':'当前已保存模式：'}{automaticModeStatusText(settings,en)}</p>
    <button type="button" disabled={saving||!!pending||(mode==='automatic'&&!settings.automatic_reception_available)||!Number.isInteger(threshold)||threshold<50||threshold>100} onClick={requestSave} className="mt-4 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving?(en?'Saving…':'保存中…'):(en?'Save reception mode':'保存接待模式')}</button>
    {pending&&<section role="dialog" aria-labelledby="reception-mode-confirm" className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-4">
      <h3 id="reception-mode-confirm" className="font-semibold">{en?'Confirm reception mode':'确认接待模式'}</h3><p className="mt-2 text-sm leading-6">{prompt}</p>
      <label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={saving} onChange={e=>setConfirmed(e.target.checked)}/>{en?'I have read and confirm this change.':'我已阅读并确认本次更改。'}</label>
      <div className="mt-3 flex gap-3"><button type="button" disabled={saving} onClick={()=>{setPending(null);setConfirmed(false);}} className="rounded-lg border px-3 py-2">{en?'Cancel':'取消'}</button>
        <button type="button" disabled={saving||!confirmed} onClick={()=>{if(confirmed&&pending)void save(pending);}} className="rounded-lg bg-blue-600 px-3 py-2 text-white disabled:opacity-50">{en?'Confirm and save':'确认并保存'}</button></div>
    </section>}
    {notice&&<p role="status" className="mt-3 text-sm text-blue-800">{notice}</p>}
  </section>;
}
