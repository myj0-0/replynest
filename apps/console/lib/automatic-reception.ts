export type AutomaticAnswer={answer_id:string;document_id:string;document_version:number;topic:string;answer_text:string;keywords:string[];question_texts:string[];
 status:'draft'|'approved'|'disabled';revision:string;valid_from:string;valid_until:string};
export type AutomaticGrant={authorization_id:string;enabled:boolean;consent_version:string;updated_at:string;knowledge_confirmed?:boolean};
export type AutomaticWeChatChannel='wechat_official_account'|'shared_wechat';
export type AutomaticWeChatView={grant:{grant_id:string;authorization_id:string;channels:AutomaticWeChatChannel[];enabled:boolean;created_at:string;knowledge_confirmed?:boolean}|null;
 channels:AutomaticWeChatChannel[];disclosure:string;disclosure_version:string;consent_version:string};
export type AutomaticSenderState='ready'|'missing'|'disabled'|'invalid'|'unavailable'|'platform_disabled';
export type AutomaticView={grant:AutomaticGrant|null;knowledge_available?:boolean;semantic_available?:boolean;execution?:{sender_state:AutomaticSenderState};wechat?:AutomaticWeChatView;answers:AutomaticAnswer[];next_cursor:string|null;disclosure:string;disclosure_version:string;consent_version:string;approval_version:string;channels:string[]};
// The third argument is retained for older API responses, but the retired FAQ
// gate cannot describe the current semantic retrieval/verification executor.
export function automaticKnowledgeStatusText(enabled:boolean,confirmed:boolean,_legacyFaqAvailable:boolean,semantic=false){
 if(!enabled)return '知识库相近问法尚未授权。';
 if(!confirmed&&semantic)return '当前授权未包含长文检索与独立核验；请重新阅读并确认新版知识库授权。';
 if(!confirmed)return '当前授权尚未包含新版知识库接待范围；请重新阅读并确认授权。';
 if(!semantic)return '知识库问答授权已确认，检索与核验执行服务尚未开放；不会自动发送。';
 return '知识库问答与长文接待已授权；仅自动回答来源支持、条件完整、无冲突且达到阈值的低风险问题。';
}
export type AutomaticTask={job_id:string;channel:string;state:string;reason:string|null;created_at:string;generation_state:string|null;generation_reason:string|null;
 billing_state:string|null;charged_micros:string|null;held_micros:string|null;billing_review?:string;
 model_costs?:Array<{stage:string;state:string|null;reason:string|null;billing_state:string|null;charged_micros:string|null;held_micros:string|null;billing_review:string}>;
 wechat_outcome?:string|null;wechat_reason?:string|null;wechat_provider_code?:number|null;
 wechat_history_state?:string|null;wechat_history_reason?:string|null;wechat_history_attempts?:number|null};
export type ConversationAutomationSettings={automatic_sending_enabled:boolean;ai_auto_reply_enabled:boolean;ai_auto_send_confidence_threshold_percent:number;
 runtime_executor_available:boolean;automatic_reception_available?:boolean;effective_ai_auto_reply?:boolean;effective_automatic_sending?:boolean;
 automatic_supported_channels?:string[];automatic_authorized_channels?:string[];automatic_sender_state?:AutomaticSenderState};
