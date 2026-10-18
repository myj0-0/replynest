import { createHash, randomUUID } from "node:crypto";
import { pool } from "./database.js";
import { emitNotification, notificationPreference } from "./notification-gateway.js";
import { safeNotificationText } from "./notification-core.js";
import { messageNotificationSummary } from "./notification-message-policy.js";
import {mediaNotice,type MessageMediaNotice} from './wechat-media-core.js';

function messageKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export async function recordInboundAttention(input: {
  tenant_id: string;
  conversation_id: string;
  message_id: string;
  text: string;
  media?:MessageMediaNotice;
  occurred_at?:string;
  notify?:boolean;
}): Promise<void> {
  const preference = await notificationPreference(input.tenant_id);
  const preview = preference.include_message_preview ? safeNotificationText(input.text, 120) : null;
  const notice=mediaNotice(input.media);
  await pool.query(
    `INSERT INTO conversation_attention
      (tenant_id,chatwoot_conversation_id,last_inbound_message_id,last_inbound_at,message_preview,status,
       last_outbound_at,unattended_notification_id,updated_at)
     VALUES ($1,$2,$3,COALESCE($5::timestamptz,NOW()),$4,'pending',NULL,NULL,NOW())
     ON CONFLICT (tenant_id,chatwoot_conversation_id) DO UPDATE SET
       last_inbound_message_id=EXCLUDED.last_inbound_message_id,last_inbound_at=EXCLUDED.last_inbound_at,
       message_preview=EXCLUDED.message_preview,status=CASE WHEN conversation_attention.last_outbound_at>=EXCLUDED.last_inbound_at THEN 'responded' ELSE 'pending' END,unattended_notification_id=NULL,updated_at=NOW()
       WHERE conversation_attention.last_inbound_at<EXCLUDED.last_inbound_at`,
    [input.tenant_id, input.conversation_id, input.message_id, preview,input.occurred_at??null],
  );
  if(process.env.WECHAT_MEDIA_ENABLED==='true')await pool.query(`UPDATE conversation_attention SET media_notice=$4 WHERE tenant_id=$1 AND chatwoot_conversation_id=$2 AND last_inbound_message_id=$3`,[input.tenant_id,input.conversation_id,input.message_id,mediaNotice(input.media)??null]);
  if (input.notify!==false&&(preference.message_notification_mode === "every_message" || preference.message_notification_mode === "both")) {
    await emitNotification({
      tenant_id: input.tenant_id,
      event_type: "conversation.inbound.message",
      severity: "info",
      title: "收到新的客户消息",
      summary: messageNotificationSummary(preference.include_message_preview, input.text),
      dedupe_key: `inbound-message:${messageKey(input.message_id)}`,
      resource_type: "chatwoot_conversation",
      resource_id: input.conversation_id,
      metadata: { chatwoot_conversation_id: Number(input.conversation_id), source: "wechat_official_account",...(notice?{message_type:notice.message_type,attachment_count:notice.attachment_count,media_view_path:notice.view_path??null,media_attachment_id:notice.attachment_id??null,media_status:notice.processing_status??null}:{}) },
      requires_action: false,
      webhook_scope: "message",
    });
  }
}

export async function markConversationResponded(tenantId: string, conversationId: string): Promise<void> {
  const updated = await pool.query<{ unattended_notification_id: string | null }>(
    `UPDATE conversation_attention SET status='responded',last_outbound_at=NOW(),updated_at=NOW()
      WHERE tenant_id=$1 AND chatwoot_conversation_id=$2 AND status='pending'
      RETURNING unattended_notification_id`,
    [tenantId, conversationId],
  );
  const notificationId = updated.rows[0]?.unattended_notification_id;
  if (notificationId) {
    const resolved = await pool.query(
      `UPDATE notification_events SET status='resolved',resolved_at=NOW(),updated_at=NOW()
        WHERE tenant_id=$1 AND notification_id=$2 AND status IN ('open','acknowledged') RETURNING notification_id`,
      [tenantId, notificationId],
    );
    if (resolved.rowCount) {
      await pool.query(
        `INSERT INTO audit_logs
          (tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
         VALUES ($1,'system','conversation_attention','notification.auto_resolved','notification',$2,
                 '{"reason":"agent_replied"}'::jsonb,$3)`,
        [tenantId, notificationId, randomUUID()],
      );
    }
  }
}

export async function processUnattendedConversations(): Promise<void> {
  const pending = await pool.query<{
    tenant_id: string; chatwoot_conversation_id: string; last_inbound_message_id: string; message_preview: string | null;media_notice?:unknown;
  }>(
    `SELECT a.tenant_id,a.chatwoot_conversation_id,a.last_inbound_message_id,a.message_preview,${process.env.WECHAT_MEDIA_ENABLED==='true'?'a.media_notice':'NULL::jsonb AS media_notice'}
       FROM conversation_attention a
       JOIN tenants t ON t.tenant_id=a.tenant_id
       LEFT JOIN notification_preferences p ON p.tenant_id=a.tenant_id
      WHERE a.status='pending' AND a.unattended_notification_id IS NULL
        AND COALESCE(p.message_notification_mode,'unattended') IN ('unattended','both')
        AND a.last_inbound_at<=NOW()-make_interval(mins=>COALESCE(p.unattended_minutes,10))
      ORDER BY a.last_inbound_at LIMIT 20`,
  );
  for (const row of pending.rows) {
    const created = await emitNotification({
      tenant_id: row.tenant_id,
      event_type: "conversation.unattended",
      severity: "warning",
      title: "客户消息长时间未处理",
      summary: row.message_preview
        ? `客户消息仍未获得人工回复，消息预览：${safeNotificationText(row.message_preview, 120)}`
        : "客户消息仍未获得人工回复，请尽快进入客服工作台处理。",
      dedupe_key: `unattended:${row.chatwoot_conversation_id}:${messageKey(row.last_inbound_message_id)}`,
      resource_type: "chatwoot_conversation",
      resource_id: row.chatwoot_conversation_id,
      metadata: { chatwoot_conversation_id: Number(row.chatwoot_conversation_id), source: "wechat_official_account",...(mediaNotice(row.media_notice)?{message_type:mediaNotice(row.media_notice)!.message_type,attachment_count:mediaNotice(row.media_notice)!.attachment_count,media_view_path:mediaNotice(row.media_notice)!.view_path??null,media_attachment_id:mediaNotice(row.media_notice)!.attachment_id??null,media_status:mediaNotice(row.media_notice)!.processing_status??null}:{}) },
      webhook_scope: "unattended",
    });
    await pool.query(
      `UPDATE conversation_attention SET unattended_notification_id=$4,updated_at=NOW()
        WHERE tenant_id=$1 AND chatwoot_conversation_id=$2 AND last_inbound_message_id=$3
          AND status='pending' AND unattended_notification_id IS NULL`,
      [row.tenant_id, row.chatwoot_conversation_id, row.last_inbound_message_id, created.notification_id],
    );
  }
}
