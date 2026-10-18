/** Presentation only: stored events, customer wording and delivery state stay unchanged. */
export function workbenchRole(value:string,en:boolean){
 const labels:Record<string,[string,string]>={agent:['人工客服','Agent'],supervisor:['客服主管','Supervisor'],tenant_admin:['企业管理员','Company administrator']};
 return labels[value]?.[en?1:0]??value;
}
export function workbenchChannel(value:string|undefined,en:boolean){
 const labels:Record<string,[string,string]>={shared_wechat:['共享微信公众号','Shared WeChat account'],wechat:['微信公众号','WeChat account'],web_chat:['网站聊天','Website chat'],website:['网站聊天','Website chat']};
 return value?(labels[value]?.[en?1:0]??value):(en?'Unknown channel':'未知渠道');
}
export function workbenchDelivery(value:string,en:boolean){
 const labels:Record<string,[string,string]>={sent:['已发送 · 不代表已读','Sent · not a read receipt'],delivered:['渠道已确认送达','Channel delivery confirmed'],read:['渠道已确认已读','Channel read receipt confirmed'],failed:['发送失败','Send failed'],pending:['等待渠道投递','Awaiting channel delivery']};
 return labels[value]?.[en?1:0]??value;
}
export function workbenchTransfer(value:string,en:boolean){
 const labels:Record<string,[string,string]>={pending_upload:['等待客户上传','Waiting for customer upload'],ready:['可下载','Ready'],scanning:['正在安全扫描','Scanning'],pending_scan:['等待安全扫描','Awaiting scan'],rejected:['安全检查未通过','Safety check rejected'],failed:['处理失败','Processing failed'],expired:['已过期','Expired'],deleted:['已删除','Deleted']};
 return labels[value]?.[en?1:0]??value;
}
function priority(value:string){return ({urgent:'紧急',high:'高',medium:'中',low:'低',none:'无'} as Record<string,string>)[value.toLowerCase()]??value;}
/** Only for native activity messages; unknown/new templates retain original wording. */
export function conversationActivity(value:string|null,en:boolean):string{
 if(!value)return en?'Conversation activity':'会话动态';
 if(en||value.length>2048)return value;
 const exact:Record<string,string>={
  'System reopened the conversation due to a new incoming message.':'系统因收到客户新消息，将会话恢复为待处理。',
  'Conversation was marked open automatically after an agent reply':'客服回复后，系统将会话恢复为待处理。',
  'Conversation was marked open by system due to an error with the agent bot.':'自动客服发生异常，系统已将会话设为待处理。',
  'CSAT survey not sent due to outgoing message restrictions':'受渠道发送限制，满意度调查未发送。',
  'Auto-resolve message not sent due to outgoing message restrictions':'受渠道发送限制，自动结束会话提示未发送。'
 };
 if(exact[value])return exact[value];
 const rules:Array<[RegExp,(match:RegExpMatchArray)=>string]>=[
  [/^Assigned to (.+) via (.+) by (.+)$/,m=>`${m[3]} 通过 ${m[2]} 将会话分配给 ${m[1]}`],
  [/^Assigned to (.+) by (.+)$/,m=>`${m[2]} 将会话分配给 ${m[1]}`],
  [/^(.+) self-assigned this conversation$/,m=>`${m[1]} 认领了此会话`],
  [/^Conversation unassigned by (.+)$/,m=>`${m[1]} 取消了此会话的负责人`],
  [/^Unassigned from (.+) by (.+)$/,m=>`${m[2]} 取消了此会话与 ${m[1]} 的分配`],
  [/^Conversation was marked resolved by system due to (\d+) (days|hours|minutes) of inactivity$/,m=>`会话连续 ${m[1]} ${({days:'天',hours:'小时',minutes:'分钟'} as Record<string,string>)[m[2]]}无互动，系统已标记为已解决`],
  [/^Conversation was marked resolved by (.+) due to inactivity$/,m=>`${m[1]} 因长时间无互动，将会话标记为已解决`],
  [/^Conversation was marked resolved by (.+)$/,m=>`${m[1]} 将会话标记为已解决`],
  [/^Conversation was resolved by (.+)$/,m=>`${m[1]} 结束了此会话`],
  [/^Conversation was reopened by (.+)$/,m=>`${m[1]} 将会话恢复为待处理`],
  [/^Conversation was marked open by (.+)$/,m=>`${m[1]} 将会话设为待处理`],
  [/^Conversation was marked as pending by (.+)$/,m=>`${m[1]} 将会话设为等待中`],
  [/^Conversation was snoozed by (.+)$/,m=>`${m[1]} 将会话设为稍后处理`],
  [/^(.+) changed the priority from (\w+) to (\w+)$/,m=>`${m[1]} 将优先级从${priority(m[2])}改为${priority(m[3])}`],
  [/^(.+) set the priority to (\w+)$/,m=>`${m[1]} 将优先级设为${priority(m[2])}`],
  [/^(.+) removed the priority$/,m=>`${m[1]} 清除了优先级`],
  [/^(.+) added SLA policy (.+)$/,m=>`${m[1]} 添加了 SLA 策略 ${m[2]}`],
  [/^(.+) removed SLA policy (.+)$/,m=>`${m[1]} 移除了 SLA 策略 ${m[2]}`],
  [/^(.+) has muted the conversation$/,m=>`${m[1]} 将会话设为静音`],
  [/^(.+) has unmuted the conversation$/,m=>`${m[1]} 取消了会话静音`],
  [/^(.+) added (.+)$/,m=>`${m[1]} 添加了标签 ${m[2]}`],
  [/^(.+) removed (.+)$/,m=>`${m[1]} 移除了标签 ${m[2]}`]
 ];
 for(const [pattern,label] of rules){const match=value.match(pattern);if(match)return label(match);}
 return value;
}