export function automaticSenderStatusText(state:AutomaticSenderState|undefined,en=false){
 const labels:Record<AutomaticSenderState,string>=en?{
  ready:'Sending identity is ready; separate channel consent and eligibility checks still apply.',
  missing:'Sending identity has not been initialized. Confirm the sending grant to prepare it.',
  disabled:'Sending identity is disabled. Contact the platform administrator; a new grant will not restore it.',
  invalid:'Sending identity configuration is invalid. Contact the platform administrator.',
  unavailable:'Sending identity could not be verified. Refresh before enabling automatic reception.',
  platform_disabled:'Automatic sending service is not enabled. Contact the platform administrator.'
 }:{ready:'发送身份已就绪；仍需独立渠道授权，并核对每条回复的发送条件。',missing:'发送身份尚未初始化，确认发送授权时会自动准备。',
  disabled:'发送身份已停用，请联系平台管理员；重新授权不会恢复停用身份。',invalid:'发送身份配置异常，请联系平台管理员。',
  unavailable:'暂时无法核实发送身份，请刷新查看；此状态不代表已有发送授权已撤销。',platform_disabled:'自动发送服务尚未开启，请联系平台管理员。'};
 return labels[state??'unavailable'];
}
export function automaticChannelNames(channels:unknown,en=false){
 const names:Record<string,string>=en?{web_chat:'Web Chat',wechat_official_account:'Independent WeChat',shared_wechat:'Shared WeChat'}:
  {web_chat:'网站聊天',wechat_official_account:'独立公众号',shared_wechat:'共享公众号'};
 return Array.isArray(channels)?Object.keys(names).filter(ch=>channels.includes(ch)).map(ch=>names[ch]).join(en?', ':'、'):'';
}
export function automaticModeStatusText(s:ConversationAutomationSettings,en=false){
 if(s.automatic_sending_enabled&&s.automatic_sender_state&&s.automatic_sender_state!=='ready')return automaticSenderStatusText(s.automatic_sender_state,en);
 if(s.automatic_sending_enabled)return s.effective_automatic_sending&&automaticChannelNames(s.automatic_authorized_channels)
  ?(en?'Automatic reception is active for the authorized channels.':'自动接待已生效，仅处理已授权渠道。')
  :(en?'Automatic reception is not active. Check channel availability and separate sending approvals.':'自动接待尚未生效，请核对渠道可用状态和独立发送授权。');
 if(s.ai_auto_reply_enabled)return s.effective_ai_auto_reply
  ?(en?'Automatic drafts are active; agents still send manually.':'自动草稿已生效，仍需客服核对并发送。')
  :(en?'Draft preference saved, but execution or authorization is not active.':'自动草稿偏好已保存，但执行服务或授权尚未生效。');
 return en?'Agent-assisted mode is saved.':'人工辅助模式已保存。';
}
export type AutomaticSource={document_id:string;title:string;version:number};
export const automaticMessages:Record<string,string>={
 automatic_execution_disabled:'自动发送服务尚未开启，请联系平台管理员。',automatic_sender_disabled:'发送身份已停用，请联系平台管理员；重新授权不会恢复停用身份。',
 automatic_sender_invalid:'发送身份配置异常，请联系平台管理员。',automatic_sender_unavailable:'发送身份暂时无法准备或确认，本次未保存授权，请刷新核实。',
 invalid_origin:'此操作必须从当前控制台页面发起。',unauthorized:'登录已失效，请重新登录。',administrator_session_required:'请使用本企业管理员账号；代入会话不能授权。',
 workspace_changed:'当前企业已切换，请重新打开本页面。',management_disabled:'自动接待管理尚未开放。',invalid_payload:'填写内容不符合要求。',
 send_confirmation_required:'请阅读并明确确认自动发送授权。',answer_confirmation_required:'请明确确认批准该问答。',
 exact_answers_retired:'精确问答管理已下线，请在知识库核对并发布内容。',
 wechat_management_disabled:'公众号自动回复授权尚未开放。',wechat_confirmation_required:'请阅读并明确确认所选公众号渠道的授权。',
 primary_authorization_required:'请先完成基础发送授权，再单独确认公众号渠道；未开放的渠道不会执行。',wechat_authorization_conflict:'公众号授权已变化，请刷新后再操作。',
 authorization_conflict:'授权已变化，请刷新后再操作。',answer_revision_conflict:'问答已变化，请刷新后重新审核。',
 answer_not_found:'问答不存在，请刷新列表。',source_not_found:'知识来源不存在，请重新选择。',source_version_changed:'知识版本已变化，请重新选择来源并审核。',
 source_not_eligible:'知识尚未发布或安全检查未完成。',answer_not_eligible:'问答不符合低风险、有效知识和精确问题样例要求。',answer_requires_draft:'请先保存为草稿，再重新批准。',
 body_too_large:'内容过长，请缩短问题样例或答复。',rate_limited:'操作过于频繁，请稍后刷新。',method_not_allowed:'不支持此操作。',
 management_result_uncertain:'结果暂时无法确认，请先刷新查看；不要重复提交。'
};
export const automaticStateLabels:Record<string,string>={queued:'待处理',processing:'处理中',draft:'留待人工',skipped:'已停止',submitting:'提交中',accepted:'平台已受理',
 uncertain:'结果不确定',failed:'未完成',prepared:'已准备',reserved:'已预留点数',requesting:'模型调用中',succeeded:'已完成',abandoned:'占用已过期'};
