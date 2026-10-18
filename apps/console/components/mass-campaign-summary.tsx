export type MassOverview={status:string;total:number;counts:Record<string,number>;has_more:boolean;batches:Array<{batch_id:string;state:string;reason:string|null;query_attempts:number;available_at?:string;defer_count?:number;reviews?:Array<{review_id:string;reason:string;created_at:string}>}>};
const states:Record<string,string>={not_staged:'尚未生成批次',needs_review:'需要核查',in_progress:'处理中',attention:'存在受阻或失败批次',provider_succeeded:'平台已确认批次发送成功',queued:'等待处理',preparing:'核验中',submitting:'正在提交',submitted:'已受理，等待结果',uncertain:'结果不确定，请勿重复发送',blocked:'已阻止',failed:'失败',succeeded:'平台确认成功',deleted:'平台已删除'};
const reasons:Record<string,string>={campaign_professional_required:'需要有效专业版套餐',campaign_shared_channel_forbidden:'共享公众号不支持营销群发',campaign_quiet_hours:'当前处于静默时段',campaign_rate_limited:'达到发送频率限制',campaign_rate_invalid:'批次人数与发送频率设置不匹配',campaign_defer_limit_reached:'已达到自动延后次数上限，请联系管理员核查',campaign_consent_missing_or_withdrawn:'收件人未授权或已退订',campaign_recipient_changed:'收件人或渠道绑定已变化',campaign_channel_changed:'渠道已变更或不可用',campaign_content_changed:'活动内容与已确认批次不一致',campaign_not_due_or_approved:'活动未到执行时间、未批准或已暂停',campaign_cancel_condition:'已满足取消条件',receipt_review_required:'多次查询仍无法确认，请联系管理员核查',receipt_query_unavailable:'暂时无法查询结果，稍后继续查询',send_outcome_uncertain:'无法确认是否已提交，请勿重复发送',worker_interrupted_review_required:'处理被中断，需要核查'};
export function MassCampaignSummary({data,campaignId,canReview=false}:{data:MassOverview|null|undefined;campaignId?:string;canReview?:boolean}){
 if(!data)return null;
 return <section className="mt-6 rounded-2xl border bg-white p-5">
  <h2 className="font-semibold">公众号群发批次 · {states[data.status]??'待核查'}</h2>
  <p className="mt-2 text-sm text-[var(--ink-500)]">共 {data.total} 个批次。接口受理不代表送达，平台确认的批次结果也不代表每位用户已收到或阅读。</p>
  <div className="mt-3 space-y-2">{data.batches.map(b=><div key={b.batch_id} className="rounded-lg bg-slate-50 p-3 text-sm">
   <p>{states[b.state]??'待核查'} · 已查询 {b.query_attempts} 次</p>
   {b.reason&&<p className="mt-1 text-xs text-amber-800">{reasons[b.reason]??'暂时无法完成，请联系管理员核查'}</p>}
   {b.state==='queued'&&!!b.defer_count&&b.available_at&&<p className="mt-1 text-xs text-blue-700">已安全延后 {b.defer_count} 次 · 下次核验不早于 {new Intl.DateTimeFormat('zh-CN',{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Shanghai'}).format(new Date(b.available_at))}（北京时间）。核验通过后才会提交。</p>}
   {!!b.reviews?.length&&<details className="mt-3"><summary>最近核查记录（最多 3 条）</summary>{b.reviews.map(r=><div key={r.review_id} className="mt-2 border-l-2 pl-3"><time className="text-xs">{new Intl.DateTimeFormat('zh-CN',{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Shanghai'}).format(new Date(r.created_at))}</time><p className="whitespace-pre-wrap break-words">{r.reason}</p></div>)}</details>}
   {canReview&&campaignId&&['uncertain','blocked','failed'].includes(b.state)&&<details className="mt-3"><summary className="cursor-pointer text-blue-700">记录人工核查</summary>
    <form action={`/api/message-campaigns/${encodeURIComponent(campaignId)}/mass-batches/${encodeURIComponent(b.batch_id)}/review`} method="post" className="mt-2 space-y-2">
     <p className="text-xs text-amber-800">仅保存核查说明，不改变发送结果、不重新发送。请勿填写客户隐私或密钥。</p>
     <label className="block">核查说明<textarea name="reason" required minLength={10} maxLength={500} rows={3} className="mt-1 block w-full rounded border p-2" placeholder="请填写核查依据及后续处理（10–500 字）"/></label>
     <button className="rounded border border-blue-500 bg-white px-3 py-2 text-blue-700">保存核查说明（不重发）</button>
    </form></details>}
  </div>)}</div>
  {data.has_more&&<p className="mt-3 text-xs text-[var(--ink-500)]">仅展示最近 50 个批次，上方总数包含全部批次。</p>}
 </section>;
}
