import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pool } from "./database.js";
import { scanWithClamAv, validateTransferFile } from "./file-security.js";
import { buildTransferStorageKey, prepareCleanCopy, readStored, removeStored, storeQuarantined } from "./file-storage.js";
import { readSingleFileMultipart } from "./multipart-upload.js";
import { sendJson } from "./shared.js";
import { attachmentDisposition } from "./conversation-headless-core.js";
import {handleWechatMediaSend} from './wechat-media-send-api.js';
import {cleanupQuickReplyImages} from './quick-reply-images-api.js';

type FileTransferAuth = {
  tenant_id: string;
  role: "tenant_admin" | "supervisor" | "agent";
  actor_id: string;
  auth_kind: "api_key" | "console_session";
  platform_user_id: string | null;
};

type TransferRow = {
  transfer_id: string; tenant_id: string; conversation_replynest_id: string;
  direction: "outbound_download" | "inbound_upload"; status: string;
  file_name: string | null; mime_type: string | null; size_bytes: string | null;
  storage_key: string | null; expires_at: string; max_downloads: number; download_count: number;
  uploaded_at: string | null; created_at: string;
};

function reply(response: ServerResponse, status: number, requestId: string, body: Record<string, unknown>) {
  sendJson(response, status, { request_id: requestId, ...body });
}

function tokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function validToken(token: string): boolean { return /^[A-Za-z0-9_-]{43}$/.test(token); }
function publicOrigin(): string { return (process.env.CONSOLE_PUBLIC_ORIGIN ?? "http://localhost:3200").replace(/\/$/, ""); }
function transferLink(direction: TransferRow["direction"], token: string): string {
  return `${publicOrigin()}/${direction === "inbound_upload" ? "upload" : "files"}/${token}`;
}

async function conversationMapping(tenantId: string, conversationId: string) {
  const result = await pool.query<{ chatwoot_account_id: string; chatwoot_resource_id: string }>(
    `SELECT chatwoot_account_id::text,chatwoot_resource_id FROM conversation_resource_mappings
      WHERE tenant_id=$1 AND resource_type='conversation' AND replynest_resource_id=$2`, [tenantId, conversationId]
  );
  return result.rows[0];
}

async function assertConsoleMember(auth: FileTransferAuth, conversationId: string) {
  if (auth.auth_kind !== "console_session" || !auth.platform_user_id) throw new Error("console_session_required");
  const mapping = await conversationMapping(auth.tenant_id, conversationId);
  if (!mapping) throw new Error("conversation_not_found");
  const member = await pool.query(
    `SELECT 1 FROM tenant_memberships WHERE tenant_id=$1 AND platform_user_id=$2 AND status='active' AND chatwoot_account_id=$3`,
    [auth.tenant_id, auth.platform_user_id, mapping.chatwoot_account_id]
  );
  if (!member.rows[0]) throw new Error("membership_disabled");
  const identity = await pool.query<{ channel: string }>(
    `SELECT channel FROM channel_identities WHERE tenant_id=$1 AND chatwoot_conversation_id=$2 LIMIT 1`,
    [auth.tenant_id, mapping.chatwoot_resource_id]
  );
  return { ...mapping, channel: identity.rows[0]?.channel ?? "unknown" };
}

async function cleanUpload(tenantId: string, transferId: string, request: IncomingMessage) {
  const upload = await readSingleFileMultipart(request);
  const validated = validateTransferFile(upload.filename, upload.mimeType, upload.data);
  const scan = await scanWithClamAv(upload.data);
  if (!scan.clean) throw new Error("infected_file");
  const quarantine = buildTransferStorageKey(tenantId, transferId, validated.extension);
  await storeQuarantined(quarantine, upload.data);
  const storageKey = await prepareCleanCopy(quarantine);
  if (storageKey !== quarantine) await removeStored(quarantine);
  return { ...upload, mimeType: validated.mimeType, storageKey };
}

function publicTransfer(row: TransferRow) {
  return {
    transfer_id: row.transfer_id,
    direction: row.direction,
    status: row.status,
    file_name: row.file_name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
    expires_at: row.expires_at,
    download_count: row.download_count,
    max_downloads: row.max_downloads,
    uploaded_at: row.uploaded_at,
    created_at: row.created_at
  };
}