export const automaticMutationRefreshUncertain='操作请求已返回，但最新状态未能读取；请刷新核实，不要重复提交。';
export function automaticBillingText(state:string|null){
 if(!state)return '暂无扣费记录';
 const labels:Record<string,string>={succeeded:'扣费已完成',reserved:'点数已预留',requesting:'扣费待确认',failed:'扣费未完成',uncertain:'扣费待核查',abandoned:'占用已过期'};
 return labels[state]??'扣费状态待核查';
}
export function automaticBillingReviewText(state:string|undefined){
 const labels:Record<string,string>={not_requested:'尚未请求生成或预留点数',charged:'点数账单已确认；不代表回复已发送',
  held:'点数仍在预留占用中，不重复生成或扣费',released:'未开始模型调用，过期占用已释放',
  not_charged:'当前未扣点数',provider_cost_unknown:'模型用量未确认，当前未扣点数；需人工核查，不自动重试',
  billing_unconfirmed:'账单尚未确认，请核查；不要重复生成'};
 return state?labels[state]??'费用状态待核查':null;
}
export function automaticGenerationReasonText(code:string|null,billingState:string|null){
 // A confirmed ledger result does not repair generation or prove delivery.
 if(code==='billing_outcome_uncertain'&&billingState==='succeeded')return '曾出现扣费确认异常，账务现已核对完成；生成结果仍需人工核查';
 if(code==='provider_rejected')return '模型服务拒绝请求';
 return automaticReasonText(code);
}
export function automaticWechatOutcomeText(task:Pick<AutomaticTask,'channel'|'wechat_outcome'|'wechat_reason'|'wechat_provider_code'>){
 if(!['wechat_official_account','shared_wechat'].includes(task.channel)||!['accepted','rejected','uncertain'].includes(task.wechat_outcome??''))return null;
 const labels:Record<string,string>={provider_accepted:'微信已受理，不代表用户送达或已读',
  execution_disabled:'自动发送已关闭',invalid_target:'公众号或会话绑定无法确认',invalid_content:'答复超过微信长度限制或格式不符合要求',
  source_message_stale:'本条自动回复已过期，请人工查看最新问题',reply_window_expired:'微信回复窗口已关闭，请等待客户再次发消息',
  credentials_unavailable:'公众号凭据暂不可用，请检查渠道配置',authorization_changed:'发送前授权或商家选择已变化',
  attempt_already_claimed:'已有发送尝试，不自动重发',attempt_unconfirmed:'发送领取结果不确定，不自动重发',
  provider_rate_limited:'微信发送频率或额度受限，本条未发送，不自动重发',provider_permission_denied:'微信接口权限不足，本条未发送',
  provider_rejected:'微信拒绝本条回复，请核对渠道配置',provider_result_uncertain:'微信发送结果不确定，不自动重发'};
 const reason=task.wechat_reason??'',text=labels[reason];
 if(!text||(task.wechat_outcome==='accepted')!==(reason==='provider_accepted'))return '微信结果需人工核查，不自动重发';
 const code=task.wechat_provider_code;
 return text+(task.wechat_outcome!=='accepted'&&Number.isInteger(code)&&Number(code)>0&&Number(code)<=2147483647?`（微信错误码 ${code}）`:'');
}
export function automaticWechatHistoryText(task:Pick<AutomaticTask,'channel'|'wechat_outcome'|'wechat_history_state'|'wechat_history_reason'|'wechat_history_attempts'>){
 if(!['wechat_official_account','shared_wechat'].includes(task.channel)||task.wechat_outcome!=='accepted')return null;
 const {wechat_history_state:state,wechat_history_reason:reason,wechat_history_attempts:attempts}=task;
 if(!Number.isInteger(attempts)||Number(attempts)<0||Number(attempts)>12)return '聊天记录状态未确认；不会重复发送微信消息';
 if(state==='recorded'&&reason==='history_recorded'&&Number(attempts)>0)return '已写入聊天记录，不代表用户送达或已读';
 if(['pending','processing'].includes(state??'')&&!reason)return state==='processing'?'正在补记聊天记录；不会重复发送':`聊天记录待补记（已尝试 ${attempts}/12 次）；不会重复发送`;
 if(state==='failed'){
  const labels:Record<string,string>={history_rejected:'聊天记录补记被拒绝，请人工核查',history_unconfirmed:'聊天记录补记未确认，已停止自动重试',
   history_envelope_unavailable:'原回复留存不可用，无法补记聊天记录'};
  if(reason&&labels[reason])return labels[reason]+'；不会重复发送';
 }
 return '聊天记录状态未确认；不会重复发送微信消息';
}
export function aiPointText(value:string|null){
 if(value===null||!/^\d{1,19}$/.test(value))return '—';
 const n=BigInt(value),fraction=String(n%1000000n).padStart(6,'0').replace(/0+$/,'');
 return String(n/1000000n)+(fraction?'.'+fraction:'');
}
export function automaticReasonText(code:string|null){
 const labels:Record<string,string>={generated:'生成完成',approved_exact_answer:'已匹配批准答复',knowledge_grounded_faq:'已核对知识库常见问答',points_insufficient:'AI 点数不足',
  semantic_generated:'长文答复已生成，发送仍须核验',knowledge_grounded_semantic:'知识库长文答复已通过原文及独立核验',verified:'独立来源核验通过',
  exact_styled_generated:'已按所选语气生成答复，发送仍须核验',semantic_styled_generated:'已按所选语气生成知识库答复，发送仍须核验',
  approved_grounded_presentation:'批准问答的语气改写已通过当前来源及独立核验',
  presentation_changed_billed:'生成期间语气、历史、授权或知识已变化，不发送；已产生的用量仍计费',
  presentation_changed_or_unverified:'语气、上下文授权或知识已变化，或核验未完成，不发送',presentation_verification_required:'语气改写仍需来源核验，已转人工处理',
  semantic_review_required:'相关性、来源、条件或冲突核验未通过，交人工处理',invalid_grounding_billed:'已产生生成用量，但原文绑定或条件检查未通过',
  invalid_verdict_billed:'已产生核验用量，但核验格式或结论绑定无效',sources_selected:'已检索并核对当前知识来源',no_current_source:'未找到当前可用来源，检索用量仍计费',
  source_provenance_review_required:'知识范围、来源或命中数量需人工复核',invalid_vector_billed:'已产生检索用量，但检索结果无效',
  authorization_or_source_changed:'授权或知识已变化，未开始核验',authorization_or_source_changed_after_verification:'核验期间授权或知识已变化，不发送',
  authorization_changed_after_embedding:'检索期间授权已变化，不使用检索结果',verification_interrupted_cost_unknown:'核验中断，费用需核查，不自动重试',
  retrieval_interrupted_cost_unknown:'检索中断，费用需核查，不自动重试',billing_or_retrieval_outcome_uncertain:'检索或结算结果待核查，不自动重试',
  provider_rejected:'发送服务拒绝请求，请查看发送明细',provider_outcome_uncertain:'模型结果或用量不确定，未自动重试',reservation_outcome_uncertain:'点数预留结果不确定',
  billing_outcome_uncertain:'扣费结果不确定，请核查',billing_receipt_unavailable:'扣费回执未确认',invalid_output_billed:'已产生用量，答复需人工处理',
  authorization_or_reservation_changed:'授权、知识或点数占用已变化',generation_interrupted_cost_unknown:'处理中断，费用待核查',
  fresh_consent_required:'授权已撤销或变化',send_authorization_changed:'发送前条件已变化',provider_accepted:'平台已受理，不代表客户已读',
  send_outcome_uncertain:'发送结果不确定，不自动重发',high_risk_human_required:'需要人工核实',reply_not_exactly_grounded:'答复需要人工审核',
  reply_wait_conditions_changed:'等待期间客户、授权或接待条件已变化，本次回复已取消',
  reply_wait_expired:'回复超过等待期限，已取消；不会补发旧问题',
  reply_wait_validation_failed:'等待后的核验未完成，未发送，请人工核查',
  worker_interrupted_review_required:'发送处理被中断，需要核查；不会自动重发',
  generation_or_validation_failed:'生成或校验未完成，请人工核查'};
 return code?labels[code]??'请查看任务状态，必要时人工核查。':'—';
}
