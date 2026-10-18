import {aiModelHealth,startAiModelMonitor} from './ai-model-monitor.js';
import {authenticateChatwootCallback,canonicalChatwootCallback} from './chatwoot-callback-security.js';
import {getChatwootConversation,listChatwootMessages} from './conversation-headless-chatwoot.js';
import {processPlanCommissions} from './plan-commissions.js';
import {processSubscriptionMail} from './subscription-mail.js';
import {processAiLowMail} from './ai-low-mail.js';
import {refreshAiUsageSummary} from './ai-usage-summary.js';
import { randomUUID } from "node:crypto";
import { enqueueAutomationPlans,processAutomationPlanQueue } from './automation-plan-worker.js';
import {processAssignmentCommands} from './assignment-execution.js';
import { sharedWechatConfig } from "./shared-wechat-config.js";
import { createServer } from "node:http";
import {DatabaseBusyError} from './bounded-pool.js';
import {startBoundedPoll} from './bounded-poll.js';
import {automationRuntimeMonitor,startAutomationRuntimeMonitor} from './automation-runtime-monitor.js';
import {runtimeCounters} from './automation-runtime-health.js';
import {handleAutomationHealth} from './automation-diagnostics-auth.js';
import { validateAssignmentStartup } from './atomic-assignment.js';
import { handleBusinessApi } from "./business-api.js";
import { processExternalWebhooks } from "./open-platform-webhooks.js";
import { createContact, createConversation, createIncomingMessage } from "./chatwoot.js";
import { findIdentity, findIdentityByConversation, pool, seedBusinessLayer } from "./database.js";
import {bootstrapDatabaseRuntime} from './database-runtime.js';
import {databaseComponents} from './database-components.js';
import { postJson, readBody, requiredEnv, sendJson, verifySignature } from "./shared.js";
import { bootstrapDemoMembershipWithRetry } from "./identity-bootstrap.js";
import { expireDueTrials } from "./trial.js";
import { qualifyMaturedReferrals } from "./referral.js";
import { reconcileReferralRewards } from "./referral-risk.js";
import { officialConfigFromEnv, officialConfigured, parseOfficialInbound, sendOfficialText, verifyOfficialCallback } from "./wechat-official.js";
import { classifyOutboundFailure, failureNote, retryDelaySeconds } from "./outbound-delivery.js";
import { emitNotification, processPendingNotifications } from "./notification-gateway.js";
import { markConversationResponded, processUnattendedConversations, recordInboundAttention } from "./conversation-attention.js";
import {processReceptionDraft} from './reception-draft-worker.js';
import {discoverReceptionMessages} from './reception-discovery.js';
import {processReceptionEvent,receptionEventBacklog} from './reception-events.js';
import {startReceptionPoller} from './reception-poller.js';
import {acceptReceptionCallback} from './reception-events.js';
import {validateAutomaticReceptionStartup} from './automatic-reception-config.js';
import {createAutomaticGatewayRuntime} from './automatic-reception-gateway.js';
import {enqueueStudioMessageEvent} from './studio-message-events.js';
import {createLiveAutomaticGenerator} from './automatic-reception-generation-live.js';
import {createAutomaticPresentationPreparation} from './reception-automatic-presentation.js';
import {createReceptionPersonalizationApi,receptionPresentationAvailability} from './reception-personalization-api.js';
import {validateReceptionHistoryStartup,validateReceptionDraftPresentationStartup,createReceptionHistoryQueueRuntime} from './reception-history-runtime.js';
import {createReceptionDraftPreparation} from './reception-draft-preparation.js';
import {createReceptionHistoryNativeClient} from './reception-history-native-client.js';
import {createAuthorizedReceptionHistoryReader} from './reception-history-reader.js';
import {createLiveHistoryKnowledgeService} from './reception-history-knowledge-live.js';
import {createReceptionStyleLearningWorker} from './reception-style-learning-worker.js';
import {qwenRuntimeConfig} from './qwen-runtime.js';
import {createGatewayLifecycle} from './gateway-lifecycle.js';
import {validateCustomerInsightsStartup} from './customer-insights-config.js';
import {createLiveCustomerInsightsRuntime} from './customer-insights-runtime.js';
import { claimInboundBatch, completeInbound, enqueueInbound, failInbound, type InboundJob } from "./inbound-queue.js";
import { processPaymentLedgerOutbox } from "./payment-ledger-outbox.js";
import { processPlanPurchases } from "./plan-checkout.js";
import { paymentProjectionHealth } from "./payment-operations.js";
import { runPaymentReconciliation } from "./payment-reconciliation.js";
import { paymentQueryHealth, processPaymentQueries, schedulePaymentQueries } from "./payment-query.js";
import { createAlipayOperations } from "./alipay-operations.js";
import { processPaymentRefunds } from "./payment-refunds.js";
import { scanQuotaWarnings } from "./quota-monitor.js";
import { processMessageCampaignDeliveries } from "./message-campaign-delivery.js";
import { campaignDeliveryHealth, scanCampaignDeliveryHealth } from "./campaign-observability.js";
import {monitorInteger} from './campaign-monitor-core.js';
import { registrationSmsHealth } from "./registration-operations.js";
import { registrationRetentionPreview,retentionPolicy,runRegistrationRetention } from "./privacy-lifecycle.js";
import {cleanExpiredSecurityLogs,drainSecurityCaptures} from './tenant-security.js';
import { resolveWeChatConnection, resolveWeChatConnectionById } from "./wechat-connection.js";
import {queueWechatMedia,processWechatMedia,expireWechatMedia,publishWechatMediaNotifications} from './wechat-media-store.js';
import { classifyDeliveredRecommendation } from "./copilot-composer-core.js";
import { cleanupExpiredFileTransfers } from "./file-transfers-api.js";
import { handleSharedWechatCallback } from "./shared-wechat-callback.js";
import {handleAlipayNotify} from './alipay-notify.js';
import {alipayConfigFromEnv} from './alipay-provider.js';
import {recordAlipaySettlement} from './alipay-settlement.js';
import {sharedMerchantWelcome} from './shared-wechat-merchant.js';
import {clearSharedWechatProfile} from './shared-wechat-portal.js';
import { handleSharedWechatPortal } from "./shared-wechat-portal.js";
import { recordSharedWechatEvent } from "./shared-wechat-store.js";
import { secretValue } from "./secret-value.js";
import { processSharedWechatInboundBatch } from "./shared-wechat-worker.js";
import { createSharedWechatTransport } from "./shared-wechat-transport.js";
import { isSharedWechatAccountActive } from "./shared-wechat-account-mode.js";
import {createVerifiedWeChatIngressClient} from './verified-wechat-ingress-client.js';
import {projectVerifiedWeChatInbound} from './verified-wechat-ingress.js';

