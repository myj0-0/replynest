import type { IncomingMessage, ServerResponse } from "node:http";
import { pool } from "./database.js";
import { readBody, sendJson } from "./shared.js";
import { canManageQuickReplies } from "./quick-reply-permissions.js";
import {handleQuickReplyImagesApi,imageView} from './quick-reply-images-api.js';
import {quickReplyImageEnabled,quickReplyPayload} from './quick-reply-images-core.js';

type QuickReplyAuth = {
  tenant_id: string;
  role: "tenant_admin" | "supervisor" | "agent";
  actor_id: string;
  auth_kind: "api_key" | "console_session";
  platform_user_id: string | null;
  impersonation_id?: string | null;
  session_scope?: string | null;
};

function reply(response: ServerResponse, status: number, requestId: string, body: Record<string, unknown>) {
  sendJson(response, status, { request_id: requestId, ...body });
}

async function input(request: IncomingMessage) {
  try {
    const value = JSON.parse((await readBody(request)).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new Error("invalid_json"); }
}

function cleanText(value: unknown, maximum: number, field: string) {
  const text = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (!text || text.length > maximum) throw new Error(`${field}长度不正确`);
  return text;
}

function shortcut(value: unknown) {
  const normalized = String(value ?? "").trim().replace(/^\/+/, "").toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(normalized)) throw new Error("快捷指令只能包含小写字母、数字、下划线和连字符");
  return normalized;
}

async function audit(auth: QuickReplyAuth, requestId: string, action: string, id: string, after: Record<string, unknown>) {
  await pool.query(
    `INSERT INTO audit_logs (tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
     VALUES ($1,$2,$3,$4,'tenant_quick_reply',$5,$6,$7)`,
    [auth.tenant_id, auth.auth_kind, auth.actor_id, action, id, after, requestId]
  );
}

