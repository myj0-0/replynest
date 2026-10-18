import type { IncomingMessage, ServerResponse } from "node:http";
import { workbenchChannelStatus } from './workbench-channel-status.js';
import { sharedWechatConfig } from "./shared-wechat-config.js";
import { createHash } from "node:crypto";
import { pool } from "./database.js";
import { readBody, sendJson, requiredEnv } from "./shared.js";
import {
  assignChatwootConversation, ChatwootReadError, ChatwootWriteError, createChatwootOutgoingMessage, fetchChatwootAttachment,
  findChatwootMessage, getChatwootConversation, listChatwootConversations, listChatwootMessages,
  updateChatwootConversationStatus, type ChatwootRecord
} from "./conversation-headless-chatwoot.js";
import {
  attachmentDisposition, canPerformConversationAction, decodeConversationCursor, encodeConversationCursor, isoTimestamp, normalizeConversationStatus,
  normalizeMessageDirection, publicAttachment, safeInlineAttachmentType, safeText, sanitizeAttachmentFileName,
  type PublicAttachment
} from "./conversation-headless-core.js";
import { validateConversationAutomationSettings } from "./conversation-automation-core.js";
import {revokeAutomaticGrantForMode} from './automatic-reception-mode.js';
import {authenticateAutomaticAdministrator} from './automatic-reception-auth.js';
import {automaticRuntimeChannels,readAutomaticAuthorizedChannels,type AutomaticChannel} from './automatic-reception-capabilities.js';
import {AUTOMATIC_SEND_CONSENT_VERSION} from './automatic-reply-policy.js';
import {inspectAutomaticSender,automaticSenderError,type AutomaticSenderPort,type AutomaticSenderState} from './automatic-sender.js';
import { canEditCustomerProfile, validateCustomerProfile } from "./customer-profile-core.js";
import { ensureSharedWechatCustomer } from "./shared-wechat-customer.js";
import { syncWebChatContact } from "./web-chat-api.js";
import { prepareSharedWorkbenchReply, dispatchSharedWorkbenchReply, sharedWorkbenchMessageStatus, SharedWorkbenchError } from "./shared-wechat-workbench.js";
import { createSharedWechatTransport } from "./shared-wechat-transport.js";
import { secretValue } from "./secret-value.js";
import { parseWorkbenchSearch, likeLiteral } from "./workbench-search.js";
import {loadConversationPageContext,pageAssigneeId,type ConversationPageContext} from './conversation-page-context.js';
import {createAutomaticNativeClient} from './automatic-web-native-client.js';
import {validateCustomerAutomationControl} from './customer-automation-core.js';
import {authenticateConsoleSession} from './console-auth.js';
import {mediaByteRange} from './media-byte-range.js';
import {wechatCustomerName} from './wechat-customer-name.js';
import {safeWechatAvatar} from './shared-wechat-portal.js';
import {createWorkbenchReadNativeClient,type WorkbenchReadCount} from './workbench-read-native-client.js';
import {createCustomerInsightsStore} from './customer-insights-store.js';

type HeadlessAuth = {
  impersonation_id?: string | null;
  tenant_id: string;
  platform_user_id: string | null;
  actor_id: string;
  auth_kind: "api_key" | "console_session";
  role: "tenant_admin" | "supervisor" | "agent";
};

type ResourceType = "conversation" | "message" | "attachment";

type ContactProjection = { id: string; display_name: string; channel: string; avatar_url?:string|null } | null;
type AssignmentProjection = { member_id: string; display_name: string; role: string } | null;
type AssignmentCandidate = { member_id: string; display_name: string; role: string };

function reply(response: ServerResponse, status: number, requestId: string, body: Record<string, unknown>) {
  sendJson(response, status, { request_id: requestId, ...body });
}

function upstreamId(raw: ChatwootRecord): string | undefined {
  const value = raw.id;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value)
    : typeof value === "string" && /^\d+$/.test(value) ? value : undefined;
}

function assertAccount(raw: ChatwootRecord, accountId: string): void {
  if (String(raw.account_id ?? "") !== accountId) throw new Error("Chatwoot account boundary mismatch");
}

async function tenantAccountId(tenantId: string): Promise<string | undefined> {
  const result = await pool.query<{ chatwoot_account_id: string }>(
    `SELECT chatwoot_account_id::text FROM tenants WHERE tenant_id=$1 AND status IN ('active','test') AND chatwoot_account_id IS NOT NULL`,
    [tenantId]
  );
  return result.rows[0]?.chatwoot_account_id;
}

async function assignmentCandidates(tenantId: string, accountId: string): Promise<AssignmentCandidate[]> {
  const result = await pool.query<{ platform_user_id: string; display_name: string; role: string }>(
    `SELECT m.platform_user_id::text,u.display_name,m.role
       FROM tenant_memberships m JOIN platform_users u ON u.platform_user_id=m.platform_user_id
      WHERE m.tenant_id=$1 AND m.chatwoot_account_id=$2 AND m.status='active'
        AND m.chatwoot_sync_status='synced' AND m.chatwoot_user_id IS NOT NULL
      ORDER BY CASE m.role WHEN 'tenant_admin' THEN 1 WHEN 'supervisor' THEN 2 ELSE 3 END,u.display_name,m.platform_user_id`,
    [tenantId, accountId]
  );
  return result.rows.map(row => ({ member_id: row.platform_user_id, display_name: row.display_name, role: row.role }));
}

import {ensureConversationMapping} from './conversation-mapping.js';
import {readStored} from './file-storage.js';
const ensureResourceId=(tenantId:string,type:ResourceType,accountId:string,chatwootId:string,parentId:string|null=null)=>ensureConversationMapping(pool,tenantId,type,accountId,chatwootId,parentId);

async function resolveResource(tenantId: string, type: ResourceType, replynestId: string) {
  const result = await pool.query<{ chatwoot_account_id: string; chatwoot_resource_id: string; parent_replynest_resource_id: string | null }>(
    `SELECT chatwoot_account_id::text,chatwoot_resource_id,parent_replynest_resource_id::text FROM conversation_resource_mappings
      WHERE tenant_id=$1 AND resource_type=$2 AND replynest_resource_id=$3`,
    [tenantId, type, replynestId]
  );
  return result.rows[0];
}

function findAttachment(rawMessage: ChatwootRecord, attachmentUpstreamId: string): ChatwootRecord | undefined {
  const attachments = Array.isArray(rawMessage.attachments)
    ? rawMessage.attachments.filter((item): item is ChatwootRecord => Boolean(item) && typeof item === "object") : [];
  const fallback = attachmentUpstreamId.match(/^(\d+):(\d+)$/);
  if (fallback && String(rawMessage.id ?? "") === fallback[1]) return attachments[Number(fallback[2])];
  return attachments.find(item => String(item.id ?? "") === attachmentUpstreamId);
}

let activeAttachmentDownloads = 0;

