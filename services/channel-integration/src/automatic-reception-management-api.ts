import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Pool} from 'pg';
import {AutomaticManagementError,automaticUuid,manageAutomaticReception,validateAutomaticManagementAction,type AutomaticManagementAction} from './automatic-reception-management.js';
import {readAutomaticReceptionStatus,readAutomaticReceptionSources} from './automatic-reception-status.js';
import {consumeAutomaticManagementRate} from './automatic-reception-auth.js';
import {manageAutomaticWeChatGrant} from './automatic-wechat-management.js';
import type {AutomaticSenderPort} from './automatic-sender.js';
const base='/api/v1/automatic-reception/management';
const messages:Record<string,string>={exact_answers_retired:'逐条批准问答已下线，请在知识库发布内容，由知识检索及核验统一接待。',unauthorized:'请先登录。',administrator_session_required:'请使用本企业管理员账号操作；代入和嵌入会话不能授权。',
 automatic_execution_disabled:'自动发送服务尚未开启，请联系平台管理员。',automatic_sender_disabled:'自动发送身份已停用，请联系平台管理员；重新授权不会恢复停用身份。',
 automatic_sender_invalid:'自动发送身份配置异常，请联系平台管理员。',automatic_sender_unavailable:'自动发送身份暂时无法准备或确认，本次未保存授权，请稍后刷新核实。',
 management_disabled:'自动接待管理尚未开放。',wechat_management_disabled:'公众号自动回复授权尚未开放。',wechat_confirmation_required:'请阅读并明确确认所选公众号渠道的授权。',primary_authorization_required:'请先开启网站聊天自动接待授权，再单独授权公众号。',wechat_authorization_conflict:'公众号授权已变化，请刷新后再操作。',workspace_changed:'当前企业已切换，请重新打开页面。',rate_limited:'操作过于频繁，请稍后刷新。',invalid_payload:'请求参数不正确。',send_confirmation_required:'请阅读并明确确认自动发送授权。',answer_confirmation_required:'请确认批准该问答自动发送。',
 authorization_conflict:'授权已变化，请刷新后再操作。',answer_revision_conflict:'问答已变化，请刷新后重新审核。',answer_not_found:'问答不存在。',source_not_found:'知识来源不存在。',
 source_version_changed:'知识来源版本已变化，请更新问答后重新审核。',source_not_eligible:'知识尚未有效发布或安全检查未完成。',answer_not_eligible:'问答不符合低风险、有效知识和明确问题样例要求。',
 answer_requires_draft:'请先保存为待审批草稿，再重新批准。',management_result_uncertain:'操作结果暂时无法确认，请刷新查看；不要重复提交。',method_not_allowed:'不支持此操作。',body_too_large:'请求内容过长。'};
function json(response:ServerResponse,status:number,value:unknown){response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});response.end(JSON.stringify(value));}
/** Default-off gateway route. The console proxy retains same-origin/CSRF guards. */
export function createAutomaticManagementApi(db:Pick<Pool,'connect'>,options:{enabled?:()=>boolean;wechatEnabled?:()=>boolean;requireWorkspaceHeader?:boolean;sender?:AutomaticSenderPort}={}){
 return async(request:IncomingMessage,response:ServerResponse,url:URL):Promise<boolean>=>{
  if(url.pathname!==base&&!url.pathname.startsWith(base+'/'))return false;
  try{
   if(!(options.enabled??(()=>false))())throw new AutomaticManagementError('management_disabled',503);
   const bearer=request.headers.authorization??'';
   if(!/^Bearer [a-f0-9]{64}$/.test(bearer))throw new AutomaticManagementError('unauthorized',401);
   const expected=request.headers['x-replynest-workspace'];
   if(expected!==undefined&&(typeof expected!=='string'||!expected.trim()||expected.length>200)||options.requireWorkspaceHeader&&expected===undefined)throw new AutomaticManagementError('workspace_changed',409);
   const rate=await consumeAutomaticManagementRate(db,bearer.slice(7),request.method!=='GET',expected as string|undefined);
   if(rate){if(rate==='rate_limited')response.setHeader('Retry-After','60');throw new AutomaticManagementError(rate,rate==='rate_limited'?429:rate==='workspace_changed'?409:403);}
   let action:AutomaticManagementAction;
   if(request.method==='GET'&&[base,base+'/tasks',base+'/sources'].includes(url.pathname)){
    if([...url.searchParams.keys()].some(k=>!['after','limit'].includes(k))||url.searchParams.getAll('after').length>1||url.searchParams.getAll('limit').length>1)throw new AutomaticManagementError('invalid_payload');
    const after=url.searchParams.get('after'),limit=url.searchParams.get('limit')??'25';
    if(!/^([1-9]|1\d|2[0-5])$/.test(limit))throw new AutomaticManagementError('invalid_payload');
    if(url.pathname===base+'/tasks'){
     json(response,200,{data:await readAutomaticReceptionStatus(db,bearer.slice(7),Number(limit),after,expected as string|undefined,
      {wechatOutcomes:(options.wechatEnabled??(()=>false))()})});return true;
    }
    if(url.pathname===base+'/sources'){
     json(response,200,{data:await readAutomaticReceptionSources(db,bearer.slice(7),Number(limit),after,expected as string|undefined)});return true;
    }
    if(after!==null&&!automaticUuid(after))throw new AutomaticManagementError('invalid_payload');
    action={kind:'list',after,limit:Number(limit)};
   }else{
    if(request.method!=='POST'||url.search)throw new AutomaticManagementError('method_not_allowed',405);
    const route=url.pathname.slice(base.length),match=route.match(/^\/answers\/([0-9a-f-]{36})\/(replace|approve|disable)$/);
    const kind=route==='/wechat-grant'?'wechat-grant':route==='/grant'?'grant':route==='/answers'?'create':match?.[2];
    if(kind&&kind!=='grant'&&kind!=='wechat-grant')throw new AutomaticManagementError('exact_answers_retired',410);
    if(!kind)throw new AutomaticManagementError('method_not_allowed',405);
    if(kind==='wechat-grant'&&!(options.wechatEnabled??(()=>false))())throw new AutomaticManagementError('wechat_management_disabled',503);
    if((request.headers['content-type']??'').split(';')[0].trim().toLowerCase()!=='application/json')throw new AutomaticManagementError('invalid_payload');
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of request){const b=Buffer.from(chunk);size+=b.length;if(size>32768)throw new AutomaticManagementError('body_too_large',413);chunks.push(b);}
    let body:unknown;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new AutomaticManagementError('invalid_payload');}
    if(kind==='wechat-grant'){
     json(response,200,{data:await manageAutomaticWeChatGrant(db,bearer.slice(7),body,expected as string|undefined)});return true;
    }
    action=validateAutomaticManagementAction(kind as 'grant'|'create'|'replace'|'approve'|'disable',body,match?.[1]);
   }
   json(response,200,{data:await manageAutomaticReception(db,bearer.slice(7),action,expected as string|undefined,{wechat:(options.wechatEnabled??(()=>false))(),sender:options.sender})});
  }catch(error){const e=error instanceof AutomaticManagementError?error:new AutomaticManagementError('management_result_uncertain',503);json(response,e.status,{error:{code:e.code,message:messages[e.code]??messages.management_result_uncertain}});}
  return true;
 };
}
