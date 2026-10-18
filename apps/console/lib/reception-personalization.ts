export type ReceptionTone='concise'|'neutral'|'friendly_detailed';
export type HistoryPurpose='context'|'style'|'knowledgeDraft';
export const historyPurposeLabels:Record<HistoryPurpose,string>={context:'当前客户历史上下文',style:'学习人工回复语气',knowledgeDraft:'历史聊天生成知识草稿'};
export type PersonalizationSettings={revision:string;draftTone:ReceptionTone;automaticTone:ReceptionTone;learnFromHuman:boolean;timing:{enabled:boolean;minimumSeconds:number;maximumSeconds:number}};
export type PersonalizationView={settings:PersonalizationSettings;availability:{presentation:boolean;history:boolean;draftTone:boolean;automaticTone:boolean;replyTiming:boolean};
 publicLabel:{revision:string;override:boolean|null;platformDefault:boolean;effective:boolean}|null;
 grants:Array<{purpose:HistoryPurpose;enabled:boolean;revision:string;disclosure_version:string;confirmed_at:string}>;
 disclosures:Record<HistoryPurpose,{version:string;text:string}>};
/** Reject malformed/stale authority shapes before rendering confirmation controls. */
export function parsePersonalizationView(input:unknown):PersonalizationView {
 function invalid():never{throw Error(personalizationMessages.personalization_result_uncertain);}
 const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:invalid();
 const rev=(v:unknown):string=>typeof v==='string'&&/^(0|[1-9]\d{0,18})$/.test(v)&&BigInt(v)<9223372036854775807n?v:invalid();
 const tone=(v:unknown):ReceptionTone=>v==='concise'||v==='neutral'||v==='friendly_detailed'?v:invalid();
 const bool=(v:unknown):boolean=>typeof v==='boolean'?v:invalid();
 const versions:Record<HistoryPurpose,string>={context:'reception-history-context-v1',style:'reception-history-style-v1',knowledgeDraft:'reception-history-knowledge-draft-v1'};
 const v=object(input),s=object(v.settings),t=object(s.timing),a=object(v.availability),d=object(v.disclosures);
 // Older gateways cannot attest individual execution services; do not infer
 // active timing or a draft worker from a saved setting or an aggregate flag.
 const details=['draftTone','automaticTone','replyTiming'] as const;
 const hasDetails=details.some(key=>Object.hasOwn(a,key));
 const status=Object.fromEntries(details.map(key=>[key,hasDetails?bool(a[key]):false])) as Pick<PersonalizationView['availability'],typeof details[number]>;
 if(hasDetails&&(bool(a.presentation)!==(status.draftTone||status.automaticTone)||status.replyTiming&&!status.automaticTone))invalid();
 if(!Number.isInteger(t.minimumSeconds)||!Number.isInteger(t.maximumSeconds)||Number(t.minimumSeconds)<1||Number(t.maximumSeconds)>120||Number(t.maximumSeconds)<=Number(t.minimumSeconds))invalid();
 if(!Array.isArray(v.grants)||v.grants.length>3)invalid();
 const seen=new Set<string>();
 const grants=v.grants.map(value=>{const g=object(value),p=g.purpose;
  if(typeof p!=='string'||!Object.hasOwn(versions,p)||seen.has(p))invalid();seen.add(p);
  const purpose=p as HistoryPurpose;
  if(g.disclosure_version!==versions[purpose]||typeof g.confirmed_at!=='string'||!Number.isFinite(Date.parse(g.confirmed_at)))invalid();
  const revision=rev(g.revision);if(revision==='0')invalid();
  return {purpose,enabled:bool(g.enabled),revision,disclosure_version:versions[purpose],confirmed_at:g.confirmed_at as string};
 });
 const disclosures={} as PersonalizationView['disclosures'];
 for(const p of Object.keys(versions) as HistoryPurpose[]){const row=object(d[p]);
  if(row.version!==versions[p]||typeof row.text!=='string'||row.text.length<1||row.text.length>4000)invalid();
  disclosures[p]={version:versions[p],text:row.text as string};
 }
 let publicLabel:PersonalizationView['publicLabel']=null;
 if(v.publicLabel!==undefined&&v.publicLabel!==null){const label=object(v.publicLabel);
  const override=label.override===null?null:bool(label.override),platformDefault=bool(label.platformDefault),effective=bool(label.effective);
  if(effective!==(override??platformDefault))invalid();
  publicLabel={revision:rev(label.revision),override,platformDefault,effective};
 }
 return {publicLabel,settings:{revision:rev(s.revision),draftTone:tone(s.draftTone),automaticTone:tone(s.automaticTone),learnFromHuman:bool(s.learnFromHuman),
  timing:{enabled:bool(t.enabled),minimumSeconds:Number(t.minimumSeconds),maximumSeconds:Number(t.maximumSeconds)}},
  grants,disclosures,availability:{presentation:bool(a.presentation),history:bool(a.history),...status}};
}
export const personalizationMessages:Record<string,string>={not_found:'此功能尚未开放。',method_not_allowed:'不支持此操作。',unauthorized:'请先登录。',invalid_origin:'请求来源校验失败。',
 administrator_session_required:'请使用本企业管理员账号操作；代入和嵌入会话不能授权。',workspace_changed:'当前企业已切换，请重新打开页面。',invalid_payload:'请检查语气与时间设置。',
 history_confirmation_required:'请阅读并明确确认该历史用途。',history_style_authorization_required:'请先确认人工语气学习授权。',history_channel_unavailable:'会话服务尚未就绪，暂不能授权历史读取。',
 personalization_revision_conflict:'配置或授权已变化，请刷新后再操作。',rate_limited:'操作过于频繁，请稍后刷新。',body_too_large:'请求内容过长。',body_timeout:'请求读取超时。',
 personalization_result_uncertain:'操作结果暂时无法确认，请刷新核实，不要重复提交。'};
