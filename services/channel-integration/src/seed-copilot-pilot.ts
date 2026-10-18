import { randomUUID } from "node:crypto";
import { migrate, pool } from "./database.js";
import { chunkText, contentChecksum } from "./knowledge-ingestion.js";
import { indexKnowledgeDocument } from "./knowledge-indexer.js";
import { requiredEnv } from "./shared.js";

const tenantId = requiredEnv("DEMO_TENANT_ID");
const syntheticUserId = "wx-copilot-demo";

const documents = [
  {
    title: "【合成演示】售后退款总则",
    source_type: "knowledge",
    keywords: ["退款", "退货", "未拆封", "售后"],
    content: "本资料仅用于 ReplyNest 试运营演示。客户提出退款时，客服必须核对订单归属、支付状态、签收时间、商品是否拆封以及当前有效临时规则。AI 只能生成建议，不能声称退款已经完成；无法核实时必须转人工。"
  },
  {
    title: "【合成演示】BATCH-2026-08 批次临时退款说明",
    source_type: "temporary_policy_text",
    keywords: ["BATCH-2026-08", "批次", "退款", "未拆封"],
    content: "本资料仅用于 ReplyNest 试运营演示。BATCH-2026-08 批次在临时规则有效期内，如订单属于当前咨询客户且商品签收后七日内未拆封，可建议申请原路退款；商品已拆封、超过七日、订单不属于当前客户或业务查询失败时必须转人工核验。"
  },
  {
    title: "【合成演示】配送与签收 FAQ",
    source_type: "faq",
    keywords: ["物流", "配送", "签收", "发货", "订单"],
    content: "本资料仅用于 ReplyNest 试运营演示。付款后通常在两个工作日内发货，发货后以订单实时查询结果为准。客服不得根据历史聊天猜测物流状态；查不到订单或状态异常时应转人工。"
  },
  {
    title: "【合成演示】公众号新客优惠沟通规范",
    source_type: "script",
    keywords: ["优惠", "新客", "公众号", "优惠券"],
    content: "本资料仅用于 ReplyNest 试运营演示。介绍临时优惠时必须同时说明适用渠道、有效期、是否可叠加和使用门槛。没有命中当前有效企业规则时，不得仅依据历史客服话术承诺优惠。"
  }
] as const;

await migrate();
await pool.query(
  `UPDATE tenant_ai_settings SET embedding_provider='gemini',embedding_model='gemini-embedding-001',
     embedding_dimensions=768,embedding_credential_ref='platform/gemini',updated_by='pilot_seed',updated_at=NOW()
   WHERE tenant_id=$1`, [tenantId]
);

let indexedChunks = 0;
for (const document of documents) {
  const inserted = await pool.query<{ document_id:string }>(
    `INSERT INTO knowledge_documents
      (tenant_id,title,source_type,version,status,content,keywords,content_format,content_checksum,ingestion_status,scan_status,parse_status)
     VALUES($1,$2,$3,1,'active',$4,$5,'text',$6,'parsed','not_required','parsed')
     ON CONFLICT(tenant_id,title,version) DO UPDATE SET source_type=EXCLUDED.source_type,status='active',content=EXCLUDED.content,
       keywords=EXCLUDED.keywords,content_checksum=EXCLUDED.content_checksum,ingestion_status='parsed',parse_status='parsed',updated_at=NOW()
     RETURNING document_id`,
    [tenantId, document.title, document.source_type, document.content, [...document.keywords], contentChecksum(document.content)]
  );
  const documentId = inserted.rows[0].document_id;
  const chunks = chunkText(document.content);
  await pool.query(`DELETE FROM knowledge_chunks WHERE tenant_id=$1 AND document_id=$2`, [tenantId, documentId]);
  for (let index = 0; index < chunks.length; index += 1) {
    await pool.query(
      `INSERT INTO knowledge_chunks(tenant_id,document_id,document_version,chunk_index,content,embedding_status)
       VALUES($1,$2,1,$3,$4,'pending')`, [tenantId, documentId, index, chunks[index]]
    );
  }
  const indexed = await indexKnowledgeDocument(tenantId, documentId);
  if (indexed.status !== "ready") throw new Error(`Unable to index ${document.title}: ${indexed.status}`);
  indexedChunks += indexed.indexed_chunks;
  await pool.query(`UPDATE knowledge_documents SET ingestion_status='ready',updated_at=NOW() WHERE tenant_id=$1 AND document_id=$2`, [tenantId, documentId]);
}