async function streamStored(response: ServerResponse, row: TransferRow, requestId: string) {
  if (!row.storage_key || !row.file_name || !row.mime_type) return reply(response, 404, requestId, { error: { code: "file_not_available" } });
  const bytes = await readStored(row.storage_key);
  response.writeHead(200, {
    "content-type": row.mime_type,
    "content-length": String(bytes.length),
    "content-disposition": attachmentDisposition(row.file_name, false),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "referrer-policy": "no-referrer",
    "x-request-id": requestId
  });
  response.end(bytes);
}

export async function handlePublicFileTransferApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  const match = url.pathname.match(/^\/api\/v1\/public\/file-transfers\/([A-Za-z0-9_-]{43})(?:\/(content))?$/);
  if (!match) return false;
  const requestId = randomUUID();
  const token = match[1];
  if (!validToken(token)) { reply(response, 404, requestId, { error: { code: "file_link_not_found" } }); return true; }
  const hashed = tokenHash(token);
  if (request.method === "GET" && match[2] === "content") {
    const claimed = await pool.query<TransferRow>(
      `UPDATE conversation_file_transfers SET download_count=download_count+1,last_downloaded_at=NOW(),updated_at=NOW()
        WHERE token_hash=$1 AND direction='outbound_download' AND status='ready' AND expires_at>NOW() AND download_count<max_downloads
        RETURNING *`, [hashed]
    );
    if (!claimed.rows[0]) { reply(response, 410, requestId, { error: { code: "file_link_expired", message: "下载链接已过期或已达到下载次数限制" } }); return true; }
    await streamStored(response, claimed.rows[0], requestId); return true;
  }
  const found = await pool.query<TransferRow>(`SELECT * FROM conversation_file_transfers WHERE token_hash=$1`, [hashed]);
  const row = found.rows[0];
  if (!row) { reply(response, 404, requestId, { error: { code: "file_link_not_found" } }); return true; }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await pool.query(`UPDATE conversation_file_transfers SET status='expired',updated_at=NOW() WHERE transfer_id=$1 AND status IN ('pending_upload','ready')`, [row.transfer_id]);
    reply(response, 410, requestId, { error: { code: "file_link_expired", message: "文件链接已过期" } }); return true;
  }
  if (request.method === "GET") {
    reply(response, 200, requestId, { data: { ...publicTransfer(row), upload_available: row.direction === "inbound_upload" && row.status === "pending_upload", download_available: row.direction === "outbound_download" && row.status === "ready" && row.download_count < row.max_downloads } });
    return true;
  }
  if (request.method === "POST" && row.direction === "inbound_upload" && row.status === "pending_upload") {
    let storedKey: string | undefined;
    try {
      const upload = await cleanUpload(row.tenant_id, row.transfer_id, request);
      storedKey = upload.storageKey;
      const client = await pool.connect(); let updated;
      try {
        await client.query("BEGIN");
        updated = await client.query<TransferRow>(
          `UPDATE conversation_file_transfers SET status='ready',file_name=$2,mime_type=$3,size_bytes=$4,storage_key=$5,uploaded_at=NOW(),updated_at=NOW()
            WHERE transfer_id=$1 AND status='pending_upload' AND expires_at>NOW() RETURNING *`,
          [row.transfer_id, upload.filename, upload.mimeType, upload.data.length, upload.storageKey]
        );
        if (!updated.rows[0]) throw new Error("upload_link_used");
        await client.query(
          `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
           VALUES($1,'public_upload_link',$2,'conversation.file_uploaded','conversation_file_transfer',$2,
             jsonb_build_object('size_bytes',$3::int,'mime_type',$4::text),$5)`,
          [row.tenant_id, row.transfer_id, upload.data.length, upload.mimeType, requestId]
        );
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
      storedKey = undefined;
      reply(response, 201, requestId, { data: publicTransfer(updated.rows[0]) });
    } catch (error) {
      if (storedKey) await removeStored(storedKey).catch(() => undefined);
      const infected = error instanceof Error && error.message === "infected_file";
      if (error instanceof Error && error.message === "upload_link_used") { reply(response, 409, requestId, { error: { code: "upload_link_used", message: "上传链接已被使用" } }); return true; }
      if (infected) await pool.query(`UPDATE conversation_file_transfers SET status='infected',updated_at=NOW() WHERE transfer_id=$1`, [row.transfer_id]);
      const scannerUnavailable = error instanceof Error && /clamav|econn|scan timed out|unexpected clamav/i.test(error.message);
      reply(response, infected ? 422 : scannerUnavailable ? 503 : 400, requestId, { error: { code: infected ? "infected_file" : scannerUnavailable ? "file_scan_unavailable" : "invalid_upload", message: infected ? "文件未通过安全扫描" : scannerUnavailable ? "文件安全扫描服务暂不可用，请稍后重试" : error instanceof Error ? error.message : "文件上传失败" } });
    }
    return true;
  }
  reply(response, 405, requestId, { error: { code: "method_not_allowed" } }); return true;
}

