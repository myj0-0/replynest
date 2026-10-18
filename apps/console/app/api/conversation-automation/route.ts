import {activityGatewayFetch} from "../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { fetchConsoleSession, gatewayUrl, hasValidOrigin, sessionToken } from "../../../lib/console-session";

const messages:Record<string,string>={invalid_origin:'请从当前控制台页面操作。',unauthorized:'登录已失效，请重新登录。',
  automatic_execution_disabled:'自动发送服务尚未开启，请联系平台管理员。',automatic_sender_disabled:'发送身份已停用，请联系平台管理员。',
  automatic_sender_invalid:'发送身份配置异常，请联系平台管理员。',automatic_sender_unavailable:'发送身份暂时无法核实，本次未启用，请刷新查看。',
  administrator_session_required:'请使用企业管理员账号；代入会话不能修改接待模式。',workspace_changed:'当前企业已切换，请重新打开本页面。',
  invalid_request:'接待模式设置格式不正确。',body_too_large:'设置内容过长。',invalid_automation_settings:'接待模式或置信度阈值不符合要求。',
  enable_confirmation_required:'请阅读并明确确认本次更改。',automatic_reception_unavailable:'自动接待尚未开放，请选择人工辅助或自动草稿。',
  send_confirmation_required:'请先在自动接待管理中确认独立发送授权。',channel_send_confirmation_required:'当前渠道尚未获得发送授权，请先确认对应渠道。',
  tenant_admin_console_session_required:'仅企业管理员可修改接待模式。',upstream_unavailable:'保存结果暂时无法确认，请刷新核实，不要重复提交。'};
function error(code:string,status:number){return NextResponse.json({error:{code,message:messages[code]??messages.upstream_unavailable}},
  {status,headers:{'cache-control':'no-store'}});}
async function boundedJson(stream:ReadableStream<Uint8Array>|null,max:number){
  if(!stream)throw Error('invalid_request');
  const reader=stream.getReader(),parts:Uint8Array[]=[];let size=0,expired=false;
  const timer=setTimeout(()=>{expired=true;void reader.cancel().catch(()=>{});},7000);
  try{
    for(;;){const {value,done}=await reader.read();if(expired)throw Error('invalid_request');if(done)break;
      size+=value.length;if(size>max)throw Error('body_too_large');parts.push(value);}
    const all=new Uint8Array(size);let at=0;for(const part of parts){all.set(part,at);at+=part.length;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all));
  }catch(e){await reader.cancel().catch(()=>{});throw e;}finally{clearTimeout(timer);reader.releaseLock();}
}

export async function PATCH(request: NextRequest) {
  if (!hasValidOrigin(request)||request.headers.get('x-replynest-action')!=='conversation-automation-v1'||
      ['cross-site','same-site'].includes(request.headers.get('sec-fetch-site')??'')) return error('invalid_origin',403);
  const token = await sessionToken();
  if (!token) return error('unauthorized',401);
  const session=await fetchConsoleSession();
  if(!session)return error('unauthorized',401);
  const workspace=session.workspaces.find(w=>w.tenant_id===session.selected_tenant_id);
  if(!workspace||workspace.role!=='tenant_admin'||session.impersonation)return error('administrator_session_required',403);
  if(request.headers.get('x-replynest-workspace')!==workspace.tenant_id)return error('workspace_changed',409);
  if(request.nextUrl.search||(request.headers.get('content-type')??'').split(';')[0].trim()!=='application/json')return error('invalid_request',400);
  let input: unknown;
  try { input=await boundedJson(request.body,4096); } catch(e) { return error(e instanceof Error&&e.message==='body_too_large'?'body_too_large':'invalid_request',e instanceof Error&&e.message==='body_too_large'?413:400); }
  try {
    const upstream = await activityGatewayFetch(gatewayUrl("/api/v1/conversation-automation"), {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json",'x-replynest-workspace':workspace.tenant_id },
      body: JSON.stringify(input), cache: "no-store", redirect:'error', signal: AbortSignal.timeout(7_000)
    });
    const result=await boundedJson(upstream.body,65536);
    if(!upstream.ok){const code=typeof result?.error?.code==='string'&&Object.hasOwn(messages,result.error.code)?result.error.code:'upstream_unavailable';return error(code,upstream.status);}
    if(!result?.data||typeof result.data!=='object')return error('upstream_unavailable',503);
    return NextResponse.json({data:result.data}, {headers:{'cache-control':'no-store'}});
  } catch { return error('upstream_unavailable',503); }
}