const now = new Date();
const validFrom = new Date(now.getTime() - 24 * 60 * 60_000);
const validUntil = new Date(now.getTime() + 30 * 24 * 60 * 60_000);
await pool.query(
  `INSERT INTO temporary_policies
    (tenant_id,name,policy_type,status,priority,valid_from,valid_until,eligibility_time_basis,scope,conditions,decision,
     allowed_actions,forbidden_actions,reply_guidance,requires_human_approval,version,created_by,approved_by)
   VALUES($1,'【合成演示】BATCH-2026-08 临时退款规则','refund','active',250,$2,$3,'request_time',
     '{"product_batch_ids":["BATCH-2026-08"],"channels":["mock-wechat"]}'::jsonb,
     '{"unopened_within_days":7}'::jsonb,'{"eligibility":"conditional","refund_method":"original_payment"}'::jsonb,
     ARRAY['recommend_refund'],ARRAY['claim_refund_completed'],
     '该订单命中合成临时退款规则。请核对签收时间和商品是否拆封；符合条件时可建议客户申请原路退款，但必须由人工客服确认后发送。',TRUE,1,'pilot_seed','tenant_admin')
   ON CONFLICT(tenant_id,name,version) DO UPDATE SET status='active',priority=EXCLUDED.priority,valid_from=EXCLUDED.valid_from,
     valid_until=EXCLUDED.valid_until,scope=EXCLUDED.scope,conditions=EXCLUDED.conditions,decision=EXCLUDED.decision,
     allowed_actions=EXCLUDED.allowed_actions,forbidden_actions=EXCLUDED.forbidden_actions,reply_guidance=EXCLUDED.reply_guidance,
     requires_human_approval=TRUE,updated_at=NOW()`, [tenantId, validFrom, validUntil]
);

await pool.query(
  `INSERT INTO historical_reply_examples
    (tenant_id,source_conversation_id,customer_question,agent_reply,intent,keywords,applicable_policy_ids,event_occurred_at,
     policy_valid_at_that_time,policy_independent,review_status,pii_redacted)
   VALUES($1,'synthetic-copilot-tone-001','我想申请退款，应该怎么办？','您好，我先帮您核对订单和当前适用规则；确认商品状态后再为您说明可办理的路径。',
     'refund',ARRAY['退款','申请'],ARRAY[]::UUID[],NOW()-INTERVAL '2 days',FALSE,TRUE,'approved',TRUE)
   ON CONFLICT(tenant_id,source_conversation_id,intent) DO UPDATE SET agent_reply=EXCLUDED.agent_reply,keywords=EXCLUDED.keywords,
     review_status='approved',pii_redacted=TRUE`, [tenantId]
);

const identity = await pool.query<{ customer_id:string }>(
  `SELECT customer_id FROM channel_identities WHERE tenant_id=$1 AND channel='mock-wechat' AND external_user_id=$2 ORDER BY created_at DESC LIMIT 1`,
  [tenantId, syntheticUserId]
);
if (identity.rows[0]) {
  await pool.query(
    `INSERT INTO mock_orders(tenant_id,external_order_id,customer_id,status,amount_cents,currency,product_summary,product_batch_id,placed_at,paid_at,fulfilled_at)
     VALUES($1,'ORD-COPILOT-DEMO-001',$2,'delivered',19900,'CNY','答巢演示产品（合成）','BATCH-2026-08',
       NOW()-INTERVAL '4 days',NOW()-INTERVAL '4 days',NOW()-INTERVAL '1 day')
     ON CONFLICT(tenant_id,external_order_id) DO UPDATE SET customer_id=EXCLUDED.customer_id,status='delivered',
       product_batch_id='BATCH-2026-08',fulfilled_at=NOW()-INTERVAL '1 day',updated_at=NOW()`, [tenantId, identity.rows[0].customer_id]
  );
}

await pool.query(
  `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
   VALUES($1,'system','pilot_seed','copilot.synthetic_fixture.seeded','tenant',$1,
     jsonb_build_object('documents',$2::int,'indexed_chunks',$3::int,'mock_identity_ready',$4::boolean),$5)`,
  [tenantId, documents.length, indexedChunks, Boolean(identity.rows[0]), randomUUID()]
);

console.log(JSON.stringify({ tenant_id:tenantId, documents:documents.length, indexed_chunks:indexedChunks,
  embedding_provider:"gemini", embedding_dimensions:768, mock_identity_ready:Boolean(identity.rows[0]),
  synthetic_order_ready:Boolean(identity.rows[0]) }));
await pool.end();