export async function handleFileTransfersApi(request: IncomingMessage, response: ServerResponse, url: URL, auth: FileTransferAuth, requestId: string): Promise<boolean> {
  if(await handleWechatMediaSend(request,response,url,auth,requestId))return true;
  const collection = url.pathname.match(/^\/api\/v1\/conversations\/([0-9a-f-]{36})\/file-transfers$/i);
  const invitation = url.pathname.match(/^\/api\/v1\/conversations\/([0-9a-f-]{36})\/file-transfer-invitations$/i);
  const content = url.pathname.match(/^\/api\/v1\/file-transfers\/([0-9a-f-]{36})\/content$/i);
  if (!collection && !invitation && !content) return false;
  try {
    if (content && request.method === "GET") {
      if (auth.auth_kind !== "console_session" || !auth.platform_user_id) throw new Error("console_session_required");
      const activeMember = await pool.query(
        `SELECT 1 FROM tenant_memberships WHERE tenant_id=$1 AND platform_user_id=$2 AND status='active'`,
        [auth.tenant_id, auth.platform_user_id]
      );
      if (!activeMember.rows[0]) throw new Error("membership_disabled");
      const result = await pool.query<TransferRow>(`SELECT * FROM conversation_file_transfers WHERE tenant_id=$1 AND transfer_id=$2 AND status='ready' AND expires_at>NOW()`, [auth.tenant_id, content[1]]);
      if (!result.rows[0]) { reply(response, 404, requestId, { error: { code: "file_not_found" } }); return true; }
      await streamStored(response, result.rows[0], requestId); return true;
    }
    const conversationId = (collection ?? invitation)![1];
    const mapping = await assertConsoleMember(auth, conversationId);
    if (collection && request.method === "GET") {
      const rows = await pool.query<TransferRow>(
        `SELECT * FROM conversation_file_transfers WHERE tenant_id=$1 AND conversation_replynest_id=$2
          ORDER BY created_at DESC LIMIT 50`, [auth.tenant_id, conversationId]
      );
      reply(response, 200, requestId, { data: rows.rows.map(publicTransfer) }); return true;
    }
    if (invitation && request.method === "POST") {
      const transferId = randomUUID(); const token = randomBytes(32).toString("base64url");
      const client = await pool.connect(); let saved;
      try {
        await client.query("BEGIN");
        saved = await client.query<TransferRow>(
          `INSERT INTO conversation_file_transfers(transfer_id,tenant_id,conversation_replynest_id,direction,status,token_hash,expires_at,created_by)
           VALUES($1,$2,$3,'inbound_upload','pending_upload',$4,NOW()+INTERVAL '24 hours',$5) RETURNING *`,
          [transferId, auth.tenant_id, conversationId, tokenHash(token), auth.platform_user_id]
        );
        await client.query(
          `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
           VALUES($1,'platform_user',$2,'conversation.upload_invitation_created','conversation_file_transfer',$3,
             jsonb_build_object('conversation_id',$4::text,'expires_in_hours',24),$5)`,
          [auth.tenant_id, auth.platform_user_id, transferId, conversationId, requestId]
        );
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
      reply(response, 201, requestId, { data: { ...publicTransfer(saved.rows[0]), url: transferLink("inbound_upload", token) } }); return true;
    }
    if (collection && request.method === "POST") {
      const transferId = randomUUID(); const token = randomBytes(32).toString("base64url");
      const upload = await cleanUpload(auth.tenant_id, transferId, request);
      const client = await pool.connect(); let saved;
      try {
        await client.query("BEGIN");
        saved = await client.query<TransferRow>(
          `INSERT INTO conversation_file_transfers(transfer_id,tenant_id,conversation_replynest_id,direction,status,file_name,mime_type,size_bytes,storage_key,token_hash,expires_at,created_by,uploaded_at)
           VALUES($1,$2,$3,'outbound_download','ready',$4,$5,$6,$7,$8,NOW()+INTERVAL '7 days',$9,NOW()) RETURNING *`,
          [transferId, auth.tenant_id, conversationId, upload.filename, upload.mimeType, upload.data.length, upload.storageKey, tokenHash(token), auth.platform_user_id]
        );
        await client.query(
          `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
           VALUES($1,'platform_user',$2,'conversation.file_link_created','conversation_file_transfer',$3,
             jsonb_build_object('conversation_id',$4::text,'channel',$5::text,'delivery_mode','relay_link','size_bytes',$6::int,'mime_type',$7::text),$8)`,
          [auth.tenant_id, auth.platform_user_id, transferId, conversationId, mapping.channel, upload.data.length, upload.mimeType, requestId]
        );
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); await removeStored(upload.storageKey).catch(() => undefined); throw error; }
      finally { client.release(); }
      const native=process.env.WECHAT_MEDIA_ENABLED==='true'&&['shared_wechat','wechat_official_account'].includes(mapping.channel)&&['image/jpeg','image/png','image/gif','video/mp4'].includes(upload.mimeType)&&upload.data.length<=(upload.mimeType==='video/mp4'?10:2)*1024*1024;
      reply(response, 201, requestId, { data: { ...publicTransfer(saved.rows[0]), url: transferLink("outbound_download", token), channel: mapping.channel, delivery_mode: native?'wechat_media':'relay_link', native_attachment_supported: native } }); return true;
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : "file_transfer_failed";
    const known: Record<string, [number, string]> = {
      console_session_required: [403, "仅已登录坐席可使用文件功能"], conversation_not_found: [404, "会话不存在"],
      membership_disabled: [403, "当前成员无权操作该会话"], infected_file: [422, "文件未通过安全扫描"]
    };
    const scannerUnavailable = /clamav|econn|scan timed out|unexpected clamav/i.test(code);
    const [status, message] = known[code] ?? (scannerUnavailable ? [503, "文件安全扫描服务暂不可用，请稍后重试"] : [400, code]);
    reply(response, status, requestId, { error: { code, message } }); return true;
  }
  reply(response, 405, requestId, { error: { code: "method_not_allowed" } }); return true;
}

export async function cleanupExpiredFileTransfers(limit = 100): Promise<number> {
  // A library cleanup failure must not postpone existing relay expiry cleanup.
  await cleanupQuickReplyImages().catch(()=>console.error('quick_reply_image_cleanup_failed'));
  const result = await pool.query<{ storage_key: string | null }>(
    `WITH expired AS (
       SELECT transfer_id,storage_key FROM conversation_file_transfers
        WHERE status IN ('pending_upload','ready') AND expires_at<=NOW()
        ORDER BY expires_at ASC FOR UPDATE SKIP LOCKED LIMIT $1
     )
     UPDATE conversation_file_transfers transfer
        SET status='expired',storage_key=NULL,updated_at=NOW()
       FROM expired WHERE transfer.transfer_id=expired.transfer_id
     RETURNING expired.storage_key`, [Math.max(1, Math.min(limit, 500))]
  );
  for (const row of result.rows) {
    if (row.storage_key) await removeStored(row.storage_key).catch(error => {
      console.warn("Expired file transfer cleanup storage removal failed", error instanceof Error ? error.message : "unknown");
    });
  }
  return result.rowCount ?? 0;
}