async function serveAttachment(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  auth: HeadlessAuth,
  requestId: string,
  attachmentReplynestId: string,
  accountId: string
) {
  if (activeAttachmentDownloads >= 4) {
    reply(response, 429, requestId, { error: { code: "attachment_proxy_busy", message: "附件服务繁忙，请稍后重试" } });
    return;
  }
  const attachment = await resolveResource(auth.tenant_id, "attachment", attachmentReplynestId);
  if (!attachment || attachment.chatwoot_account_id !== accountId || !attachment.parent_replynest_resource_id) {
    reply(response, 404, requestId, { error: { code: "attachment_not_found", message: "附件不存在" } });
    return;
  }
  const message = await resolveResource(auth.tenant_id, "message", attachment.parent_replynest_resource_id);
  if (!message || message.chatwoot_account_id !== accountId || !message.parent_replynest_resource_id) {
    reply(response, 404, requestId, { error: { code: "attachment_not_found", message: "附件不存在" } });
    return;
  }
  const conversation = await resolveResource(auth.tenant_id, "conversation", message.parent_replynest_resource_id);
  if (!conversation || conversation.chatwoot_account_id !== accountId) {
    reply(response, 404, requestId, { error: { code: "attachment_not_found", message: "附件不存在" } });
    return;
  }
  activeAttachmentDownloads += 1;
  try {
    const rawMessage = await findChatwootMessage(accountId, conversation.chatwoot_resource_id, message.chatwoot_resource_id);
    if (!rawMessage || String(rawMessage.account_id ?? accountId) !== accountId || String(rawMessage.conversation_id ?? "") !== conversation.chatwoot_resource_id) {
      reply(response, 404, requestId, { error: { code: "attachment_not_found", message: "附件不存在" } });
      return;
    }
    if(process.env.WECHAT_MEDIA_ENABLED==='true'&&attachment.chatwoot_resource_id.startsWith('wechat-media:')){
      const row=(await pool.query(`SELECT * FROM wechat_message_media WHERE tenant_id=$1 AND media_id=$2 AND account_id=$3 AND conversation_id=$4 AND message_id=$5`,[auth.tenant_id,attachment.chatwoot_resource_id.slice(13),accountId,conversation.chatwoot_resource_id,message.chatwoot_resource_id])).rows[0];
      if(!row||row.status!=='ready'||new Date(row.expires_at).getTime()<=Date.now()||!row.storage_key){reply(response,404,requestId,{error:{code:'media_not_available',message:'媒体正在安全处理、未通过处理或已过期'}});return;}
      const bytes=await readStored(row.storage_key);
      if(bytes.length!==Number(row.size_bytes)||bytes.length>10*1024*1024)throw Error('media_storage_mismatch');
      await auditRead(auth,'attachment.downloaded','attachment',attachmentReplynestId,requestId,1);
      const range=mediaByteRange(request.headers.range,bytes.length);
      if(range===null){response.writeHead(416,{'content-range':`bytes */${bytes.length}`,'cache-control':'private, no-store'});response.end();return;}
      const body=range?bytes.subarray(range.start,range.end+1):bytes;
      response.writeHead(range?206:200,{'content-type':row.mime_type,'content-length':String(body.length),'accept-ranges':'bytes',...(range?{'content-range':`bytes ${range.start}-${range.end}/${bytes.length}`}:{ }),'content-disposition':attachmentDisposition(row.file_name,url.searchParams.get('disposition')==='inline'&&safeInlineAttachmentType(row.mime_type)),
        'cache-control':'private, no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox",'referrer-policy':'no-referrer'});
      response.end(body);return;
    }
    const rawAttachment = findAttachment(rawMessage, attachment.chatwoot_resource_id);
    const rawUrl = rawAttachment && typeof rawAttachment.data_url === "string" ? rawAttachment.data_url : undefined;
    if (!rawAttachment || !rawUrl) {
      reply(response, 404, requestId, { error: { code: "attachment_not_found", message: "附件不存在或已失效" } });
      return;
    }
    const downloaded = await fetchChatwootAttachment(rawUrl);
    const requestedInline = url.searchParams.get("disposition") === "inline";
    const inline = requestedInline && safeInlineAttachmentType(downloaded.contentType);
    const fileName = sanitizeAttachmentFileName(rawAttachment.file_name ?? rawAttachment.fallback_title, `attachment-${attachmentReplynestId}`);
    await auditRead(auth, "attachment.downloaded", "attachment", attachmentReplynestId, requestId, 1);
    response.writeHead(200, {
      "content-type": downloaded.contentType,
      "content-length": String(downloaded.contentLength),
      "content-disposition": attachmentDisposition(fileName, inline),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "referrer-policy": "no-referrer",
      "x-request-id": requestId
    });
    response.end(downloaded.bytes);
  } finally {
    activeAttachmentDownloads -= 1;
  }
}

async function projectContact(tenantId: string, conversationId: string): Promise<ContactProjection> {
  if(process.env.SHARED_WECHAT_DELIVERY_ENABLED==="true") await ensureSharedWechatCustomer(pool,tenantId,conversationId);
  const shared=process.env.SHARED_WECHAT_DELIVERY_ENABLED==='true';
  const profiles=shared&&process.env.SHARED_WECHAT_MANAGEMENT_ENABLED==='true';
  const result = await pool.query<{ customer_id: string; name: string; channel: string; wechat_open_id:string|null; nickname:string|null;avatar_url:string|null }>(
    `SELECT c.customer_id::text,c.name,i.channel,${profiles?'p.nickname':'NULL'} AS nickname,${profiles?'p.avatar_url':'NULL'} AS avatar_url,
       CASE WHEN i.channel='shared_wechat' THEN ${shared?'b.open_id':'NULL'} ELSE i.external_user_id END AS wechat_open_id FROM channel_identities i
       JOIN customers c ON c.tenant_id=i.tenant_id AND c.customer_id=i.customer_id
       ${shared?`LEFT JOIN shared_wechat_threads b ON i.channel='shared_wechat' AND b.tenant_id=i.tenant_id
        AND b.conversation_id=i.chatwoot_conversation_id AND b.contact_id=i.chatwoot_contact_id
        AND b.account_id=(SELECT chatwoot_account_id FROM tenants WHERE tenant_id=i.tenant_id)`:''}
      ${profiles?`LEFT JOIN shared_wechat_authorized_profiles p ON p.app_id=b.app_id AND p.open_id=b.open_id AND p.expires_at>NOW()`:''}
      WHERE i.tenant_id=$1 AND i.chatwoot_conversation_id=$2 LIMIT 1`,
    [tenantId, conversationId]
  );
  const row = result.rows[0];
  return row ? { id: row.customer_id, display_name: wechatCustomerName(row.name,row.channel,row.wechat_open_id,row.nickname), channel: row.channel,
    avatar_url:profiles&&row.channel==='shared_wechat'?(safeWechatAvatar(row.avatar_url)||null):null } : null;
}

async function projectAssignment(tenantId: string, raw: ChatwootRecord): Promise<AssignmentProjection> {
  const meta = raw.meta && typeof raw.meta === "object" ? raw.meta as ChatwootRecord : {};
  const assignee = meta.assignee && typeof meta.assignee === "object" ? meta.assignee as ChatwootRecord : undefined;
  const id = assignee?.id;
  if ((typeof id !== "number" && typeof id !== "string") || !/^\d+$/.test(String(id))) return null;
  const result = await pool.query<{ platform_user_id: string; display_name: string; role: string }>(
    `SELECT m.platform_user_id::text,u.display_name,m.role FROM tenant_memberships m
       JOIN platform_users u ON u.platform_user_id=m.platform_user_id
      WHERE m.tenant_id=$1 AND m.chatwoot_user_id=$2 AND m.status='active' LIMIT 1`,
    [tenantId, String(id)]
  );
  const row = result.rows[0];
  return row ? { member_id: row.platform_user_id, display_name: row.display_name, role: row.role } : null;
}

async function projectMessage(tenantId: string, accountId: string, conversationReplynestId: string, raw: ChatwootRecord) {
  const id = upstreamId(raw);
  if (!id) return undefined;
  const replynestId = await ensureResourceId(tenantId, "message", accountId, id, conversationReplynestId);
  const attachments = Array.isArray(raw.attachments) ? raw.attachments.filter((item): item is ChatwootRecord => Boolean(item) && typeof item === "object") : [];
  const projectedAttachments: PublicAttachment[] = [];
  if(process.env.WECHAT_MEDIA_ENABLED==='true'){
    const media=(await pool.query('SELECT * FROM wechat_message_media WHERE tenant_id=$1 AND account_id=$2 AND message_id=$3 AND conversation_replynest_id=$4',[tenantId,accountId,id,conversationReplynestId])).rows[0];
    if(media){
      const attachmentId=await ensureResourceId(tenantId,'attachment',accountId,`wechat-media:${media.media_id}`,replynestId);
      projectedAttachments.push({...publicAttachment(attachmentId,{file_name:media.file_name??`微信${{image:'图片',video:'视频',voice:'语音'}[media.descriptor.kind as 'image'|'video'|'voice']}`,content_type:media.mime_type,file_type:media.descriptor.kind,file_size:media.size_bytes}),
        processing_status:new Date(media.expires_at).getTime()<=Date.now()?'expired':media.status,download_available:media.status==='ready'&&new Date(media.expires_at).getTime()>Date.now()});
    }
  }
  for (const [index, attachment] of attachments.entries()) {
    const attachmentUpstreamId = upstreamId(attachment) ?? `${id}:${index}`;
    const attachmentId = await ensureResourceId(tenantId, "attachment", accountId, attachmentUpstreamId, replynestId);
    projectedAttachments.push(publicAttachment(attachmentId, attachment));
  }
  const sender = raw.sender && typeof raw.sender === "object" ? raw.sender as ChatwootRecord : {};
  const contentAttributes = raw.content_attributes as Record<string,unknown> | undefined;
  let sharedStatus: string | undefined;
  if(contentAttributes?.replynest_transport==='wechat_media_manual'){
    const row=(await pool.query('SELECT state,response_body FROM conversation_message_commands WHERE tenant_id=$1 AND command_id=$2',[tenantId,contentAttributes.replynest_command_id])).rows[0];
    sharedStatus=row?.state==='accepted'?'微信已接受 · 不代表已读':row?.state==='failed'?'媒体未发送':row?.state==='uncertain'?'结果待核对 · 请勿重发':'媒体发送处理中';
    if(['failed','uncertain'].includes(row?.state)&&row?.response_body?.error?.diagnostic){
      // Only our structured diagnostic is rendered; never echo stored arbitrary error text.
      const diagnostic=row.response_body.error.diagnostic;
      const stages:Record<string,string>={file:'文件校验',scan:'安全扫描',conversation:'会话检查',binding:'渠道绑定',history:'记录准备',authorization:'权限复核',token:'微信凭据',upload:'素材上传',send:'微信发送',record:'结果记录'};
      if(stages[diagnostic.stage])sharedStatus+=` · ${stages[diagnostic.stage]}`;
      if(Number.isInteger(diagnostic.provider_code)&&Math.abs(diagnostic.provider_code)<=1000000)sharedStatus+=` · 微信错误码 ${diagnostic.provider_code}`;
      if(Number.isInteger(diagnostic.http_status)&&diagnostic.http_status>=100&&diagnostic.http_status<=599)sharedStatus+=` · HTTP ${diagnostic.http_status}`;
    }
  }
  if (contentAttributes?.replynest_transport === "shared_wechat" && raw.private !== true) {
    sharedStatus = "shared_pending";
    const commandId = String(contentAttributes.replynest_command_id ?? "");
    if (process.env.SHARED_WECHAT_DELIVERY_ENABLED === "true" && /^[a-f0-9-]{36}$/i.test(commandId)) {
      sharedStatus = await sharedWorkbenchMessageStatus(pool,tenantId,commandId);
    }
  }
  return {
    id: replynestId,
    direction: normalizeMessageDirection(raw.message_type),
    text: safeText(raw.content),
    content_type: safeText(raw.content_type, 80) ?? "text",
    private: raw.private === true,
    delivery_status: sharedStatus ?? safeText(raw.status, 40),
    created_at: isoTimestamp(raw.created_at),
    sender: {
      kind: normalizeMessageDirection(raw.message_type) === "incoming" ? "contact" : normalizeMessageDirection(raw.message_type) === "outgoing" ? "agent" : "system",
      display_name: safeText(sender.name, 200)
    },
    attachments: projectedAttachments
  };
}

async function projectConversation(tenantId: string, accountId: string, raw: ChatwootRecord, page?:ConversationPageContext) {
  assertAccount(raw, accountId);
  const id = upstreamId(raw);
  if (!id) return undefined;
  const replynestId = page?.ids.get(id)??await ensureResourceId(tenantId, "conversation", accountId, id);
  if(!page)await syncWebChatContact(tenantId, accountId, raw);
  const lastRaw = raw.last_non_activity_message && typeof raw.last_non_activity_message === "object"
    ? raw.last_non_activity_message as ChatwootRecord : undefined;
  const labels = Array.isArray(raw.labels) ? raw.labels.filter((item): item is string => typeof item === "string").slice(0, 50) : [];
  return {
    id: replynestId,
    status: normalizeConversationStatus(raw.status),
    priority: ["low", "medium", "high", "urgent"].includes(String(raw.priority)) ? String(raw.priority) : null,
    can_reply: raw.can_reply === true,
    unread_count: Number.isInteger(Number(raw.unread_count)) ? Math.max(0, Number(raw.unread_count)) : 0,
    labels,
    contact: page?(page.contacts.get(id)??null):await projectContact(tenantId, id),
    assignment: page?(page.assignments.get(pageAssigneeId(raw)??'')??null):await projectAssignment(tenantId, raw),
    last_message: lastRaw ? await projectMessage(tenantId, accountId, replynestId, lastRaw) : null,
    created_at: isoTimestamp(raw.created_at),
    updated_at: isoTimestamp(raw.updated_at),
    last_activity_at: isoTimestamp(raw.last_activity_at ?? raw.timestamp),
    waiting_since: isoTimestamp(raw.waiting_since)
  };
}

async function auditRead(auth: HeadlessAuth, action: string, resourceType: string, resourceId: string, requestId: string, resultCount?: number) {
  await pool.query(
    `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
     VALUES($1,$2,$3,$4,$5,$6,jsonb_build_object('result_count',$7::int),$8)`,
    [auth.tenant_id, auth.auth_kind === "console_session" ? "platform_user" : "tenant_api_key", auth.actor_id,
      action, resourceType, resourceId, resultCount ?? null, requestId]
  );
}

async function parseObject(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse((await readBody(request)).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

async function handleAutomationSettings(request: IncomingMessage, response: ServerResponse, auth: HeadlessAuth, requestId: string, sender?:AutomaticSenderPort): Promise<boolean> {
  if(request.url?.split('?')[0]==='/api/v1/conversation-automation/jobs'){
    if(auth.auth_kind!=='console_session'||!auth.platform_user_id||!['tenant_admin','supervisor'].includes(auth.role)){
      reply(response,403,requestId,{error:{code:'automation_history_forbidden'}});return true;
    }
    if(request.method!=='GET'){reply(response,405,requestId,{error:{code:'method_not_allowed'}});return true;}
    const params=new URL(request.url,'http://local').searchParams;
    const limit=Number(params.get('limit')??25),before=params.get('before');
    if(!Number.isInteger(limit)||limit<1||limit>100||(before&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(before))){
      reply(response,400,requestId,{error:{code:'invalid_page'}});return true;
    }
    // Cursor lookup remains tenant-scoped; no message content or private draft is exposed.
    const result=await pool.query(`SELECT job_id,channel,state,reason,created_at,updated_at FROM reception_jobs
      WHERE tenant_id=$1 AND ($2::uuid IS NULL OR (created_at,job_id)<(
        SELECT created_at,job_id FROM reception_jobs WHERE tenant_id=$1 AND job_id=$2))
      ORDER BY created_at DESC,job_id DESC LIMIT $3`,[auth.tenant_id,before,limit+1]);
    const data=result.rows.slice(0,limit);
    reply(response,200,requestId,{data,next_cursor:result.rows.length>limit?data[data.length-1].job_id:null});return true;
  }
  if (request.url?.split("?")[0] !== "/api/v1/conversation-automation") return false;
  // The page context is a precondition, never an authorization source. An old
  // tab must not read or mutate the newly selected enterprise in the session.
  const expectedWorkspace=request.headers['x-replynest-workspace'];
  if ((expectedWorkspace !== undefined || request.method === 'PATCH') &&
      (typeof expectedWorkspace !== 'string' || expectedWorkspace !== auth.tenant_id)) {
    reply(response,409,requestId,{error:{code:'workspace_changed',message:'当前企业已切换，请重新打开本页面'}});return true;
  }
  const draftAvailable=process.env.AI_RECEPTION_DRAFT_WORKER_ENABLED==='true';
  const availableChannels=automaticRuntimeChannels(),automaticAvailable=availableChannels.length>0;
  const view=(s:{automatic_sending_enabled:boolean;ai_auto_reply_enabled:boolean;automation_consent_version?:string|null},authorized:AutomaticChannel[]=[],senderState:AutomaticSenderState='unavailable')=>({
    ...s,reception_mode:s.automatic_sending_enabled?'automatic':s.ai_auto_reply_enabled?'draft':'manual',
    runtime_executor_available:draftAvailable,automatic_reception_available:automaticAvailable,
    effective_ai_auto_reply:draftAvailable&&s.automation_consent_version==='automatic-reply-v1'&&s.ai_auto_reply_enabled&&!s.automatic_sending_enabled,
    automatic_sender_state:senderState,
    effective_automatic_sending:senderState==='ready'&&authorized.length>0&&s.ai_auto_reply_enabled&&s.automatic_sending_enabled&&s.automation_consent_version==='automatic-reply-v1',
    automatic_supported_channels:availableChannels,automatic_authorized_channels:authorized,supported_channels:['wechat_official_account','shared_wechat','web_chat']});
  if (request.method === "GET") {
    const result = await pool.query<{ automatic_sending_enabled: boolean; ai_auto_reply_enabled: boolean; ai_auto_send_confidence_threshold_percent: number; automation_updated_at: string | null }>(
      `SELECT automatic_sending_enabled,ai_auto_reply_enabled,ai_auto_send_confidence_threshold_percent,automation_updated_at,automation_consent_version
         FROM tenant_ai_settings WHERE tenant_id=$1`, [auth.tenant_id]
    );
    const configured = result.rows[0] ?? { automatic_sending_enabled: false, ai_auto_reply_enabled: false, ai_auto_send_confidence_threshold_percent: 90, automation_updated_at: null };
    const authorized=await readAutomaticAuthorizedChannels(pool,auth.tenant_id,availableChannels);
    const accountId=await tenantAccountId(auth.tenant_id);
    const senderState=automaticAvailable?await inspectAutomaticSender(sender,accountId??null):'platform_disabled';
    reply(response, 200, requestId, { data: view(configured,authorized,senderState) });
    return true;
  }
  if (request.method !== "PATCH") return false;
  if (auth.auth_kind !== "console_session" || auth.role !== "tenant_admin" || !auth.platform_user_id) {
    reply(response, 403, requestId, { error: { code: "tenant_admin_console_session_required", message: "仅已登录的企业管理员可修改自动化开关" } });
    return true;
  }
  const validation = validateConversationAutomationSettings(await parseObject(request));
  if (!validation.ok) {
    reply(response, 400, requestId, { error: { code: validation.code, message: validation.message } });
    return true;
  }
  const input = validation.value;
  if(input.automatic_sending_enabled&&!automaticAvailable){reply(response,409,requestId,{error:{code:'automatic_reception_unavailable',message:'自动接待发送链路尚未开放，请先选择人工辅助或自动草稿'}});return true;}
  // Readiness check, never preparation: only the separate explicit send grant
  // may initialize infrastructure. No business connection/lock spans this HTTP.
  const inspectedAccount=input.automatic_sending_enabled?await tenantAccountId(auth.tenant_id):undefined;
  const senderState=input.automatic_sending_enabled?await inspectAutomaticSender(sender,inspectedAccount??null):'unavailable';
  if(input.automatic_sending_enabled&&senderState!=='ready'){
    reply(response,503,requestId,{error:{code:automaticSenderError(senderState),message:'自动发送身份尚未就绪，请在自动接待管理中查看原因；本次未启用。'}});return true;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='500ms'");
    const bearer=request.headers.authorization;
    // A tenant with no synced channel must still be able to stop automation.
    // Only this manual/draft endpoint omits the native-account condition; public
    // send-grant management continues to require a synced native binding.
    const verified=await authenticateAutomaticAdministrator(client,typeof bearer==='string'&&bearer.startsWith('Bearer ')?bearer.slice(7).trim():'',{requireNativeAccount:input.automatic_sending_enabled});
    if(verified && verified.tenant_id!==expectedWorkspace){
      await client.query('ROLLBACK');
      reply(response,409,requestId,{error:{code:'workspace_changed',message:'当前企业已切换，请重新打开本页面'}});return true;
    }
    if(!verified||verified.tenant_id!==auth.tenant_id||verified.platform_user_id!==auth.platform_user_id){
      await client.query('ROLLBACK');
      reply(response,403,requestId,{error:{code:'administrator_session_required',message:'管理员会话或企业权限已改变，请重新登录后操作'}});return true;
    }
    if(input.automatic_sending_enabled&&verified.account_id!==inspectedAccount){
      await client.query('ROLLBACK');reply(response,409,requestId,{error:{code:'workspace_changed',message:'企业渠道绑定已变化，请刷新后操作'}});return true;
    }
    // Revoke the independent send capability BEFORE touching settings, using the
    // same lock order as grant management. Both changes and audit commit together.
    let revoked=null,authorized:AutomaticChannel[]=[];
    if(input.automatic_sending_enabled){
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`automatic-management:${auth.tenant_id}`]);
      const current=(await client.query(`SELECT 1 FROM automatic_reception_grants WHERE tenant_id=$1 AND account_id=$2 AND enabled AND consent_version=$3 FOR UPDATE`,[auth.tenant_id,verified.account_id,AUTOMATIC_SEND_CONSENT_VERSION])).rowCount;
      if(!current){await client.query('ROLLBACK');reply(response,409,requestId,{error:{code:'send_confirmation_required',message:'请先在自动接待管理中阅读并批准独立发送授权'}});return true;}
      authorized=await readAutomaticAuthorizedChannels(client,auth.tenant_id,availableChannels);
      if(!authorized.length){await client.query('ROLLBACK');reply(response,409,requestId,{error:{code:'channel_send_confirmation_required',message:'当前可用渠道尚未获得发送授权，请先在自动接待管理中确认对应渠道'}});return true;}
    }else revoked=await revokeAutomaticGrantForMode(client,auth.tenant_id,auth.platform_user_id);
    const before = await client.query(`SELECT automatic_sending_enabled,ai_auto_reply_enabled,ai_auto_send_confidence_threshold_percent FROM tenant_ai_settings WHERE tenant_id=$1 FOR UPDATE`, [auth.tenant_id]);
    const updated = await client.query<{ automatic_sending_enabled: boolean; ai_auto_reply_enabled: boolean; ai_auto_send_confidence_threshold_percent: number; automation_updated_at: string }>(
      `INSERT INTO tenant_ai_settings
         (tenant_id,updated_by,automatic_sending_enabled,ai_auto_reply_enabled,ai_auto_send_confidence_threshold_percent,automation_updated_by,automation_updated_at,automation_consent_version)
       VALUES($1,$5::text,$2,$3,$4,$5::uuid,NOW(),$6)
       ON CONFLICT (tenant_id) DO UPDATE SET automatic_sending_enabled=EXCLUDED.automatic_sending_enabled,
              ai_auto_reply_enabled=EXCLUDED.ai_auto_reply_enabled,
              ai_auto_send_confidence_threshold_percent=EXCLUDED.ai_auto_send_confidence_threshold_percent,
              automation_updated_by=EXCLUDED.automation_updated_by,
              automation_consent_version=EXCLUDED.automation_consent_version,
              automation_updated_at=EXCLUDED.automation_updated_at,updated_at=NOW()
        RETURNING automatic_sending_enabled,ai_auto_reply_enabled,ai_auto_send_confidence_threshold_percent,automation_updated_at,automation_consent_version`,
      [auth.tenant_id, input.automatic_sending_enabled, input.ai_auto_reply_enabled, input.ai_auto_send_confidence_threshold_percent, auth.platform_user_id,(draftAvailable||automaticAvailable&&input.automatic_sending_enabled)&&input.ai_auto_reply_enabled?'automatic-reply-v1':null]
    );
    await client.query(
      `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,reason,before_data,after_data,request_id)
       VALUES($1,'platform_user',$2,'conversation.automation_settings_updated','tenant',$1,$3,$4,$5,$6)`,
      [auth.tenant_id, auth.platform_user_id, input.reason || "disabled_by_tenant_admin", before.rows[0] ?? {}, {...updated.rows[0],...(revoked?{revoked_send_grant:revoked}:{})}, requestId]
    );
    await client.query("COMMIT");
    reply(response, 200, requestId, { data: view(updated.rows[0],authorized,senderState) });
  } catch (error) {
    await client.query("ROLLBACK"); throw error;
  } finally { client.release(); }
  return true;
}

async function sendManualMessage(request: IncomingMessage, response: ServerResponse, auth: HeadlessAuth, requestId: string, conversationReplynestId: string, accountId: string) {
  if (auth.auth_kind !== "console_session" || !auth.platform_user_id) {
    reply(response, 403, requestId, { error: { code: "manual_console_session_required", message: "仅已登录坐席可人工发送消息" } }); return;
  }
  const membership = await pool.query(
    `SELECT 1 FROM tenant_memberships WHERE tenant_id=$1 AND platform_user_id=$2 AND status='active' AND chatwoot_account_id=$3`,
    [auth.tenant_id, auth.platform_user_id, accountId]
  );
  if (!membership.rows[0]) { reply(response, 403, requestId, { error: { code: "membership_disabled", message: "当前成员无权在该工作台发送消息" } }); return; }
  const idempotencyKey = String(request.headers["idempotency-key"] ?? "").trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    reply(response, 400, requestId, { error: { code: "idempotency_key_required", message: "需要 8-128 位 Idempotency-Key" } }); return;
  }
  const input = await parseObject(request);
  const content = typeof input?.content === "string" ? input.content.trim() : "";
  if (!input || Object.keys(input).some(key => !["content", "private"].includes(key)) || (input.private !== undefined && typeof input.private !== "boolean") || content.length < 1 || content.length > 10_000) {
    reply(response, 400, requestId, { error: { code: "invalid_message", message: "本接口仅接受 1-10000 字的 content" } }); return;
  }
  const mapping = await resolveResource(auth.tenant_id, "conversation", conversationReplynestId);
  if (!mapping || mapping.chatwoot_account_id !== accountId) { reply(response, 404, requestId, { error: { code: "conversation_not_found", message: "会话不存在" } }); return; }
  const isPrivate = input.private === true;
  const requestHash = createHash("sha256").update(`${isPrivate ? "private\n" : ""}${conversationReplynestId}\n${content}`).digest("hex");
  const inserted = await pool.query<{ command_id: string }>(
    `INSERT INTO conversation_message_commands(tenant_id,conversation_replynest_id,platform_user_id,idempotency_key,request_hash)
     VALUES($1,$2,$3,$4,$5) ON CONFLICT (tenant_id,idempotency_key) DO NOTHING RETURNING command_id`,
    [auth.tenant_id, conversationReplynestId, auth.platform_user_id, idempotencyKey, requestHash]
  );
  if (!inserted.rows[0]) {
    const existing = await pool.query<{ request_hash: string; state: string; response_status: number | null; response_body: Record<string, unknown> | null }>(
      `SELECT request_hash,state,response_status,response_body FROM conversation_message_commands WHERE tenant_id=$1 AND idempotency_key=$2`,
      [auth.tenant_id, idempotencyKey]
    );
    const row = existing.rows[0];
    if (!row || row.request_hash !== requestHash) { reply(response, 409, requestId, { error: { code: "idempotency_key_conflict", message: "该幂等键已用于其他请求" } }); return; }
    if (row.response_status && row.response_body) { sendJson(response, row.response_status, row.response_body); return; }
    reply(response, 409, requestId, { error: { code: row.state === "uncertain" ? "send_outcome_uncertain" : "request_in_progress", message: "发送结果尚未确认，请勿重复发送并联系管理员核查" } }); return;
  }
  const commandId = inserted.rows[0].command_id;
  try {
    const conversation = await getChatwootConversation(accountId, mapping.chatwoot_resource_id);
    assertAccount(conversation, accountId);
    if (!isPrivate && conversation.can_reply !== true) throw new ChatwootWriteError(409, false, "Conversation is not replyable");
    const sharedAuth = {tenantId:auth.tenant_id,actorId:auth.actor_id,userId:auth.platform_user_id!,accountId};
    const sharedTarget = isPrivate ? undefined : await prepareSharedWorkbenchReply(pool,sharedAuth,
      {id:conversation.id,account_id:conversation.account_id,inbox_id:conversation.inbox_id,custom_attributes:conversation.custom_attributes},content,
      {enabled:process.env.SHARED_WECHAT_DELIVERY_ENABLED==="true",manualSendEnabled:process.env.SHARED_WECHAT_MANUAL_SEND_ENABLED==="true"});
    const raw = await createChatwootOutgoingMessage(accountId, mapping.chatwoot_resource_id, content, commandId, isPrivate,!!sharedTarget);
    if (isPrivate && raw.private !== true) throw new ChatwootWriteError(502, true, "Private note response mismatch");
    // Message-create responses may omit account_id. The account-scoped request and
    // previously verified conversation establish the boundary; reject explicit mismatches.
    if (raw.account_id != null) assertAccount(raw, accountId);
    if (String(raw.conversation_id ?? "") !== mapping.chatwoot_resource_id) throw new ChatwootWriteError(502, true, "Chatwoot conversation boundary mismatch");
    const message = await projectMessage(auth.tenant_id, accountId, conversationReplynestId, raw);
    if (!message) throw new ChatwootWriteError(502, true, "Chatwoot response omitted message id");
    let deliveryState = isPrivate ? "internal" : "pending";
    if(sharedTarget) {
      const transport=createSharedWechatTransport({chatwootBaseUrl:requiredEnv("CHATWOOT_BASE_URL"),chatwootToken:requiredEnv("CHATWOOT_API_ACCESS_TOKEN"),
        liveSendEnabled:process.env.SHARED_WECHAT_MANUAL_SEND_ENABLED==="true",
        resolveWeChat:async appId=>{
          if(appId!==process.env.SHARED_WECHAT_APP_ID)throw new Error("shared_sender_account_mismatch");
          return sharedWechatConfig();
        }});
      const result=await dispatchSharedWorkbenchReply(pool,sharedAuth,sharedTarget,commandId,content,transport);
      deliveryState = result==="delivered" || result==="duplicate" ? "shared_provider_accepted" : result.startsWith("shared_") ? result : result==="blocked" ? "shared_blocked" : "shared_uncertain";
      message.delivery_status=deliveryState;
    }
    const body = { request_id: requestId, data: { command_id: commandId, state: "accepted", delivery_state: deliveryState, message } };
    await pool.query(`UPDATE conversation_message_commands SET state='accepted',upstream_message_id=$3,response_status=202,response_body=$4,updated_at=NOW() WHERE tenant_id=$1 AND command_id=$2`, [auth.tenant_id, commandId, String(raw.id), body]);
    await pool.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id) VALUES($1,'platform_user',$2,'conversation.message_manual_accepted','conversation',$3,jsonb_build_object('command_id',$4::text,'content_length',$5::int,'content_sha256',$6::text,'private',$8::boolean),$7)`, [auth.tenant_id, auth.platform_user_id, conversationReplynestId, commandId, content.length, createHash("sha256").update(content).digest("hex"), requestId, isPrivate]);
    sendJson(response, 202, body);
  } catch (error) {
    if(error instanceof SharedWorkbenchError) {
      const messages:Record<string,string>={shared_send_disabled:"共享公众号人工发送尚未启用，消息未发送。",shared_conversation_not_ready:"共享公众号会话尚未就绪或已停用，消息未发送。",shared_reply_too_long:"回复加商家名称不能超过 1800 UTF-8 字节，请缩短内容。"};
      const body={request_id:requestId,error:{code:error.code,message:messages[error.code]??"共享渠道暂不可发送"}};
      await pool.query(`UPDATE conversation_message_commands SET state='failed',response_status=409,response_body=$3,error_code=$4,updated_at=NOW() WHERE tenant_id=$1 AND command_id=$2`,[auth.tenant_id,commandId,body,error.code]);
      sendJson(response,409,body);return;
    }
    const writeError = error instanceof ChatwootWriteError ? error : new ChatwootWriteError(503, true, error instanceof Error ? error.message : String(error));
    const state = writeError.uncertain ? "uncertain" : "failed";
    const status = writeError.status >= 400 && writeError.status < 500 ? writeError.status : 503;
    const code = writeError.uncertain ? "send_outcome_uncertain" : writeError.status === 409 ? "conversation_not_replyable" : "message_rejected";
    const body = { request_id: requestId, error: { code, message: writeError.uncertain ? "发送结果尚未确认，请勿使用新幂等键重试" : "当前会话无法发送消息" } };
    await pool.query(`UPDATE conversation_message_commands SET state=$3,response_status=$4,response_body=$5,error_code=$6,updated_at=NOW() WHERE tenant_id=$1 AND command_id=$2`, [auth.tenant_id, commandId, state, status, body, code]);
    console.warn("Headless manual message write failed", writeError.message);
    sendJson(response, status, body);
  }
}

function rawAssigneeId(raw: ChatwootRecord): string | null {
  const meta = raw.meta && typeof raw.meta === "object" ? raw.meta as ChatwootRecord : {};
  const assignee = meta.assignee && typeof meta.assignee === "object" ? meta.assignee as ChatwootRecord : undefined;
  const value = assignee?.id;
  return (typeof value === "number" || typeof value === "string") && /^\d+$/.test(String(value)) ? String(value) : null;
}

async function performConversationAction(
  request: IncomingMessage,
  response: ServerResponse,
  auth: HeadlessAuth,
  requestId: string,
  conversationReplynestId: string,
  accountId: string
) {
  if (auth.auth_kind !== "console_session" || !auth.platform_user_id) {
    reply(response, 403, requestId, { error: { code: "conversation_action_console_session_required", message: "仅已登录坐席可操作会话" } }); return;
  }
  const idempotencyKey = String(request.headers["idempotency-key"] ?? "").trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    reply(response, 400, requestId, { error: { code: "idempotency_key_required", message: "需要 8-128 位 Idempotency-Key" } }); return;
  }
  const input = await parseObject(request);
  const action = input?.action;
  const allowedKeys = action === "claim" ? ["action", "expected_assignee_id"]
    : action === "assign" ? ["action", "assignee_id", "expected_assignee_id"]
      : ["action", "status", "expected_status"];
  const validClaim = action === "claim" && (input?.expected_assignee_id === null || typeof input?.expected_assignee_id === "string");
  const validAssign = action === "assign" && typeof input?.assignee_id === "string" && /^[0-9a-f-]{36}$/i.test(input.assignee_id) &&
    (input?.expected_assignee_id === null || typeof input?.expected_assignee_id === "string");
  const validStatus = action === "set_status" && ["open", "pending", "resolved"].includes(String(input?.status)) &&
    ["open", "pending", "resolved", "snoozed"].includes(String(input?.expected_status));
  if (!input || (!validClaim && !validAssign && !validStatus) || Object.keys(input).some(key => !allowedKeys.includes(key))) {
    reply(response, 400, requestId, { error: { code: "invalid_conversation_action", message: "会话操作参数不合法" } }); return;
  }
  const mapping = await resolveResource(auth.tenant_id, "conversation", conversationReplynestId);
  if (!mapping || mapping.chatwoot_account_id !== accountId) {
    reply(response, 404, requestId, { error: { code: "conversation_not_found", message: "会话不存在" } }); return;
  }
  const membership = await pool.query<{ chatwoot_user_id: string | null }>(
    `SELECT chatwoot_user_id::text FROM tenant_memberships
      WHERE tenant_id=$1 AND platform_user_id=$2 AND status='active' AND chatwoot_account_id=$3 LIMIT 1`,
    [auth.tenant_id, auth.platform_user_id, accountId]
  );
  const chatwootUserId = membership.rows[0]?.chatwoot_user_id;
  if (!membership.rows[0] || (action === "claim" && !chatwootUserId)) {
    reply(response, 403, requestId, { error: { code: "membership_disabled", message: "当前成员未关联有效客服坐席" } }); return;
  }
  const currentRaw = await getChatwootConversation(accountId, mapping.chatwoot_resource_id);
  assertAccount(currentRaw, accountId);
  const current = await projectConversation(auth.tenant_id, accountId, currentRaw);
  if (!current) throw new Error("Chatwoot returned a conversation without an id");
  const currentAssigneeId = current.assignment?.member_id ?? null;
  if (!canPerformConversationAction(auth.role, auth.platform_user_id, currentAssigneeId, action)) {
    reply(response, 403, requestId, { error: { code: "conversation_action_forbidden", message: "当前角色无权执行该会话操作" } }); return;
  }
  if (action === "claim" || action === "assign") {
    const expectedAssignee = input.expected_assignee_id as string | null;
    const currentRawAssignee = rawAssigneeId(currentRaw);
    const unmappedAssignee = currentRawAssignee !== null && currentAssigneeId === null;
    const claimOccupied = action === "claim" && currentRawAssignee !== null && currentRawAssignee !== chatwootUserId;
    if (expectedAssignee !== currentAssigneeId || unmappedAssignee || claimOccupied) {
      reply(response, 409, requestId, { error: { code: "conversation_changed", message: "会话负责人已经变化，请刷新后重试" } }); return;
    }
  } else if (input.expected_status !== current.status) {
    reply(response, 409, requestId, { error: { code: "conversation_changed", message: "会话状态已经变化，请刷新后重试" } }); return;
  }
  let targetChatwootUserId: string | undefined;
  if (action === "assign") {
    const target = await pool.query<{ chatwoot_user_id: string }>(
      `SELECT chatwoot_user_id::text FROM tenant_memberships
        WHERE tenant_id=$1 AND platform_user_id=$2 AND chatwoot_account_id=$3
          AND status='active' AND chatwoot_sync_status='synced' AND chatwoot_user_id IS NOT NULL LIMIT 1`,
      [auth.tenant_id, input.assignee_id, accountId]
    );
    targetChatwootUserId = target.rows[0]?.chatwoot_user_id;
    if (!targetChatwootUserId) {
      reply(response, 404, requestId, { error: { code: "assignee_not_found", message: "目标坐席不存在或尚未同步" } }); return;
    }
  }
  const canonical = action === "claim"
    ? { action, expected_assignee_id: input.expected_assignee_id }
    : action === "assign" ? { action, assignee_id: input.assignee_id, expected_assignee_id: input.expected_assignee_id }
    : { action, status: input.status, expected_status: input.expected_status };
  const requestHash = createHash("sha256").update(`${conversationReplynestId}\n${JSON.stringify(canonical)}`).digest("hex");
  const inserted = await pool.query<{ command_id: string }>(
    `INSERT INTO conversation_action_commands(tenant_id,conversation_replynest_id,platform_user_id,idempotency_key,request_hash,action)
     VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,idempotency_key) DO NOTHING RETURNING command_id`,
    [auth.tenant_id, conversationReplynestId, auth.platform_user_id, idempotencyKey, requestHash, action]
  );
  if (!inserted.rows[0]) {
    const existing = await pool.query<{ request_hash: string; state: string; response_status: number | null; response_body: Record<string, unknown> | null }>(
      `SELECT request_hash,state,response_status,response_body FROM conversation_action_commands WHERE tenant_id=$1 AND idempotency_key=$2`,
      [auth.tenant_id, idempotencyKey]
    );
    const row = existing.rows[0];
    if (!row || row.request_hash !== requestHash) { reply(response, 409, requestId, { error: { code: "idempotency_key_conflict", message: "该幂等键已用于其他请求" } }); return; }
    if (row.response_status && row.response_body) { sendJson(response, row.response_status, row.response_body); return; }
    reply(response, 409, requestId, { error: { code: row.state === "uncertain" ? "action_outcome_uncertain" : "request_in_progress", message: "操作结果尚未确认，请刷新会话状态" } }); return;
  }
  const commandId = inserted.rows[0].command_id;
  try {
    if (action === "claim") {
      await assignChatwootConversation(accountId, mapping.chatwoot_resource_id, chatwootUserId!);
    } else if (action === "assign") {
      await assignChatwootConversation(accountId, mapping.chatwoot_resource_id, targetChatwootUserId!);
    } else {
      await updateChatwootConversationStatus(accountId, mapping.chatwoot_resource_id, input.status as "open" | "pending" | "resolved");
    }
    const refreshedRaw = await getChatwootConversation(accountId, mapping.chatwoot_resource_id);
    const refreshed = await projectConversation(auth.tenant_id, accountId, refreshedRaw);
    if (!refreshed) throw new ChatwootWriteError(502, true, "Chatwoot response omitted conversation id");
    const body = { request_id: requestId, data: { command_id: commandId, state: "accepted", conversation: refreshed } };
    await pool.query(
      `UPDATE conversation_action_commands SET state='accepted',response_status=200,response_body=$3,updated_at=NOW() WHERE tenant_id=$1 AND command_id=$2`,
      [auth.tenant_id, commandId, body]
    );
    await pool.query(
      `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,before_data,after_data,request_id)
       VALUES($1,'platform_user',$2,$3,'conversation',$4,$5,$6,$7)`,
      [auth.tenant_id, auth.platform_user_id, action === "claim" ? "conversation.claimed" : action === "assign" ? "conversation.assigned" : "conversation.status_changed",
        conversationReplynestId, { status: current.status, assignee_id: currentAssigneeId },
        { status: refreshed.status, assignee_id: refreshed.assignment?.member_id ?? null, command_id: commandId }, requestId]
    );
    sendJson(response, 200, body);
  } catch (error) {
    const writeError = error instanceof ChatwootWriteError ? error : new ChatwootWriteError(503, true, error instanceof Error ? error.message : String(error));
    const state = writeError.uncertain ? "uncertain" : "failed";
    const status = writeError.status >= 400 && writeError.status < 500 ? writeError.status : 503;
    const code = writeError.uncertain ? "action_outcome_uncertain" : "conversation_action_rejected";
    const body = { request_id: requestId, error: { code, message: writeError.uncertain ? "操作结果尚未确认，请刷新会话状态" : "会话操作被上游拒绝" } };
    await pool.query(
      `UPDATE conversation_action_commands SET state=$3,response_status=$4,response_body=$5,error_code=$6,updated_at=NOW() WHERE tenant_id=$1 AND command_id=$2`,
      [auth.tenant_id, commandId, state, status, body, code]
    );
    console.warn("Headless conversation action failed", writeError.message);
    sendJson(response, status, body);
  }
}

async function customerAutomation(request: IncomingMessage, response: ServerResponse, auth: HeadlessAuth, requestId: string, conversationId: string, accountId: string) {
  const fail=(status:number,code:string)=>reply(response,status,requestId,{error:{code}});
  if(auth.auth_kind!=='console_session'||!auth.platform_user_id||auth.impersonation_id)return fail(403,'console_session_required');
  if(request.headers['x-replynest-workspace']!==auth.tenant_id)return fail(409,'workspace_changed');
  const member=await pool.query(`SELECT role FROM tenant_memberships WHERE tenant_id=$1 AND platform_user_id=$2 AND status='active' AND chatwoot_account_id=$3`,[auth.tenant_id,auth.platform_user_id,accountId]);
  if(!member.rows[0])return fail(403,'membership_disabled');
  const mapping=await resolveResource(auth.tenant_id,'conversation',conversationId);
  if(!mapping||mapping.chatwoot_account_id!==accountId)return fail(404,'conversation_not_found');
  const raw=await getChatwootConversation(accountId,mapping.chatwoot_resource_id);assertAccount(raw,accountId);
  // A pause spans every conversation of one logical customer. Ambiguous local
  // identities must never be resolved by LIMIT 1, unlike a display projection.
  const contacts=(await pool.query(`SELECT DISTINCT c.customer_id::text AS id,i.chatwoot_contact_id::text AS native_contact_id FROM channel_identities i
   JOIN customers c ON c.tenant_id=i.tenant_id AND c.customer_id=i.customer_id
   WHERE i.tenant_id=$1 AND i.chatwoot_conversation_id=$2 LIMIT 2`,[auth.tenant_id,mapping.chatwoot_resource_id])).rows;
  if(!contacts.length)return fail(404,'customer_not_found');
  if(contacts.length!==1)return fail(409,'customer_identity_conflict');
  const contact=contacts[0];
  const assignee=await projectAssignment(auth.tenant_id,raw);
  const input=request.method==='PATCH'?validateCustomerAutomationControl(await parseObject(request)):undefined;
  // Network reads and request bodies may outlive a logout, workspace switch or
  // seat revocation. Revalidate the REAL token and current role just before the
  // signed native request; never trust the earlier routing auth snapshot alone.
  const fresh=await authenticateConsoleSession(request);
  if(!fresh||fresh.session_scope!=='console'||fresh.impersonation_id||fresh.impersonated_by_admin_id||fresh.platform_user_id!==auth.platform_user_id)
   return fail(403,'console_session_required');
  if(fresh.tenant_id!==auth.tenant_id||await tenantAccountId(auth.tenant_id)!==accountId)return fail(409,'workspace_changed');
  const currentMember=(await pool.query(`SELECT role,chatwoot_user_id::text AS native_actor_id FROM tenant_memberships WHERE tenant_id=$1 AND platform_user_id=$2
   AND status='active' AND chatwoot_sync_status='synced' AND chatwoot_account_id=$3 AND chatwoot_user_id IS NOT NULL`,[auth.tenant_id,auth.platform_user_id,accountId])).rows[0];
  if(!currentMember)return fail(403,'membership_disabled');
  const canControl=canEditCustomerProfile(currentMember.role,auth.platform_user_id,assignee?.member_id??null);
  if(request.method==='PATCH'&&!canControl)return fail(403,'customer_automation_forbidden');
  if(request.method==='PATCH'&&!input)return fail(400,'invalid_customer_automation');
  try{
    const native=createAutomaticNativeClient({origin:requiredEnv('CHATWOOT_BASE_URL'),secret:secretValue('REPLYNEST_AUTOMATIC_REPLY_SECRET')??''});
    const state=await native.customerControl(accountId,contact.id,input?{...input,actor_id:auth.platform_user_id,request_id:requestId,
      conversation_id:mapping.chatwoot_resource_id,contact_id:contact.native_contact_id,native_actor_id:currentMember.native_actor_id,
      permission_scope:['tenant_admin','supervisor'].includes(currentMember.role)?'manager':'assigned'}:undefined);
    // Native state and its audit commit together. A lost response is not a confirmed success.
    return reply(response,200,requestId,{data:{revision:state.revision,paused_until:state.paused_until,paused:state.paused,can_control:canControl}});
  }catch(e){const code=e instanceof Error?e.message:'';return fail(code==='customer_automation_conflict'?409:code==='customer_automation_forbidden'?403:503,
    ['customer_automation_conflict','customer_automation_forbidden'].includes(code)?code:'customer_automation_unavailable');}
}

// Separate from sending/assignment/pause permissions. Fresh real-session seat
// checks are repeated after request parsing and immediately before signed I/O.
async function workbenchReadSeat(request:IncomingMessage,auth:HeadlessAuth,accountId:string){
 if(auth.auth_kind!=='console_session'||!auth.platform_user_id||auth.impersonation_id)throw Error('console_session_required');
 const fresh=await authenticateConsoleSession(request);
 if(!fresh||fresh.session_scope!=='console'||fresh.impersonation_id||fresh.impersonated_by_admin_id||fresh.platform_user_id!==auth.platform_user_id)throw Error('console_session_required');
 if(fresh.tenant_id!==auth.tenant_id||await tenantAccountId(auth.tenant_id)!==accountId)throw Error('workspace_changed');
 const seat=(await pool.query(`SELECT chatwoot_user_id::text AS native_actor_id FROM tenant_memberships WHERE tenant_id=$1 AND platform_user_id=$2
  AND status='active' AND chatwoot_sync_status='synced' AND chatwoot_account_id=$3 AND chatwoot_user_id IS NOT NULL`,[auth.tenant_id,auth.platform_user_id,accountId])).rows[0];
 if(!seat)throw Error('membership_disabled');return seat.native_actor_id as string;
}
async function readWorkbenchCounts(request:IncomingMessage,auth:HeadlessAuth,accountId:string,conversationIds:string[],messageIds?:string[],timing?:(stage:string,ms:number)=>void):Promise<WorkbenchReadCount[]>{
 const seatStarted=performance.now();let actor:string;
 try{actor=await workbenchReadSeat(request,auth,accountId);}finally{timing?.('seat',Math.round(performance.now()-seatStarted));}
 const native=createWorkbenchReadNativeClient({origin:requiredEnv('CHATWOOT_BASE_URL'),secret:secretValue('REPLYNEST_AUTOMATIC_REPLY_SECRET')??''});
 const nativeStarted=performance.now();
 try{return await native.control({account_id:accountId,native_actor_id:actor,conversation_ids:conversationIds,operation:messageIds?'mark':'stats',...(messageIds?{message_ids:messageIds}:{})});}
 finally{timing?.('native',Math.round(performance.now()-nativeStarted));}
}
async function markWorkbenchRead(request:IncomingMessage,response:ServerResponse,auth:HeadlessAuth,requestId:string,conversationId:string,accountId:string){
 const started=performance.now(),candidate=request.headers['x-replynest-read-attempt'];
 const attempt=typeof candidate==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(candidate)?candidate.toLowerCase():null;
 const timings:Record<string,number>={};let stage='guards';
 const diagnostic=(status:number)=>{
  timings.gateway=Math.round(performance.now()-started);
  if(!response.headersSent)response.setHeader('server-timing',Object.entries(timings).map(([key,ms])=>`${key};dur=${ms}`).join(', '));
  console.info(JSON.stringify({event:'workbench_read_gateway',attempt_id:attempt,request_id:requestId,status,stage,timings_ms:timings}));
 };
 const finish=(status:number,body:Record<string,unknown>)=>{diagnostic(status);return reply(response,status,requestId,body);};
 try{
 if(process.env.WORKBENCH_READ_ENABLED!=='true')return finish(409,{error:{code:'workbench_read_disabled'}});
 if(request.headers['x-replynest-workspace']!==auth.tenant_id)return finish(409,{error:{code:'workspace_changed'}});
 stage='body';const bodyStarted=performance.now();
 const input=await parseObject(request);
 timings.body=Math.round(performance.now()-bodyStarted);
 const ids=input?.message_ids;
 if(!input||Object.keys(input).join(',')!=='message_ids'||!Array.isArray(ids)||!ids.length||ids.length>100||ids.some(v=>typeof v!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(v))||new Set(ids).size!==ids.length)return finish(400,{error:{code:'invalid_read_receipt'}});
 stage='mapping';const mappingStarted=performance.now();
 const [conversation,messages]=await Promise.all([resolveResource(auth.tenant_id,'conversation',conversationId),pool.query<{chatwoot_resource_id:string}>(
  `SELECT chatwoot_resource_id FROM conversation_resource_mappings WHERE tenant_id=$1 AND resource_type='message'
   AND chatwoot_account_id=$2 AND parent_replynest_resource_id=$3 AND replynest_resource_id=ANY($4::uuid[])`,[auth.tenant_id,accountId,conversationId,ids])]);
 timings.mapping=Math.round(performance.now()-mappingStarted);
 if(!conversation||conversation.chatwoot_account_id!==accountId||messages.rows.length!==ids.length)return finish(404,{error:{code:'message_not_found'}});
 stage='seat_or_native';const counts=await readWorkbenchCounts(request,auth,accountId,[conversation.chatwoot_resource_id],messages.rows.map(m=>m.chatwoot_resource_id),(key,ms)=>{timings[key]=ms;stage=key==='seat'?'native':'native_completed';});
 stage='completed';return finish(200,{data:{conversation_id:conversationId,unread_count:counts[0].unread_count,capped:counts[0].capped}});
 }catch(error){if(stage==='seat_or_native'||stage==='native'||stage==='native_completed')stage=timings.native!==undefined?'native':'seat';diagnostic(502);throw error;}
}

async function customerProfile(request: IncomingMessage, response: ServerResponse, auth: HeadlessAuth, requestId: string, conversationId: string, accountId: string) {
  const fail = (status: number, code: string) => reply(response, status, requestId, { error: { code } });
  if (auth.auth_kind !== "console_session" || !auth.platform_user_id) return fail(403, "console_session_required");
  const member = await pool.query(`SELECT role FROM tenant_memberships WHERE tenant_id=$1 AND platform_user_id=$2 AND status='active' AND chatwoot_account_id=$3`, [auth.tenant_id, auth.platform_user_id, accountId]);
  if (!member.rows[0]) return fail(403, "membership_disabled");
  const mapping = await resolveResource(auth.tenant_id, "conversation", conversationId);
  if (!mapping || mapping.chatwoot_account_id !== accountId) return fail(404, "conversation_not_found");
  const raw = await getChatwootConversation(accountId, mapping.chatwoot_resource_id);
  assertAccount(raw, accountId);
  const contact = await projectContact(auth.tenant_id, mapping.chatwoot_resource_id);
  if (!contact) return fail(404, "customer_not_found");
  const assignee = await projectAssignment(auth.tenant_id, raw);
  const canEdit = canEditCustomerProfile(member.rows[0].role, auth.platform_user_id, assignee?.member_id ?? null);
  const fields = `name,COALESCE(email,'') AS email,COALESCE(phone,'') AS phone,support_note AS note,xmin::text AS revision`;
  if (request.method === "GET") {
    const result = await pool.query(`SELECT ${fields} FROM customers WHERE tenant_id=$1 AND customer_id=$2`, [auth.tenant_id, contact.id]);
    if (!result.rows[0]) return fail(404, "customer_not_found");
    await auditRead(auth, "customer.profile_read", "customer", contact.id, requestId);
    const wechat=process.env.SHARED_WECHAT_MANAGEMENT_ENABLED==='true'?(await pool.query(`SELECT p.nickname,p.avatar_url FROM shared_wechat_threads b JOIN shared_wechat_authorized_profiles p ON p.app_id=b.app_id AND p.open_id=b.open_id AND p.expires_at>NOW() WHERE b.tenant_id=$1 AND b.account_id=$2 AND b.conversation_id=$3`,[auth.tenant_id,accountId,mapping.chatwoot_resource_id])).rows[0]:undefined;
    return reply(response, 200, requestId, { data: { ...result.rows[0], display_name:contact.display_name, wechat, can_edit: canEdit } });
  }
  if (!canEdit) return fail(403, "customer_edit_forbidden");
  const input = validateCustomerProfile(await parseObject(request));
  if (!input) return fail(400, "invalid_customer_profile");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(`UPDATE customers SET name=$3,email=NULLIF($4,''),phone=NULLIF($5,''),support_note=$6,updated_at=NOW() WHERE tenant_id=$1 AND customer_id=$2 AND xmin::text=$7 RETURNING ${fields}`, [auth.tenant_id, contact.id, input.name, input.email, input.phone, input.note, input.revision]);
    if (!result.rows[0]) { await client.query("ROLLBACK"); return fail(409, "customer_profile_conflict"); }
    await client.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id) VALUES($1,'platform_user',$2,'customer.profile_updated','customer',$3,$4,$5)`, [auth.tenant_id, auth.platform_user_id, contact.id, { fields: ["name", "email", "phone", "support_note"], conversation_id: conversationId }, requestId]);
    await client.query("COMMIT");
    const display=(await projectContact(auth.tenant_id,mapping.chatwoot_resource_id))?.display_name??result.rows[0].name;
    return reply(response, 200, requestId, { data: { ...result.rows[0], display_name:display, can_edit: true } });
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function handleConversationHeadlessApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  auth: HeadlessAuth,
  requestId: string,
  options:{sender?:AutomaticSenderPort}={}
): Promise<boolean> {
  if (await handleAutomationSettings(request, response, auth, requestId,options.sender)) return true;
  const isAssignmentDirectory = url.pathname === "/api/v1/conversation-assignees";
  const readMatch=url.pathname.match(/^\/api\/v1\/conversations\/([0-9a-f-]{36})\/read$/i);
  const profileMatch = url.pathname.match(/^\/api\/v1\/conversations\/([0-9a-f-]{36})\/customer-profile$/i);
  const automationMatch = url.pathname.match(/^\/api\/v1\/conversations\/([0-9a-f-]{36})\/customer-automation$/i);
  const detailMatch = url.pathname.match(/^\/api\/v1\/conversations\/([0-9a-f-]{36})$/i);
  const messagesMatch = url.pathname.match(/^\/api\/v1\/conversations\/([0-9a-f-]{36})\/messages$/i);
  const actionsMatch = url.pathname.match(/^\/api\/v1\/conversations\/([0-9a-f-]{36})\/actions$/i);
  const attachmentMatch = url.pathname.match(/^\/api\/v1\/attachments\/([0-9a-f-]{36})\/content$/i);
  const isList = url.pathname === "/api/v1/conversations";
  if (!isList && !isAssignmentDirectory && !detailMatch && !messagesMatch && !actionsMatch && !attachmentMatch && !profileMatch && !automationMatch && !readMatch) return false;
  if (request.method !== "GET" && !(request.method === "PATCH" && (profileMatch || automationMatch)) && !(request.method === "POST" && (messagesMatch || actionsMatch || readMatch))) return false;

  const accountId = await tenantAccountId(auth.tenant_id);
  if (!accountId) {
    reply(response, 409, requestId, { error: { code: "chatwoot_account_not_configured", message: "当前企业尚未配置客服工作台" } });
    return true;
  }
  const secret = requiredEnv("SAAS_SSO_SHARED_SECRET");
  try {
    if(readMatch){if(request.method!=='POST')return reply(response,405,requestId,{error:{code:'method_not_allowed'}}),true;await markWorkbenchRead(request,response,auth,requestId,readMatch[1],accountId);return true;}
    if(automationMatch){await customerAutomation(request,response,auth,requestId,automationMatch[1],accountId);return true;}
    if (profileMatch) {
      await customerProfile(request, response, auth, requestId, profileMatch[1], accountId);
      return true;
    }
    if (isAssignmentDirectory) {
      if (request.method !== "GET" || auth.auth_kind !== "console_session" || !auth.platform_user_id || !["tenant_admin", "supervisor"].includes(auth.role)) {
        reply(response, 403, requestId, { error: { code: "assignment_directory_forbidden", message: "仅企业管理员或主管可查看可转派坐席" } });
        return true;
      }
      reply(response, 200, requestId, { data: await assignmentCandidates(auth.tenant_id, accountId) });
      return true;
    }
    if (request.method === "POST" && messagesMatch) {
      await sendManualMessage(request, response, auth, requestId, messagesMatch[1], accountId);
      return true;
    }
    if (request.method === "POST" && actionsMatch) {
      await performConversationAction(request, response, auth, requestId, actionsMatch[1], accountId);
      return true;
    }
    if (attachmentMatch) {
      await serveAttachment(request, response, url, auth, requestId, attachmentMatch[1], accountId);
      return true;
    }
    if (isList) {
      const status = url.searchParams.get("status") ?? "all";
      if (!["all", "open", "pending", "resolved", "snoozed"].includes(status)) {
        reply(response, 400, requestId, { error: { code: "invalid_status", message: "会话状态不合法" } });
        return true;
      }
      let search: ReturnType<typeof parseWorkbenchSearch>;
      try { search = parseWorkbenchSearch(url.searchParams); }
      catch (error) { reply(response,400,requestId,{error:{code:'invalid_search',message:(error as Error).message}}); return true; }
      const cursor = url.searchParams.get("cursor");
      const position = cursor ? decodeConversationCursor(cursor, secret, auth.tenant_id, search.scope) : "1";
      if (!position || !/^\d+$/.test(position)) {
        reply(response, 400, requestId, { error: { code: "invalid_cursor", message: "分页游标无效或已被篡改" } });
        return true;
      }
      let page = Number(position);
      if (page < 1 || page > 100_000) { reply(response,400,requestId,{error:{code:'invalid_cursor',message:'分页游标无效'}}); return true; }
      const data = [];
      let more = false;
      // Bounded server-side scan, with an explicit continuation (never claim a partial scan is complete).
      for (let scan = 0; scan < (search.active ? 5 : 1); scan++) {
        const raw = await listChatwootConversations(accountId, page, status, search.content);
        const context=await loadConversationPageContext(pool,auth.tenant_id,accountId,raw,async item=>{
          await syncWebChatContact(auth.tenant_id,accountId,item);
          if(process.env.SHARED_WECHAT_DELIVERY_ENABLED==='true')await ensureSharedWechatCustomer(pool,auth.tenant_id,String(item.id));
        },process.env.SHARED_WECHAT_DELIVERY_ENABLED==='true',process.env.SHARED_WECHAT_MANAGEMENT_ENABLED==='true');
        const projected = await Promise.all(raw.map(item=>projectConversation(auth.tenant_id,accountId,item,context)));
        if(process.env.WORKBENCH_READ_ENABLED==='true'&&raw.length){
          // Failure is "unavailable", never a false zero or message-total fallback.
          let counts:WorkbenchReadCount[]=[];
          try{counts=await readWorkbenchCounts(request,auth,accountId,raw.map(upstreamId).filter((v):v is string=>!!v));}catch{}
          for(let i=0;i<projected.length;i++){const item=projected[i];if(!item)continue;const count=counts.find(c=>c.conversation_id===upstreamId(raw[i]));
            Object.assign(item,{unread_available:!!count,unread_capped:count?.capped??false,unread_count:count?.unread_count??0});}
        }
        const ids = raw.map(upstreamId).filter((id): id is string => Boolean(id));
        const matches = search.profile ? new Set((await pool.query<{id:string}>(
          `SELECT DISTINCT i.chatwoot_conversation_id::text AS id FROM channel_identities i
           JOIN customers c ON c.tenant_id=i.tenant_id AND c.customer_id=i.customer_id
           WHERE i.tenant_id=$1 AND i.chatwoot_conversation_id=ANY($2::bigint[])
             AND (c.name ILIKE $3 OR c.email ILIKE $3 OR c.phone ILIKE $3 OR c.support_note ILIKE $3)`,
          [auth.tenant_id,ids,likeLiteral(search.profile)]
        )).rows.map(row=>row.id)) : null;
        if(matches&&process.env.AI_CUSTOMER_INSIGHTS_ENABLED==='true'&&auth.auth_kind==='console_session'&&auth.platform_user_id&&!auth.impersonation_id){
          const insightMatches=await createCustomerInsightsStore(pool).searchConversationIds({tenantId:auth.tenant_id,accountId,
            userId:auth.platform_user_id,role:auth.role,impersonated:false},search.profile!,[...new Set(ids)]);
          for(const id of insightMatches)matches.add(id);
        }
        const filtered = projected.filter((value,index)=>{
          if (!value) return false;
          const item=raw[index];
          if (matches && !matches.has(upstreamId(item) ?? '') && !value.contact?.display_name.toLocaleLowerCase().includes(search.profile!.toLocaleLowerCase())) return false;
          if (status !== 'all' && normalizeConversationStatus(item.status) !== status) return false;
          const time = Date.parse(value.last_activity_at ?? value.updated_at ?? '');
          return !(search.since !== null && (!Number.isFinite(time) || time < search.since)) && !(search.until !== null && (!Number.isFinite(time) || time >= search.until));
        });
        data.push(...filtered);
        more = raw.length >= 25 && page < 100_000;
        page++;
        if (!more || data.length) break;
      }
      const nextCursor = more ? encodeConversationCursor(secret, auth.tenant_id, search.scope, String(page)) : null;
      if (search.active) await auditRead(auth,'conversation.search','conversation','search',requestId,data.length);
      const channel_setup = data.length === 0 ? await workbenchChannelStatus(pool, auth.tenant_id) : undefined;
      reply(response, 200, requestId, { data, pagination: { next_cursor: nextCursor }, channel_setup,read_receipts_enabled:process.env.WORKBENCH_READ_ENABLED==='true' });
      return true;
    }

    const conversationReplynestId = (messagesMatch ?? detailMatch)![1];
    const mapping = await resolveResource(auth.tenant_id, "conversation", conversationReplynestId);
    if (!mapping || mapping.chatwoot_account_id !== accountId) {
      reply(response, 404, requestId, { error: { code: "conversation_not_found", message: "会话不存在" } });
      return true;
    }

    if (messagesMatch) {
      const cursor = url.searchParams.get("cursor");
      const before = cursor ? decodeConversationCursor(cursor, secret, auth.tenant_id, "messages") : undefined;
      if (cursor && !before) {
        reply(response, 400, requestId, { error: { code: "invalid_cursor", message: "分页游标无效或已被篡改" } });
        return true;
      }
      const raw = await listChatwootMessages(accountId, mapping.chatwoot_resource_id, before);
      const data = (await Promise.all(raw.map(item => projectMessage(auth.tenant_id, accountId, conversationReplynestId, item)))).filter(Boolean);
      const oldestId = raw.map(upstreamId).filter((value): value is string => Boolean(value)).sort((a, b) => Number(a) - Number(b))[0];
      const nextCursor = raw.length >= 20 && oldestId
        ? encodeConversationCursor(secret, auth.tenant_id, "messages", oldestId) : null;
      await auditRead(auth, "conversation.messages_read", "conversation", conversationReplynestId, requestId, data.length);
      reply(response, 200, requestId, { data, pagination: { next_cursor: nextCursor } });
      return true;
    }

    const raw = await getChatwootConversation(accountId, mapping.chatwoot_resource_id);
    const data = await projectConversation(auth.tenant_id, accountId, raw);
    if (!data) throw new Error("Chatwoot returned a conversation without an id");
    await auditRead(auth, "conversation.read", "conversation", conversationReplynestId, requestId);
    reply(response, 200, requestId, { data });
    return true;
  } catch (error) {
    if (attachmentMatch && error instanceof ChatwootReadError) {
      if (error.status === 413) {
        reply(response, 413, requestId, { error: { code: "attachment_too_large", message: "附件超过当前 25 MiB 下载限制" } });
        return true;
      }
      if (error.status === 404) {
        reply(response, 404, requestId, { error: { code: "attachment_not_found", message: "附件不存在或已失效" } });
        return true;
      }
      console.warn("Headless attachment read failed", error.message);
      reply(response, 502, requestId, { error: { code: "attachment_backend_unavailable", message: "附件服务暂不可用，请稍后重试" } });
      return true;
    }
    if (error instanceof ChatwootReadError && error.status === 404) {
      reply(response, 404, requestId, { error: { code: "conversation_not_found", message: "会话不存在" } });
      return true;
    }
    if (error instanceof ChatwootReadError && [401, 403].includes(error.status)) {
      console.warn("Headless conversation access denied", { requestId, status: error.status });
      reply(response, 502, requestId, { error: { code: "conversation_backend_access_denied", message: "会话服务访问配置异常，请联系平台支持" } });
      return true;
    }
    console.warn("Headless conversation read failed", error instanceof Error ? error.message : String(error));
    reply(response, 502, requestId, { error: { code: "conversation_backend_unavailable", message: "会话服务暂不可用，请稍后重试" } });
    return true;
  }
}