// One transaction for the reply, asset reference and audit; text-only schemas
// are not changed or queried until the explicit image component is enabled.
async function saveImageReply(auth:QuickReplyAuth,requestId:string,body:Record<string,unknown>,id?:string){
 const command=shortcut(body.shortcut),title=cleanText(body.title,80,'标题'),payload=quickReplyPayload(body,true),c=await pool.connect();
 try{
  await c.query('BEGIN');
  const member=await c.query("SELECT 1 FROM tenant_memberships m JOIN tenants t ON t.tenant_id=m.tenant_id AND t.chatwoot_account_id=m.chatwoot_account_id WHERE m.tenant_id=$1 AND m.platform_user_id=$2 AND m.status='active' AND m.role IN('tenant_admin','supervisor') AND t.status IN('active','test') FOR SHARE OF m,t",[auth.tenant_id,auth.platform_user_id]);if(!member.rowCount)throw Error('仅有效管理员或主管可保存快捷回复');
  if(payload.image_asset_id){const image=await c.query("SELECT asset_id FROM tenant_quick_reply_images WHERE tenant_id=$1 AND asset_id=$2 AND status='ready' FOR UPDATE",[auth.tenant_id,payload.image_asset_id]);if(!image.rowCount)throw Error('请选择本企业的可用图片');}
  const previous=id?(await c.query('SELECT image_asset_id FROM tenant_quick_replies WHERE tenant_id=$1 AND quick_reply_id=$2 AND status=\'active\' FOR UPDATE',[auth.tenant_id,id])).rows[0]:null;
  if(id&&!previous){await c.query('ROLLBACK');return null;}
  const row=(await c.query(id?`UPDATE tenant_quick_replies SET shortcut=$3,title=$4,content=$5,image_asset_id=$6,updated_by=$7,updated_at=GREATEST(date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',updated_at)+INTERVAL '1 millisecond')
   WHERE tenant_id=$1 AND quick_reply_id=$2 AND status='active' RETURNING *`:
   `INSERT INTO tenant_quick_replies(tenant_id,quick_reply_id,shortcut,title,content,image_asset_id,created_by,updated_by,updated_at) VALUES($1,COALESCE($2::uuid,gen_random_uuid()),$3,$4,$5,$6,$7,$7,date_trunc('milliseconds',clock_timestamp())) RETURNING *`,
   [auth.tenant_id,id??null,command,title,payload.content,payload.image_asset_id,auth.platform_user_id])).rows[0];
  if(payload.image_asset_id)await c.query('UPDATE tenant_quick_reply_images SET orphaned_at=NULL WHERE tenant_id=$1 AND asset_id=$2',[auth.tenant_id,payload.image_asset_id]);
  if(previous?.image_asset_id&&previous.image_asset_id!==payload.image_asset_id)await c.query(`UPDATE tenant_quick_reply_images i SET orphaned_at=COALESCE(orphaned_at,NOW())
   WHERE i.tenant_id=$1 AND i.asset_id=$2 AND NOT EXISTS(SELECT 1 FROM tenant_quick_replies q WHERE q.tenant_id=i.tenant_id AND q.image_asset_id=i.asset_id AND q.status='active')`,[auth.tenant_id,previous.image_asset_id]);
  await c.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
   VALUES($1,$2,$3,$4,'tenant_quick_reply',$5,$6,$7)`,[auth.tenant_id,auth.auth_kind,auth.actor_id,id?'quick_reply.updated':'quick_reply.created',row.quick_reply_id,{shortcut:command,title,image_asset_id:payload.image_asset_id},requestId]);
  await c.query('COMMIT');return {quick_reply_id:row.quick_reply_id,shortcut:command,title,content:payload.content,updated_at:row.updated_at,image_asset_id:payload.image_asset_id};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}

export async function handleQuickRepliesApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  auth: QuickReplyAuth,
  requestId: string
): Promise<boolean> {
  if(await handleQuickReplyImagesApi(request,response,url,auth,requestId))return true;
  if (!url.pathname.startsWith("/api/v1/quick-replies")) return false;
  if (auth.auth_kind !== "console_session") {
    reply(response, 403, requestId, { error: { code: "console_session_required", message: "快捷回复仅供控制台坐席使用" } });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/quick-replies") {
    const management = url.searchParams.get("mode") === "manage";
    const offset = Number(url.searchParams.get("offset") ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) {
      reply(response, 400, requestId, { error: { code: "invalid_pagination" } }); return true;
    }
    const limit = management ? 50 : 20;
    const query = String(url.searchParams.get("query") ?? "").trim().replace(/^\/+/, "").slice(0, 80);
    const rich=quickReplyImageEnabled();
    const rows = await pool.query(
      `SELECT q.quick_reply_id,q.shortcut,q.title,q.content,q.updated_at${rich?',q.image_asset_id,i.asset_id,i.file_name,i.mime_type,i.size_bytes':''}
         FROM tenant_quick_replies q ${rich?"LEFT JOIN tenant_quick_reply_images i ON i.tenant_id=q.tenant_id AND i.asset_id=q.image_asset_id AND i.status='ready'":''}
        WHERE q.tenant_id=$1 AND q.status='active'
          AND ($2='' OR q.shortcut ILIKE $3 OR q.title ILIKE $3 OR q.content ILIKE $3)
        ORDER BY CASE WHEN q.shortcut=$2 THEN 0 WHEN q.shortcut ILIKE $4 THEN 1 ELSE 2 END,q.shortcut,q.quick_reply_id
        LIMIT $5 OFFSET $6`,
      [auth.tenant_id, query.toLowerCase(), `%${query}%`, `${query.toLowerCase()}%`, limit + 1, management ? offset : 0]
    );
    const imageAccess=rich&&!auth.impersonation_id&&auth.session_scope!=='copilot_embed';
    reply(response, 200, requestId, { data: rows.rows.slice(0, limit).map(row=>({quick_reply_id:row.quick_reply_id,shortcut:row.shortcut,title:row.title,content:row.content,updated_at:row.updated_at,
      image:imageAccess&&row.asset_id?imageView(row):null,reply_type:rich&&row.image_asset_id?(row.content?'text_image':'image'):'text'})), images_enabled:imageAccess,can_manage: canManageQuickReplies(auth), next_offset: rows.rows.length > limit ? offset + limit : null });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/quick-replies") {
    if (!canManageQuickReplies(auth)) {
      reply(response, 403, requestId, { error: { code: "manager_required", message: "仅管理员或主管可以新增快捷回复" } });
      return true;
    }
    try {
      const body = await input(request);
      if(quickReplyImageEnabled()){
        const data=await saveImageReply(auth,requestId,body);reply(response,201,requestId,{data});return true;
      }
      if(body.image_asset_id)throw Error('图片快捷回复尚未开放');
      const command = shortcut(body.shortcut);
      const title = cleanText(body.title, 80, "标题");
      const content = cleanText(body.content, 4000, "回复内容");
      const inserted = await pool.query(
        `INSERT INTO tenant_quick_replies (tenant_id,shortcut,title,content,created_by,updated_by)
         VALUES ($1,$2,$3,$4,$5,$5)
         RETURNING quick_reply_id,shortcut,title,content,updated_at`,
        [auth.tenant_id, command, title, content, auth.platform_user_id]
      );
      await audit(auth, requestId, "quick_reply.created", inserted.rows[0].quick_reply_id, { shortcut: command, title });
      reply(response, 201, requestId, { data: inserted.rows[0] });
    } catch (error: any) {
      const duplicate = error?.code === "23505";
      reply(response, duplicate ? 409 : 400, requestId, { error: {
        code: duplicate ? "quick_reply_conflict" : "invalid_quick_reply",
        message: duplicate ? "该快捷指令已存在" : error instanceof Error ? error.message : "快捷回复不正确"
      } });
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/quick-replies/import") {
    if (!canManageQuickReplies(auth)) {
      reply(response, 403, requestId, { error: { code: "manager_required", message: "仅管理员或主管可以导入快捷回复" } });
      return true;
    }
    try {
      const body = await input(request);
      if (Object.keys(body).some(key => key !== "items") || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 500) {
        throw new Error("单次导入需要包含 1-500 条快捷回复");
      }
      const items = body.items.map((raw, index) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`第 ${index + 1} 条记录格式不正确`);
        const row = raw as Record<string, unknown>;
        if (Object.keys(row).some(key => !["shortcut", "title", "content"].includes(key))) throw new Error(`第 ${index + 1} 条记录包含未知字段`);
        return { shortcut: shortcut(row.shortcut), title: cleanText(row.title, 80, "标题"), content: cleanText(row.content, 4000, "回复内容") };
      });
      if (new Set(items.map(item => item.shortcut)).size !== items.length) throw new Error("导入文件中存在重复快捷指令");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const imported = [] as Array<Record<string, unknown>>;
        for (const item of items) {
          const saved = await client.query(
            `INSERT INTO tenant_quick_replies (tenant_id,shortcut,title,content,created_by,updated_by)
             VALUES ($1,$2,$3,$4,$5,$5)
             ON CONFLICT (tenant_id,shortcut) WHERE status='active'
             DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,updated_by=EXCLUDED.updated_by,updated_at=NOW()
             ${quickReplyImageEnabled()?'WHERE tenant_quick_replies.image_asset_id IS NULL':''}
             RETURNING quick_reply_id,shortcut,title,content,updated_at,(xmax=0) AS created`,
            [auth.tenant_id, item.shortcut, item.title, item.content, auth.platform_user_id]
          );
          if(!saved.rows[0])throw Error('同名图片或图文快捷回复不能用文字导入覆盖，请在管理页面编辑');
          imported.push(saved.rows[0]);
        }
        await client.query(
          `INSERT INTO audit_logs (tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
           VALUES ($1,$2,$3,'quick_reply.imported','tenant',$1,
             jsonb_build_object('total',$4::int,'created',$5::int,'updated',$6::int),$7)`,
          [auth.tenant_id, auth.auth_kind, auth.actor_id, imported.length,
            imported.filter(item => item.created === true).length, imported.filter(item => item.created !== true).length, requestId]
        );
        await client.query("COMMIT");
        reply(response, 200, requestId, {
          data: {
            total: imported.length,
            created: imported.filter(item => item.created === true).length,
            updated: imported.filter(item => item.created !== true).length,
            items: imported.map(({ created, ...item }) => item)
          }
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    } catch (error) {
      reply(response, 400, requestId, { error: { code: "invalid_quick_reply_import", message: error instanceof Error ? error.message : "快捷回复导入内容不正确" } });
    }
    return true;
  }

  const match = url.pathname.match(/^\/api\/v1\/quick-replies\/([0-9a-f-]{36})$/i);
  if (request.method === "PATCH" && match) {
    if (!canManageQuickReplies(auth)) {
      reply(response, 403, requestId, { error: { code: "manager_required", message: "仅管理员或主管可以编辑快捷回复" } }); return true;
    }
    try {
      const body = await input(request);
      if(quickReplyImageEnabled()){
        const data=await saveImageReply(auth,requestId,body,match[1]);
        reply(response,data?200:404,requestId,data?{data}:{error:{code:'quick_reply_not_found',message:'快捷回复不存在'}});return true;
      }
      if(body.image_asset_id)throw Error('图片快捷回复尚未开放');
      const command = shortcut(body.shortcut);
      const title = cleanText(body.title, 80, "标题");
      const content = cleanText(body.content, 4000, "回复内容");
      const updated = await pool.query(
        `UPDATE tenant_quick_replies SET shortcut=$3,title=$4,content=$5,updated_by=$6,updated_at=NOW()
         WHERE tenant_id=$1 AND quick_reply_id=$2 AND status='active'
         RETURNING quick_reply_id,shortcut,title,content,updated_at`,
        [auth.tenant_id,match[1],command,title,content,auth.platform_user_id]);
      if (!updated.rows[0]) { reply(response,404,requestId,{error:{code:"quick_reply_not_found",message:"快捷回复不存在"}}); return true; }
      await audit(auth, requestId, "quick_reply.updated", match[1], { shortcut: command, title });
      reply(response,200,requestId,{data:updated.rows[0]});
    } catch (error: any) {
      reply(response,error?.code === "23505" ? 409 : 400,requestId,{error:{code:"invalid_quick_reply",message:error?.code === "23505" ? "该快捷指令已存在" : "快捷回复格式不正确"}});
    }
    return true;
  }
  if (request.method === "DELETE" && match) {
    if (!canManageQuickReplies(auth)) {
      reply(response, 403, requestId, { error: { code: "manager_required", message: "仅管理员或主管可以删除快捷回复" } });
      return true;
    }
    const removed = await pool.query(
      `UPDATE tenant_quick_replies SET status='deleted',deleted_at=NOW(),updated_at=NOW(),updated_by=$3
        WHERE tenant_id=$1 AND quick_reply_id=$2 AND status='active'
        RETURNING quick_reply_id,shortcut,title`,
      [auth.tenant_id, match[1], auth.platform_user_id]
    );
    if (!removed.rows[0]) {
      reply(response, 404, requestId, { error: { code: "quick_reply_not_found", message: "快捷回复不存在" } });
      return true;
    }
    await audit(auth, requestId, "quick_reply.deleted", match[1], { shortcut: removed.rows[0].shortcut, title: removed.rows[0].title });
    if(quickReplyImageEnabled())await pool.query(`UPDATE tenant_quick_reply_images i SET orphaned_at=COALESCE(orphaned_at,NOW())
     WHERE i.tenant_id=$1 AND i.asset_id=(SELECT image_asset_id FROM tenant_quick_replies WHERE tenant_id=$1 AND quick_reply_id=$2)
     AND NOT EXISTS(SELECT 1 FROM tenant_quick_replies q WHERE q.tenant_id=i.tenant_id AND q.image_asset_id=i.asset_id AND q.status='active')`,[auth.tenant_id,match[1]]);
    reply(response, 200, requestId, { data: { quick_reply_id: match[1], deleted: true } });
    return true;
  }

  reply(response, 405, requestId, { error: { code: "method_not_allowed" } });
  return true;
}