const port = Number(process.env.PORT ?? 3001);
const tenantId = requiredEnv("DEMO_TENANT_ID");
const signingSecret = requiredEnv("MOCK_WECHAT_SECRET");
const mockBaseUrl = requiredEnv("MOCK_WECHAT_BASE_URL");
const chatwootBaseUrl = requiredEnv("CHATWOOT_BASE_URL");
const chatwootAccountId = requiredEnv("CHATWOOT_ACCOUNT_ID");
const chatwootAccessToken = requiredEnv("CHATWOOT_API_ACCESS_TOKEN");
const verifiedIngressClient=process.env.WECHAT_VERIFIED_INGRESS_ENABLED==='true'?createVerifiedWeChatIngressClient({
  origin:chatwootBaseUrl,secret:secretValue('REPLYNEST_AUTOMATIC_REPLY_SECRET')??'',enabled:()=>process.env.WECHAT_VERIFIED_INGRESS_ENABLED==='true'}):undefined;

type InboundMessage = {
  event_id: string;
  message_id: string;
  user_id: string;
  user_name?: string;
  media?:import('./wechat-media-core.js').WeChatMedia;
  text: string;
  occurred_at?: string;
};

async function getOrCreateIdentity(jobTenantId: string, message: InboundMessage, channel: string, connectionId: string | null = null) {
  const existing = await findIdentity(jobTenantId, message.user_id, channel, connectionId);
  if (existing) {
    await pool.query(
      `UPDATE customers SET last_seen_at=NOW(),
         name=CASE WHEN attributes ? 'migrated_from' THEN $1 ELSE name END,
         attributes=attributes - 'migrated_from', updated_at=NOW()
       WHERE tenant_id=$2 AND customer_id=$3`,
      [message.user_name ?? message.user_id, jobTenantId, existing.customer_id]
    );
    return existing;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${jobTenantId}:${channel}:${connectionId ?? "legacy"}:${message.user_id}`]);
    const locked = await client.query(
      `SELECT customer_id, external_user_id, channel_connection_id, chatwoot_source_id, chatwoot_conversation_id
         FROM channel_identities WHERE tenant_id=$1 AND channel=$2 AND external_user_id=$3
          AND channel_connection_id IS NOT DISTINCT FROM $4::uuid`,
      [jobTenantId, channel, message.user_id, connectionId]
    );
    if (locked.rows[0]) {
      await client.query("COMMIT");
      return locked.rows[0];
    }
    const customer = await client.query<{ customer_id: string }>(
      `INSERT INTO customers (tenant_id, name, attributes)
       VALUES ($1, $2, jsonb_build_object('source_channel',$3::text)) RETURNING customer_id`,
      [jobTenantId, message.user_name ?? message.user_id, channel]
    );
    const chatwootIdentifier = connectionId ? `${connectionId}:${message.user_id}` : message.user_id;
    const contact = await createContact(chatwootIdentifier, message.user_name ?? message.user_id, channel);
    if (!contact.source_id) throw new Error("Chatwoot contact response did not include source_id");
    const conversation = await createConversation(contact.source_id, channel);
    const inserted = await client.query(
      `INSERT INTO channel_identities
        (tenant_id, customer_id, channel, channel_connection_id, external_user_id, chatwoot_contact_id, chatwoot_source_id, chatwoot_conversation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING customer_id, external_user_id, channel, channel_connection_id, chatwoot_source_id, chatwoot_conversation_id`,
      [jobTenantId, customer.rows[0].customer_id, channel, connectionId, message.user_id, contact.contact?.id ?? null, contact.source_id, conversation.id]
    );
    await client.query(
      `INSERT INTO audit_logs
        (tenant_id, actor_type, actor_id, action, resource_type, resource_id, after_data, request_id)
       VALUES ($1, 'channel_gateway', $2, 'customer.created', 'customer', $3,
               jsonb_build_object('name', $4::text, 'channel', $2::text), $5::uuid)`,
      [jobTenantId, channel, customer.rows[0].customer_id, message.user_name ?? message.user_id, randomUUID()]
    );
    await client.query("COMMIT");
    return inserted.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function handleMockInbound(rawBody: Buffer, headers: Record<string, string | string[] | undefined>) {
  const timestamp = String(headers["x-wechat-timestamp"] ?? "");
  const nonce = String(headers["x-wechat-nonce"] ?? "");
  const received = String(headers["x-wechat-signature"] ?? "");
  if (!verifySignature(signingSecret, timestamp, nonce, rawBody, received)) {
    return { status: 401, body: { error: "invalid_signature" } };
  }
  const message = JSON.parse(rawBody.toString("utf8")) as InboundMessage;
  return handleNormalizedInbound(tenantId, message, "mock-wechat", message);
}

async function handleNormalizedInbound(jobTenantId: string, message: InboundMessage, channel: string, storedPayload: unknown, connectionId: string | null = null) {
  if (!message.event_id || !message.message_id || !message.user_id || !message.text) {
    return { status: 400, body: { error: "invalid_payload" } };
  }
  if(message.media&&channel==='wechat_official_account'&&(!connectionId||!verifiedIngressClient))return {status:409,body:{error:'wechat_media_verified_connection_required'}};
  const queued = await enqueueInbound(jobTenantId, channel, message, storedPayload, connectionId);
  return { status: queued.duplicate ? 200 : 202, body: { ok: true, duplicate: queued.duplicate, event_status: queued.status } };
}

async function processInboundJob(job: InboundJob): Promise<void> {
  const message = job.payload?.normalized;
  if (!message?.event_id || !message.message_id || !message.user_id || !message.text) throw new Error("invalid_inbound_job");
  let created:{id:number|string},conversationId:string;
  if(job.channel==='wechat_official_account'&&verifiedIngressClient){
    // Never fall back to the global/public inbox on rejection or uncertain native acknowledgement.
    const projected=await projectVerifiedWeChatInbound(pool,job,verifiedIngressClient);created=projected;conversationId=projected.conversationId;
  }else{
   const identity = await getOrCreateIdentity(job.tenant_id, message, job.channel, job.channel_connection_id);
   conversationId=String(identity.chatwoot_conversation_id);
   created = await createIncomingMessage(
    identity.chatwoot_source_id,
    String(identity.chatwoot_conversation_id),
    message.text,
    message.message_id
  );
  }
  let queuedMedia:Awaited<ReturnType<typeof queueWechatMedia>>;
  if(message.media&&job.channel==='wechat_official_account'){
    if(!job.channel_connection_id)throw Error('wechat_media_scoped_connection_required');
    const connection=await resolveWeChatConnectionById(job.channel_connection_id,job.tenant_id);
    if(!connection)throw Error('wechat_media_connection_not_ready');
    const tenant=await pool.query('SELECT chatwoot_account_id::text account_id FROM tenants WHERE tenant_id=$1',[job.tenant_id]);
    queuedMedia=await queueWechatMedia(pool,{tenantId:job.tenant_id,accountId:tenant.rows[0].account_id,conversationId,messageId:String(created.id),appId:connection.config.appId,connectionId:job.channel_connection_id,media:message.media});
  }
  await completeInbound(job, created.id, { ...message, chatwoot_message_id: created.id },{
    insights:job.channel==='wechat_official_account'&&verifiedIngressClient?customerInsights?.sources.hooks.independent:undefined});
  try {
    if(queuedMedia)await recordInboundAttention({tenant_id:job.tenant_id,conversation_id:conversationId,message_id:queuedMedia.messageId,text:message.text,media:queuedMedia.notice,occurred_at:queuedMedia.occurredAt,notify:false});
    if(!message.media)await recordInboundAttention({
      tenant_id: job.tenant_id,
      conversation_id: conversationId,
      message_id: message.message_id,
      text: message.text,
    });
  } catch (notificationError) {
    console.error("Inbound attention notification failed", notificationError instanceof Error ? notificationError.message : "unknown");
  }
}

let inboundPollRunning = false;
async function pollInboundQueue(): Promise<void> {
  if (inboundPollRunning) return;
  inboundPollRunning = true;
  try {
    const jobs = await claimInboundBatch(Number(process.env.INBOUND_QUEUE_BATCH_SIZE ?? 10));
    await Promise.all(jobs.map(async job => {
      try {
        await processInboundJob(job);
      } catch (error) {
        const status = await failInbound(job, error);
        console.warn("Inbound job processing failed", { event_id: job.external_event_id, status });
      }
    }));
  } catch (error) {
    console.error("Inbound queue poll failed", error instanceof Error ? error.message : "unknown");
  } finally {
    inboundPollRunning = false;
  }
}

async function finalizeInsertedCopilotRecommendation(conversationId: string, chatwootMessageId: string, finalText: string, sender: any): Promise<void> {
  if (!finalText.trim()) return;
  const candidate = await pool.query<{ recommendation_id: string; recommendation_text: string; status: string }>(
    `SELECT recommendation_id,recommendation_text,status
       FROM ai_recommendations
      WHERE tenant_id=$1 AND conversation_id=$2 AND status='inserted'
        AND action_at>=NOW()-INTERVAL '30 minutes'
      ORDER BY action_at DESC LIMIT 1`,
    [tenantId, conversationId]
  );
  if (!candidate.rows[0]?.recommendation_text) return;
  const finalStatus = classifyDeliveredRecommendation(candidate.rows[0].recommendation_text, finalText);
  const updated = await pool.query<{ recommendation_id: string }>(
    `UPDATE ai_recommendations
        SET status=$1,human_agent_action=$1,human_agent_text=$2,
            sent_chatwoot_message_id=$3,sent_at=NOW()
      WHERE tenant_id=$4 AND recommendation_id=$5 AND status='inserted'
        AND sent_chatwoot_message_id IS NULL
      RETURNING recommendation_id`,
    [finalStatus, finalText.trim(), chatwootMessageId, tenantId, candidate.rows[0].recommendation_id]
  );
  if (!updated.rows[0]) return;
  const actorId = String(sender?.id ?? sender?.email ?? "unknown-chatwoot-agent").slice(0, 200);
  await pool.query(
    `INSERT INTO audit_logs
      (tenant_id,actor_type,actor_id,action,resource_type,resource_id,before_data,after_data,request_id)
     VALUES($1,'chatwoot_agent',$2,'ai.recommendation.sent','ai_recommendation',$3,
            jsonb_build_object('status','inserted'),
            jsonb_build_object('status',$4::text,'edited',$5::boolean,'chatwoot_message_id',$6::text,'final_character_count',$7::int),$8::uuid)`,
    [tenantId, actorId, candidate.rows[0].recommendation_id, finalStatus, finalStatus === "edited", chatwootMessageId, finalText.trim().length, randomUUID()]
  );
}

async function handleChatwootWebhook(payload: any) {
  // Shared-account manual replies must never fall through to the legacy sender.
  if(payload.content_attributes?.replynest_transport==="wechat_media_manual"||payload.content_attributes?.replynest_transport==="shared_wechat" || payload.conversation?.custom_attributes?.source_channel==="shared_wechat") {
    return {ignored:true,reason:"shared_wechat_dedicated_delivery"};
  }
  const type = payload.message_type;
  if (payload.event !== "message_created" || (type !== "outgoing" && type !== 1) || payload.private === true) {
    return { ignored: true };
  }
  const messageId = String(payload.id ?? "");
  const conversationId = String(payload.conversation?.id ?? payload.conversation?.display_id ?? "");
  if (!messageId || !conversationId) return { ignored: true, reason: "missing_identifiers" };
  const identity = await findIdentityByConversation(tenantId, conversationId);
  if (!identity) return { ignored: true, reason: "unknown_conversation" };
  // Website replies are delivered by the native web widget transport, not the mock/WeChat adapter.
  if (identity.channel === "web_chat") return { ignored: true, reason: "native_web_chat_delivery" };
  const officialConnection = identity.channel === "wechat_official_account" && identity.channel_connection_id
    ? await resolveWeChatConnectionById(identity.channel_connection_id,tenantId) : undefined;
  if(identity.channel === "wechat_official_account" && await sharedAccountOwnsInbound(officialConnection?.config.appId ?? officialConfigFromEnv().appId)) {
    return {ignored:true,reason:"official_account_switched_to_shared"};
  }

  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM outbound_deliveries WHERE chatwoot_message_id=$1`,
    [messageId]
  );
  const claimed = existing.rows[0]
    ? await pool.query<{ id: string; attempt_count: number }>(
        `UPDATE outbound_deliveries SET
           tenant_id=$1, chatwoot_conversation_id=$3, external_user_id=$4, payload=$5,
           status='processing', error=NULL, failure_code=NULL, retryable=FALSE, next_retry_at=NULL,
           attempt_count=attempt_count+1, last_attempt_at=NOW(), updated_at=NOW()
         WHERE chatwoot_message_id=$2
           AND (status='retry_pending' OR (status='failed' AND retryable=TRUE
                AND (next_retry_at IS NULL OR next_retry_at<=NOW())))
         RETURNING id,attempt_count`,
        [tenantId, messageId, conversationId, identity.external_user_id, payload]
      )
    : await pool.query<{ id: string; attempt_count: number }>(
        `INSERT INTO outbound_deliveries
           (tenant_id,chatwoot_message_id,chatwoot_conversation_id,external_user_id,payload,status,attempt_count,last_attempt_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,'processing',1,NOW(),NOW())
         ON CONFLICT (chatwoot_message_id) DO NOTHING
         RETURNING id,attempt_count`,
        [tenantId, messageId, conversationId, identity.external_user_id, payload]
      );
  if (!claimed.rows[0]) return { suppressed: true };

  try {
    if (identity.channel === "wechat_official_account") {
      const connection = officialConnection;
      if (identity.channel_connection_id && !connection) throw new Error("wechat_connection_not_ready");
      await sendOfficialText(identity.external_user_id, String(payload.content ?? ""), connection?.config);
    } else {
      await postJson(`${mockBaseUrl}/messages`, {
        message_id: `cw-${messageId}`,
        chatwoot_message_id: messageId,
        user_id: identity.external_user_id,
        text: String(payload.content ?? "")
      });
    }
    await pool.query(
      `UPDATE outbound_deliveries SET status='delivered', delivered_at=NOW(), error=NULL,
         failure_code=NULL, retryable=FALSE, next_retry_at=NULL, updated_at=NOW()
       WHERE chatwoot_message_id=$1`,
      [messageId]
    );
    try {
      await finalizeInsertedCopilotRecommendation(conversationId, messageId, String(payload.content ?? ""), payload.sender);
    } catch (auditError) {
      console.error("Copilot composer delivery audit failed", auditError instanceof Error ? auditError.message : "unknown");
    }
    await markConversationResponded(tenantId, conversationId);
    return { delivered: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const failure = classifyOutboundFailure(error);
    const attemptCount = Number(claimed.rows[0].attempt_count);
    const retryable = failure.retryable && attemptCount < 5;
    const retryAfter = retryable ? retryDelaySeconds(failure.retryAfterSeconds ?? 30, attemptCount) : null;
    await pool.query(
      `UPDATE outbound_deliveries SET status='failed', error=$1, failure_code=$2, retryable=$3,
         next_retry_at=CASE WHEN $3 THEN NOW()+make_interval(secs=>$4) ELSE NULL END, updated_at=NOW()
       WHERE chatwoot_message_id=$5`,
      [detail.slice(0, 1000), failure.code, retryable, retryAfter ?? 0, messageId]
    );
    if (!retryable) {
      try {
        await emitNotification({
          tenant_id: tenantId,
          event_type: "channel.outbound.permanent_failure",
          severity: "critical",
          title: "客户消息发送失败",
          summary: failureNote(messageId, failure, false),
          dedupe_key: `outbound-failure:${messageId}`,
          resource_type: "outbound_delivery",
          resource_id: String(claimed.rows[0].id),
          metadata: { chatwoot_conversation_id: Number(conversationId), failure_code: failure.code },
        });
        await pool.query(
          `UPDATE outbound_deliveries SET failure_notified_at=COALESCE(failure_notified_at,NOW()), updated_at=NOW()
           WHERE chatwoot_message_id=$1`,
          [messageId]
        );
      } catch (notificationError) {
        console.error("Chatwoot delivery failure note failed", notificationError);
      }
    }
    return { delivered: false, failure_code: failure.code, retryable, retry_after_seconds: retryAfter };
  }
}

let pollRunning = false;
const missingChatwootConversations = new Set<string>();
let chatwootPollRateLimited = false;
async function pollChatwootReplies(): Promise<void> {
  if (pollRunning) return;
  pollRunning = true;
  try {
    const identities = await pool.query<{
      chatwoot_conversation_id: string;
    }>(`SELECT chatwoot_conversation_id FROM channel_identities
         WHERE tenant_id=$1 AND sync_status='synced' AND channel<>'web_chat'
         ORDER BY updated_at DESC LIMIT 20`, [tenantId]);
    for (const identity of identities.rows) {
      const response = await fetch(
        `${chatwootBaseUrl}/api/v1/accounts/${chatwootAccountId}/conversations/${identity.chatwoot_conversation_id}/messages`,
        {
          headers: { api_access_token: chatwootAccessToken, "x-forwarded-proto": "https" },
          signal: AbortSignal.timeout(10_000)
        }
      );
      if (response.status === 404) {
        if (!missingChatwootConversations.has(identity.chatwoot_conversation_id)) {
          console.warn(`Chatwoot reply poll skipped missing conversation ${identity.chatwoot_conversation_id}`);
          missingChatwootConversations.add(identity.chatwoot_conversation_id);
        }
        await pool.query(
          `UPDATE channel_identities SET sync_status='failed',updated_at=NOW()
            WHERE tenant_id=$1 AND chatwoot_conversation_id=$2 AND sync_status='synced'`,
          [tenantId, identity.chatwoot_conversation_id]
        );
        continue;
      }
      if (response.status === 429) {
        if (!chatwootPollRateLimited) console.warn("Chatwoot reply fallback poll rate limited; pausing until next interval");
        chatwootPollRateLimited = true;
        break;
      }
      if (!response.ok) throw new Error(`Chatwoot message poll returned ${response.status}`);
      chatwootPollRateLimited = false;
      missingChatwootConversations.delete(identity.chatwoot_conversation_id);
      const result = await response.json() as any;
      const messages = Array.isArray(result) ? result : (result.payload ?? []);
      for (const message of messages) {
        if (message.message_type === "outgoing" || message.message_type === 1) {
          await handleChatwootWebhook({
            ...message,
            event: "message_created",
            conversation: { id: identity.chatwoot_conversation_id }
          });
        }
      }
    }
  } catch (error) {
    console.error("Chatwoot reply poll failed", error);
  } finally {
    pollRunning = false;
  }
}

// Reject an enabled but unconfigured executor before migrations or bootstrap.
validateAssignmentStartup();
const automaticConfig=validateAutomaticReceptionStartup(process.env,secretValue,()=>{qwenRuntimeConfig();});
const historyConfig=validateReceptionHistoryStartup(process.env,secretValue,()=>{qwenRuntimeConfig();});
const draftPresentationConfig=validateReceptionDraftPresentationStartup(process.env);
const insightsConfig=validateCustomerInsightsStartup(process.env,secretValue,()=>{qwenRuntimeConfig();});
const lifetime=createGatewayLifecycle();
await bootstrapDatabaseRuntime(pool,databaseComponents(process.env),process.env,seedBusinessLayer);
// Fixed six-calendar-month expiry, bounded 500-row owner function; no runtime DELETE grant.
lifetime.every(cleanExpiredSecurityLogs,10*60_000,()=>console.warn('tenant_security_retention_unavailable'));
const historyOn=()=>!lifetime.stopping&&historyConfig.read;
const historyReader=historyConfig.read?createAuthorizedReceptionHistoryReader(pool,createReceptionHistoryNativeClient({
 origin:historyConfig.origin,secret:historyConfig.secret,enabled:historyOn}),{enabled:historyOn}):undefined;
const historyService=historyConfig.knowledge?createLiveHistoryKnowledgeService(historyReader!,{enabled:()=>historyOn()&&historyConfig.knowledge}):undefined;
const styleWorker=historyConfig.style?createReceptionStyleLearningWorker(pool,historyReader!,{enabled:()=>historyOn()&&historyConfig.style}):undefined;
const draftPreparation=draftPresentationConfig.draft?createReceptionDraftPreparation(pool,historyReader,{
 enabled:()=>!lifetime.stopping&&draftPresentationConfig.draft,
 contextEnabled:()=>historyOn()&&draftPresentationConfig.context,styleEnabled:()=>historyOn()&&historyConfig.style}):undefined;
const automaticPresentationOn=()=>!lifetime.stopping&&draftPresentationConfig.automatic;
const automaticPresentationOptions={enabled:automaticPresentationOn,contextEnabled:()=>historyOn()&&draftPresentationConfig.context,styleEnabled:()=>historyOn()&&historyConfig.style};
const automaticPreparation=draftPresentationConfig.automatic?createAutomaticPresentationPreparation(pool,historyReader,automaticPresentationOptions):undefined;
const insightsOn=()=>!lifetime.stopping&&insightsConfig.enabled;
const customerInsights=insightsConfig.enabled?createLiveCustomerInsightsRuntime(pool,{origin:insightsConfig.origin,secret:insightsConfig.secret,token:insightsConfig.token,
 enabled:insightsOn,sharedEnabled:()=>insightsConfig.shared,report:(state,count)=>console.info(JSON.stringify({event:'customer_insights_batch',state,count}))}):undefined;
if(customerInsights)lifetime.register(customerInsights.stop);
const automatic=createAutomaticGatewayRuntime(pool,automaticConfig,{
 ...(customerInsights?{insights:{enabled:insightsOn,bridgeSecret:insightsConfig.bridgeSecret,admit:customerInsights.intake.admit}}:{}),
 workflow:async event=>{if(!lifetime.stopping)await enqueueStudioMessageEvent(pool,event);},
 generate:createLiveAutomaticGenerator({enabled:()=>!lifetime.stopping&&(automaticConfig.web||automaticConfig.wechat),
  ...(automaticPreparation?{presentation:{enabled:automaticPresentationOn,preparation:automaticPreparation}}:{})}),draft:acceptReceptionCallback,
 ...(automaticConfig.timing&&automaticPreparation?{timing:{presentationOptions:automaticPresentationOptions,
  currentPresentation:(l:import('./automatic-reception-store.js').AutomaticReceptionLease,q:string)=>automaticPreparation.currentStored(l,q)}}:{}),
 report:(state,count)=>console.info(JSON.stringify({event:'automatic_reception_batch',state,count}))
});
lifetime.register(automatic.stop);
const historyRuntime=createReceptionHistoryQueueRuntime({knowledge:historyService,style:styleWorker,enabled:historyOn,
 report:(worker,state,count)=>console.info(JSON.stringify({event:'reception_history_batch',worker,state,count}))});
lifetime.register(historyRuntime.stop);
const personalization=createReceptionPersonalizationApi(pool,{enabled:()=>!lifetime.stopping&&process.env.AI_RECEPTION_PERSONALIZATION_MANAGEMENT_ENABLED==='true',
 presentationStatus:()=>receptionPresentationAvailability({management:process.env.AI_RECEPTION_PERSONALIZATION_MANAGEMENT_ENABLED==='true',
  stopping:lifetime.stopping,draftWorker:automaticConfig.draftCallback&&process.env.AI_RECEPTION_DRAFT_WORKER_ENABLED==='true',
  draftPreparation:!!draftPreparation,automaticExecution:automaticConfig.web||automaticConfig.wechat,
  automaticPreparation:!!automaticPreparation,timing:!!automaticConfig.timing}),
 historyEnabled:()=>!lifetime.stopping&&process.env.AI_HISTORY_KNOWLEDGE_DRAFTS_ENABLED==='true',
 historyReadEnabled:()=>historyOn()&&(historyConfig.knowledge||historyConfig.style||draftPresentationConfig.context),
 generationEnabled:()=>historyOn()&&historyConfig.knowledge,historyService});
async function sharedAccountOwnsInbound(appId:string):Promise<boolean> {
  return isSharedWechatAccountActive(pool,appId,process.env.SHARED_WECHAT_APP_ID,process.env.SHARED_WECHAT_CALLBACK_ENABLED==="true");
}
// Shared schemas were migrated explicitly, or checked read-only above.
void lifetime.run(()=>bootstrapDemoMembershipWithRetry(10,()=>lifetime.stopping)).catch(()=>console.warn('Demo bootstrap unavailable'));
const server = createServer((request, response) => {
  if(lifetime.stopping){response.setHeader('Retry-After','5');return sendJson(response,503,{error:'gateway_stopping'});}
  void lifetime.run(async()=>{
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if(await automatic.management(request,response,url))return;
    if(await personalization(request,response,url))return;
    if(await automatic.callback(request,response,url))return;
    if(await handleAlipayNotify(request,response,url,{enabled:process.env.PAYMENT_PROVIDER==='alipay' && process.env.ALIPAY_NOTIFY_ENABLED==='true',config:alipayConfigFromEnv,record:recordAlipaySettlement}))return;
    const sharedEnabled=process.env.SHARED_WECHAT_CALLBACK_ENABLED === "true";
    const sharedHandshake=process.env.SHARED_WECHAT_HANDSHAKE_ENABLED === "true";
    if(sharedEnabled && process.env.SHARED_WECHAT_MANAGEMENT_ENABLED==="true" && url.pathname.startsWith("/public/shared-wechat-portal")) {
      if(await handleSharedWechatPortal(request,response,url,pool,await sharedWechatConfig()))return;
    }
    if (url.pathname === "/webhooks/shared-wechat" && await handleSharedWechatCallback(request, response, url, {
      enabled: sharedEnabled || sharedHandshake,
      handshakeOnly: !sharedEnabled,
      config: sharedEnabled || sharedHandshake ? await sharedWechatConfig() : {appId:"",appSecret:"",token:"",receiverId:""},
      record: event => recordSharedWechatEvent(pool, event),
      welcome: tenantId=>sharedMerchantWelcome(pool,tenantId),
      clearProfile: openId=>clearSharedWechatProfile(pool,process.env.SHARED_WECHAT_APP_ID??'',openId)
    })) return;
    if (await handleBusinessApi(request, response, url,{sender:automatic.sender})) return;
    if(handleAutomationHealth(request,response,url,automationRuntimeMonitor,process.env.STATUS_MONITOR_CONTROL_TOKEN))return;
    if(request.method==='GET'&&['/health/ai/text','/health/ai/embedding'].includes(url.pathname)){
      const health=aiModelHealth(url.pathname.split('/').at(-1)!);return sendJson(response,health?.status==='operational'?200:503,health);
    }
    if (request.method === "GET" && url.pathname === "/health") {
      await pool.query("SELECT 1");
      return sendJson(response, 200, { status: "ok", service: "channel-gateway" });
    }
    if (request.method === "GET" && url.pathname === "/health/wechat") {
      const configured = officialConfigured();
      const liveSendEnabled = process.env.WECHAT_LIVE_ENABLED === "true";
      const requireLive = url.searchParams.get("require_live") === "1";
      const ready = configured && (!requireLive || liveSendEnabled);
      return sendJson(response, ready ? 200 : 503, {
        status: !configured ? "not_configured" : liveSendEnabled ? "operational" : "configured",
        live_send_enabled: liveSendEnabled
      });
    }
    if (request.method === "GET" && url.pathname === "/health/inbound") {
      const queue = await pool.query<{ pending: string; dead: string; oldest_seconds: string | null }>(
        `SELECT COUNT(*) FILTER (WHERE status IN ('queued','retry_pending','processing'))::text AS pending,
                COUNT(*) FILTER (WHERE status='dead')::text AS dead,
                EXTRACT(EPOCH FROM (NOW()-MIN(created_at) FILTER (WHERE status IN ('queued','retry_pending','processing'))))::text AS oldest_seconds
           FROM gateway_events`
      );
      const pending = Number(queue.rows[0].pending);
      const dead = Number(queue.rows[0].dead);
      const oldestSeconds = Number(queue.rows[0].oldest_seconds ?? 0);
      const stalled = pending > 100 || oldestSeconds > 60;
      return sendJson(response, stalled ? 503 : 200, {
        status: stalled ? "unavailable" : dead > 0 ? "degraded" : "operational",
        pending,
        dead,
        oldest_seconds: Math.round(oldestSeconds),
      });
    }
    if (request.method === "GET" && url.pathname === "/health/payments") {
      const health = await paymentProjectionHealth();
      return sendJson(response, health.status === "unavailable" ? 503 : 200, health);
    }
    if (request.method === "GET" && url.pathname === "/health/payment-queries") {
      const health = await paymentQueryHealth();
      return sendJson(response, health.status === "degraded" ? 503 : 200, health);
    }
    if (request.method === "GET" && url.pathname === "/health/campaigns") {
      const health = await campaignDeliveryHealth();
      return sendJson(response, health.status === "degraded" ? 503 : 200, health);
    }
    if (request.method === "GET" && url.pathname === "/health/registration-sms") {
      const health = await registrationSmsHealth();
      return sendJson(response, health.status === "degraded" ? 503 : 200, health);
    }
    if (request.method === "GET" && url.pathname === "/health/privacy-lifecycle") {
      const preview=await registrationRetentionPreview();
      return sendJson(response,200,{status:preview.policy.effective_execution?"operational":"execution_disabled",policy_approved:preview.policy.policy_approved,execution_enabled:preview.policy.execution_enabled,pending_anonymization:preview.total});
    }
    if (request.method === "GET" && url.pathname.startsWith("/events/")) {
      const eventId = decodeURIComponent(url.pathname.slice(8));
      const result = await pool.query(
        `SELECT external_event_id,external_message_id,status,chatwoot_message_id,failure_code,
                attempt_count,max_attempts,next_attempt_at,processed_at
           FROM gateway_events WHERE tenant_id=$1 AND external_event_id=$2`,
        [tenantId, eventId]
      );
      return sendJson(response, result.rowCount ? 200 : 404, result.rows[0] ?? { error: "not_found" });
    }
    if (request.method === "POST" && url.pathname === "/webhooks/wechat") {
      const result = await handleMockInbound(await readBody(request), request.headers);
      return sendJson(response, result.status, result.body);
    }
    if (request.method === "GET" && url.pathname === "/webhooks/wechat-official") {
      if(await sharedAccountOwnsInbound(officialConfigFromEnv().appId))return sendJson(response,409,{error:"official_account_switched_to_shared"});
      const echo = verifyOfficialCallback(url.searchParams, officialConfigFromEnv());
      response.writeHead(echo === undefined ? 403 : 200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      return response.end(echo ?? "invalid signature");
    }
    if (request.method === "POST" && url.pathname === "/webhooks/wechat-official") {
      if(await sharedAccountOwnsInbound(officialConfigFromEnv().appId))return sendJson(response,409,{error:"official_account_switched_to_shared"});
      const inbound = parseOfficialInbound(await readBody(request), url.searchParams, officialConfigFromEnv());
      await handleNormalizedInbound(tenantId, inbound, "wechat_official_account", inbound.raw);
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      return response.end("success");
    }
    const scopedCallback = url.pathname.match(/^\/webhooks\/wechat-official\/([A-Za-z0-9_-]{12,64})$/)?.[1];
    if (scopedCallback && (request.method === "GET" || request.method === "POST")) {
      const connection = await resolveWeChatConnection(scopedCallback);
      if (!connection) return sendJson(response, 404, { error: "wechat_connection_not_found" });
      if(await sharedAccountOwnsInbound(connection.config.appId))return sendJson(response,409,{error:"official_account_switched_to_shared"});
      if (request.method === "GET") {
        const echo = verifyOfficialCallback(url.searchParams, connection.config);
        if (echo !== undefined) {
          await pool.query(
            `UPDATE channel_connections SET last_checked_at=NOW(),last_error_code=NULL,updated_at=NOW()
             WHERE connection_id=$1`,
            [connection.connectionId]
          );
        }
        response.writeHead(echo === undefined ? 403 : 200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        return response.end(echo ?? "invalid signature");
      }
      const inbound = parseOfficialInbound(await readBody(request), url.searchParams, connection.config);
      await handleNormalizedInbound(connection.tenantId, inbound, "wechat_official_account", inbound.raw, connection.connectionId);
      await pool.query(
        `UPDATE channel_connections SET last_checked_at=NOW(),last_error_code=NULL,
           configuration=configuration || '{"callback_verified":true,"inbound_verified":true}'::jsonb,updated_at=NOW()
         WHERE connection_id=$1`,
        [connection.connectionId]
      );
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      return response.end("success");
    }
    if (request.method === "POST" && url.pathname === "/webhooks/chatwoot") {
      // Legacy single-tenant adapter is opt-in; never enable unsigned direct callbacks.
      const key=secretValue('CHATWOOT_CALLBACK_SECRET');
      if(process.env.CHATWOOT_LEGACY_CALLBACK_ENABLED!=='true'||!key||Buffer.byteLength(key)<32)
        return sendJson(response,404,{error:'not_found'});
      const body=await readBody(request);
      if(!authenticateChatwootCallback(key,request.headers['x-replynest-chatwoot-timestamp'],request.headers['x-replynest-chatwoot-signature'],body))
        return sendJson(response,401,{error:'invalid_callback_authentication'});
      let payload:any;
      try{payload=JSON.parse(body.toString('utf8'));}catch{return sendJson(response,400,{error:'invalid_json'});}
      if(payload?.event!=='message_created')return sendJson(response,200,{ignored:true});
      const conversationId=String(payload?.conversation?.id??'');
      if(String(payload?.account?.id)!==chatwootAccountId||!/^[1-9]\d{0,18}$/.test(conversationId))
        return sendJson(response,403,{error:'callback_account_mismatch'});
      const binding=await pool.query('SELECT 1 FROM tenants WHERE tenant_id=$1 AND chatwoot_account_id::text=$2 AND status IN (\'active\',\'test\')',[tenantId,chatwootAccountId]);
      if(!binding.rowCount)return sendJson(response,403,{error:'callback_tenant_mismatch'});
      const conversation=await getChatwootConversation(chatwootAccountId,conversationId);
      const messages=await listChatwootMessages(chatwootAccountId,conversationId);
      let canonical:any;
      try{canonical=canonicalChatwootCallback(payload,chatwootAccountId,conversation,messages);}
      catch{return sendJson(response,403,{error:'callback_message_unverified'});}
      return sendJson(response, 200, { ok: true, ...(await handleChatwootWebhook(canonical)) });
    }
    return sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    if(error instanceof DatabaseBusyError){response.setHeader('Retry-After','2');return sendJson(response,503,{error:'database_busy'});}
    console.error(error);
    return sendJson(response, 500, { error: "internal_error" });
  }
  }).catch(()=>{if(!response.writableEnded&&!response.destroyed)sendJson(response,503,{error:'gateway_stopping'});});
});
server.listen(port, "0.0.0.0", () => console.log(`channel-gateway listening on ${port}`));
let assignmentRunning=false;
lifetime.every(async()=>{if(assignmentRunning)return;assignmentRunning=true;try{await processAssignmentCommands();}catch{console.warn('Assignment executor unavailable');}finally{assignmentRunning=false;}},15_000);
lifetime.register(startBoundedPoll(()=>lifetime.run(enqueueAutomationPlans),()=>{runtimeCounters.scheduler_errors++;console.warn('Automation scheduler unavailable');}));
lifetime.register(startBoundedPoll(()=>lifetime.run(processAutomationPlanQueue),()=>{runtimeCounters.planner_errors++;console.warn('Automation planner unavailable');}));
lifetime.register(startAutomationRuntimeMonitor());
lifetime.register(startAiModelMonitor());
lifetime.every(pollChatwootReplies, 60_000);
void lifetime.run(pollChatwootReplies).catch(()=>{});
lifetime.every(pollInboundQueue, Number(process.env.INBOUND_QUEUE_POLL_MS ?? 250));
void lifetime.run(pollInboundQueue).catch(()=>{});
lifetime.register(startReceptionPoller({event:processReceptionEvent,draft:()=>processReceptionDraft({preparation:draftPreparation}),
  discover:discoverReceptionMessages,metrics:receptionEventBacklog}));
automatic.start();
customerInsights?.start();
historyRuntime.start();
// Independent of AI and outbound sending: this only projects verified inbound receipts.
let sharedInboundRunning=false;
async function pollSharedInbound():Promise<void> {
  if(sharedInboundRunning || process.env.SHARED_WECHAT_DELIVERY_ENABLED!=="true" || process.env.SHARED_WECHAT_INBOUND_WORKER_ENABLED!=="true")return;
  sharedInboundRunning=true;
  try {
    const transport=createSharedWechatTransport({chatwootBaseUrl:requiredEnv("CHATWOOT_BASE_URL"),chatwootToken:requiredEnv("CHATWOOT_API_ACCESS_TOKEN"),liveSendEnabled:false,
      resolveWeChat:async()=>{throw new Error("inbound_worker_cannot_send");}});
    const outcome=await processSharedWechatInboundBatch(pool,transport,{enabled:true,batchSize:10,insights:customerInsights?.sources.hooks.shared});
    if(outcome.uncertain || outcome.errors)console.warn("Shared WeChat inbound requires review",outcome);
  } catch {console.warn("Shared WeChat inbound worker unavailable");}
  finally {sharedInboundRunning=false;}
}
lifetime.every(pollSharedInbound,3000);
void lifetime.run(pollSharedInbound).catch(()=>{});
let mediaRunning=false;
async function pollWechatMedia(){
  if(mediaRunning||process.env.WECHAT_MEDIA_ENABLED!=='true')return;mediaRunning=true;
  try{
    await publishWechatMediaNotifications(pool);
    await processWechatMedia(pool,async row=>{
      const tenant=await pool.query("SELECT 1 FROM tenants WHERE tenant_id=$1 AND chatwoot_account_id::text=$2 AND status IN('active','test')",[row.tenant_id,row.account_id]);
      if(!tenant.rowCount)throw Error('wechat_media_tenant_disabled');
      if(row.connection_id){
        const connection=await resolveWeChatConnectionById(row.connection_id,row.tenant_id);
        if(!connection||connection.config.appId!==row.app_id||await sharedAccountOwnsInbound(row.app_id))throw Error('wechat_media_connection_changed');
        return connection.config;
      }
      const grant=await pool.query(`SELECT 1 FROM shared_wechat_threads b JOIN shared_wechat_accounts a ON a.app_id=b.app_id AND a.enabled
        JOIN shared_wechat_enrollments e ON e.app_id=b.app_id AND e.tenant_id=b.tenant_id AND e.enabled
        JOIN shared_wechat_inboxes i ON i.app_id=b.app_id AND i.tenant_id=b.tenant_id AND i.account_id=b.account_id AND i.inbox_id=b.inbox_id AND i.enabled
        WHERE b.app_id=$1 AND b.tenant_id=$2 AND b.account_id::text=$3 AND b.conversation_id::text=$4`,[row.app_id,row.tenant_id,row.account_id,row.conversation_id]);
      if(!grant.rowCount)throw Error('wechat_media_shared_disabled');return sharedWechatConfig();
    });
    await publishWechatMediaNotifications(pool);await expireWechatMedia(pool);
  }catch{console.warn('WeChat media worker unavailable');}finally{mediaRunning=false;}
}
lifetime.every(pollWechatMedia,3000);
let notificationPollRunning = false;
async function pollNotifications(): Promise<void> {
  if (notificationPollRunning) return;
  notificationPollRunning = true;
  try {
    await processPendingNotifications();
    await processUnattendedConversations();
  }
  catch (error) { console.error("Notification Gateway poll failed", error); }
  finally { notificationPollRunning = false; }
}
lifetime.every(pollNotifications, 30_000);
lifetime.every(processExternalWebhooks,15_000,()=>console.warn('External webhook worker unavailable'));
void lifetime.run(pollNotifications).catch(()=>{});
let quotaPollRunning=false;
async function pollQuotaWarnings(){if(quotaPollRunning)return;quotaPollRunning=true;try{const result=await scanQuotaWarnings();if(result.scanned||result.created||result.emitted)console.info(`Quota scan scanned=${result.scanned} failed=${result.failed} completed=${result.completed} created=${result.created} emitted=${result.emitted}`)}catch{console.error("Quota warning scan failed")}finally{quotaPollRunning=false}}
lifetime.every(pollQuotaWarnings,15_000);
void lifetime.run(pollQuotaWarnings).catch(()=>{});
let trialExpiryPollRunning = false;
async function pollTrialExpiry(): Promise<void> {
  if (trialExpiryPollRunning) return;
  trialExpiryPollRunning = true;
  try {
    const expired = await expireDueTrials();
    if (expired > 0) console.info(`Trial expiry processed ${expired} entitlement(s)`);
    const qualified = await qualifyMaturedReferrals();
    if (qualified > 0) console.info(`Referral observation processed ${qualified} referral(s)`);
    const rewards = await reconcileReferralRewards();
    if (rewards > 0) console.info(`Referral reward reconciliation processed ${rewards} grant(s)`);
  } catch (error) { console.error("Trial expiry poll failed", error); }
  finally { trialExpiryPollRunning = false; }
}
lifetime.every(pollTrialExpiry, 60_000);
void lifetime.run(pollTrialExpiry).catch(()=>{});
let paymentLedgerPollRunning = false;
async function pollPaymentLedger(): Promise<void> {
  if (paymentLedgerPollRunning) return;
  paymentLedgerPollRunning = true;
  try {
    const result = await processPaymentLedgerOutbox();
    await processPlanPurchases();
    await processPaymentRefunds();
    await processPlanCommissions();
    if (result.claimed > 0) console.info(`Payment ledger projection processed ${result.succeeded}/${result.claimed} item(s)`);
  } catch (error) { console.error("Payment ledger projection poll failed", error); }
  finally { paymentLedgerPollRunning = false; }
}
lifetime.every(pollPaymentLedger, 5_000);
void lifetime.run(pollPaymentLedger).catch(()=>{});
let reconciliationRunning=false;
async function pollPaymentReconciliation(){if(reconciliationRunning)return;reconciliationRunning=true;try{await runPaymentReconciliation()}catch(error){console.error("Payment reconciliation failed",error)}finally{reconciliationRunning=false}}
lifetime.every(pollPaymentReconciliation,6*60*60*1000);

let campaignPollRunning = false;
async function pollMessageCampaigns() {
  if (campaignPollRunning) return;
  campaignPollRunning = true;
  try {
    const result = await processMessageCampaignDeliveries(new Date(), Number(process.env.MESSAGE_CAMPAIGN_BATCH_SIZE ?? 20));
    if (result.claimed || result.started) console.log("message_campaign_batch", result);
  } catch (error) {
    console.error("message_campaign_batch_failed", error instanceof Error ? error.message : "unknown");
  } finally { campaignPollRunning = false; }
}
lifetime.every(pollMessageCampaigns, Number(process.env.MESSAGE_CAMPAIGN_POLL_MS ?? 1000));
const massPollers=createMassPollers({
 send:async()=>{await processDueMassBatch(pool,officialMassAdapter(pool));await processMassProgress(pool);},
 receipt:async()=>{await processMassReceipt(pool,lease=>queryStoredOfficialMass(pool,lease));await processMassProgress(pool);}
});
lifetime.every(massPollers.send,5000,()=>console.error('mass_campaign_tick_failed'));
lifetime.every(massPollers.receipt,30000,()=>console.error('mass_campaign_receipt_tick_failed'));
let campaignHealthPollRunning = false;
async function pollCampaignHealth() {
  if (campaignHealthPollRunning) return;
  campaignHealthPollRunning = true;
  try { await scanCampaignDeliveryHealth(); }
  catch (error) { console.error("message_campaign_health_scan_failed", error instanceof Error ? error.message : "unknown"); }
  finally { campaignHealthPollRunning = false; }
}
lifetime.every(pollCampaignHealth, monitorInteger(process.env.MESSAGE_CAMPAIGN_MONITOR_POLL_MS,60_000,5000,3_600_000));
void lifetime.run(pollCampaignHealth).catch(()=>{});
void lifetime.run(pollPaymentReconciliation).catch(()=>{});
let paymentQueryRunning=false;
async function pollPaymentQueries(){
  if(paymentQueryRunning||process.env.PAYMENT_ORDER_QUERY_ENABLED!=="true")return;
  paymentQueryRunning=true;
  try{
    const scheduled=await schedulePaymentQueries();
    const adapters=process.env.PAYMENT_PROVIDER==='alipay'?{alipay:createAlipayOperations()}:{};
    const result=await processPaymentQueries(adapters,Number(process.env.PAYMENT_ORDER_QUERY_BATCH_SIZE??10));
    if(scheduled||result.claimed)console.info(`Payment order queries scheduled=${scheduled} processed=${result.succeeded}/${result.claimed} failed=${result.failed}`);
  }catch(error){console.error("Payment order query poll failed",error instanceof Error?error.message:"unknown")}
  finally{paymentQueryRunning=false}
}
lifetime.every(pollPaymentQueries,Number(process.env.PAYMENT_ORDER_QUERY_POLL_MS??30_000));
void lifetime.run(pollPaymentQueries).catch(()=>{});
let privacyLifecycleRunning=false;
async function pollPrivacyLifecycle(){if(privacyLifecycleRunning||!retentionPolicy().effective_execution)return;privacyLifecycleRunning=true;try{const result=await runRegistrationRetention();if(result.processed)console.info(`Registration privacy lifecycle anonymized ${result.processed} record(s)`)}catch(error){console.error("Registration privacy lifecycle failed",error instanceof Error?error.message:"unknown")}finally{privacyLifecycleRunning=false}}
lifetime.every(pollPrivacyLifecycle,Number(process.env.REGISTRATION_RETENTION_POLL_MS??86_400_000));
void lifetime.run(pollPrivacyLifecycle).catch(()=>{});
let fileTransferCleanupRunning = false;
async function pollFileTransferCleanup() {
  if (fileTransferCleanupRunning) return;
  fileTransferCleanupRunning = true;
  try {
    const cleaned = await cleanupExpiredFileTransfers();
    if (cleaned) console.info(`Expired file transfer cleanup removed ${cleaned} record(s)`);
  } catch (error) { console.error("Expired file transfer cleanup failed", error instanceof Error ? error.message : "unknown"); }
  finally { fileTransferCleanupRunning = false; }
}
lifetime.every(pollFileTransferCleanup, 60 * 60 * 1000);
void lifetime.run(pollFileTransferCleanup).catch(()=>{});
let subscriptionMailRunning=false;
async function pollSubscriptionMail(){if(subscriptionMailRunning)return;subscriptionMailRunning=true;try{await processSubscriptionMail();}catch{console.error('subscription_mail_worker_failed');}finally{subscriptionMailRunning=false;}}
lifetime.every(pollSubscriptionMail,60_000);
let aiLowMailRunning=false;
async function pollAiLowMail(){if(aiLowMailRunning)return;aiLowMailRunning=true;try{await processAiLowMail();}catch{console.error('ai_low_mail_worker_failed');}finally{aiLowMailRunning=false;}}
lifetime.every(pollAiLowMail,60_000);
let aiSummaryRunning=false;
async function pollAiSummary(){if(aiSummaryRunning)return;aiSummaryRunning=true;try{await refreshAiUsageSummary();}catch{console.error('ai_usage_summary_failed');}finally{aiSummaryRunning=false;}}
lifetime.every(pollAiSummary,90_000);
void lifetime.run(pollAiSummary).catch(()=>{});
void lifetime.run(pollSubscriptionMail).catch(()=>{});
let gatewayShutdown:Promise<void>|undefined;
function shutdownGateway(){
 if(gatewayShutdown)return;
 const force=setTimeout(()=>{console.error('gateway_shutdown_timeout');process.exit(1);},90_000);
 const drain=lifetime.stop();
 const closed=new Promise<void>(resolve=>server.close(()=>resolve()));
 server.closeIdleConnections();
 gatewayShutdown=Promise.all([drain,closed]).then(async()=>{await drainSecurityCaptures();await pool.end();clearTimeout(force);console.info('gateway_shutdown_drained');process.exit(0);})
  .catch(()=>{clearTimeout(force);console.error('gateway_shutdown_failed');process.exit(1);});
}
process.once('SIGTERM',shutdownGateway);process.once('SIGINT',shutdownGateway);
import {createMassPollers} from './mass-campaign-worker.js';
import {processDueMassBatch} from './mass-campaign-scheduler.js';
import {processMassProgress} from './mass-campaign-progress.js';
import {officialMassAdapter,queryStoredOfficialMass} from './mass-campaign-official-adapter.js';
import {processMassReceipt} from './mass-campaign-receipts.js';
