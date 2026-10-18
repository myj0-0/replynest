import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "./database.js";
import { validateTenantSocialRules, type SocialCategory, type SocialEventType, type TenantSocialRule } from "./social-channel-core.js";
import {
  correctedSocialRoute,
  nextSocialCaseState,
  validateCorrectableCategory,
  validateModerationReason,
  validateSocialRuleName,
  type SocialCaseAction,
  type SocialCaseState,
} from "./social-moderation-core.js";
import { emitSocialModerationNotification } from "./social-notifications.js";
import type { EmitNotificationInput } from "./notification-gateway.js";

type Queryable = Pick<PoolClient, "query">;
export type SocialActor = { actor_type: string; actor_id: string; platform_user_id?: string | null };
type SocialCorrectionRow = {
  correction_id: string;
  social_event_id: string;
  previous_category: SocialCategory;
  corrected_category: SocialCategory;
  corrected_route: string;
  corrected_priority: string;
  reason: string;
  created_at: string;
};
type SocialActionRow = {
  action_id: string;
  social_event_id: string;
  action: SocialCaseAction;
  resulting_state: SocialCaseState;
  reason: string;
  created_at: string;
};
type SocialEvaluationRow = {
  evaluation_id: string;
  social_event_id: string;
  machine_category: SocialCategory;
  evaluated_category: SocialCategory;
  outcome: "confirmed" | "corrected";
  reason: string;
  created_at: string;
};

export async function loadActiveSocialRules(tenantId: string, db: Queryable = pool): Promise<TenantSocialRule[]> {
  const result = await db.query(
    `SELECT rule_id::text AS rule_id,priority,category,keywords
       FROM social_tenant_rules
      WHERE tenant_id=$1 AND status='active'
      ORDER BY priority DESC,created_at,rule_id`,
    [tenantId],
  );
  return validateTenantSocialRules(result.rows.map(row => ({
    rule_id: row.rule_id,
    priority: Number(row.priority),
    category: row.category,
    keywords: row.keywords,
  })));
}

export async function listSocialRules(tenantId: string) {
  const result = await pool.query(
    `SELECT rule_id,name,priority,category,keywords,status,version,created_at,updated_at
       FROM social_tenant_rules WHERE tenant_id=$1 ORDER BY status,priority DESC,created_at`,
    [tenantId],
  );
  return result.rows;
}

function normalizedRuleInput(input: Record<string, unknown>, ruleId: string = randomUUID()) {
  const name = validateSocialRuleName(input.name);
  const priority = Number(input.priority);
  const category = validateCorrectableCategory(input.category);
  const keywords = Array.isArray(input.keywords) ? input.keywords.map(String) : [];
  const rule = validateTenantSocialRules([{ rule_id: ruleId, priority, category, keywords }])[0];
  const status = input.status === undefined ? "active" : String(input.status);
  if (status !== "active" && status !== "disabled") throw new Error("invalid_social_rule_status");
  return { name, priority: rule.priority, category: rule.category, keywords: rule.keywords, status };
}

export async function createSocialRule(input: {
  tenant_id: string;
  body: Record<string, unknown>;
  actor: SocialActor;
  request_id: string;
}) {
  const ruleId = randomUUID();
  const rule = normalizedRuleInput(input.body, ruleId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const created = await client.query(
      `INSERT INTO social_tenant_rules
        (rule_id,tenant_id,name,priority,category,keywords,status,created_by,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)
       RETURNING rule_id,name,priority,category,keywords,status,version,created_at,updated_at`,
      [ruleId, input.tenant_id, rule.name, rule.priority, rule.category, JSON.stringify(rule.keywords), rule.status, input.actor.actor_id],
    );
    await client.query(
      `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
       VALUES($1,$2,$3,'social.rule_created','social_tenant_rule',$4,$5,$6)`,
      [input.tenant_id, input.actor.actor_type, input.actor.actor_id, ruleId, created.rows[0], input.request_id],
    );
    await client.query("COMMIT");
    return created.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateSocialRule(input: {
  tenant_id: string;
  rule_id: string;
  expected_version: number;
  body: Record<string, unknown>;
  actor: SocialActor;
  request_id: string;
}) {
  if (!Number.isSafeInteger(input.expected_version) || input.expected_version < 1) throw new Error("invalid_social_rule_version");
  const rule = normalizedRuleInput(input.body, input.rule_id);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = await client.query(
      `SELECT rule_id,name,priority,category,keywords,status,version FROM social_tenant_rules
        WHERE tenant_id=$1 AND rule_id=$2 FOR UPDATE`,
      [input.tenant_id, input.rule_id],
    );
    if (!before.rows[0]) throw new Error("social_rule_not_found");
    if (Number(before.rows[0].version) !== input.expected_version) throw new Error("social_rule_version_conflict");
    const updated = await client.query(
      `UPDATE social_tenant_rules SET name=$3,priority=$4,category=$5,keywords=$6,status=$7,
          version=version+1,updated_by=$8,updated_at=NOW()
        WHERE tenant_id=$1 AND rule_id=$2 AND version=$9
        RETURNING rule_id,name,priority,category,keywords,status,version,created_at,updated_at`,
      [input.tenant_id, input.rule_id, rule.name, rule.priority, rule.category, JSON.stringify(rule.keywords), rule.status, input.actor.actor_id, input.expected_version],
    );
    if (!updated.rows[0]) throw new Error("social_rule_version_conflict");
    await client.query(
      `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,before_data,after_data,request_id)
       VALUES($1,$2,$3,'social.rule_updated','social_tenant_rule',$4,$5,$6,$7)`,
      [input.tenant_id, input.actor.actor_type, input.actor.actor_id, input.rule_id, before.rows[0], updated.rows[0], input.request_id],
    );
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function correctSocialClassification(input: {
  tenant_id: string;
  social_event_id: string;
  category: unknown;
  reason: unknown;
  actor: SocialActor;
  request_id: string;
  notification_delivery_mode?: EmitNotificationInput["delivery_mode"];
}) {
  const category = validateCorrectableCategory(input.category);
  const reason = validateModerationReason(input.reason);
  const client = await pool.connect();
  let eventType!: SocialEventType;
  let correction!: SocialCorrectionRow;
  try {
    await client.query("BEGIN");
    const event = await client.query(
      `SELECT e.event_type,c.category AS original_category,
              COALESCE(latest.corrected_category,c.category) AS effective_category,
              COALESCE(state.resulting_state,'pending') AS case_state
         FROM social_events e JOIN social_classifications c ON c.social_event_id=e.social_event_id
         LEFT JOIN LATERAL (
           SELECT corrected_category FROM social_classification_corrections x
            WHERE x.tenant_id=e.tenant_id AND x.social_event_id=e.social_event_id
            ORDER BY x.created_at DESC,x.correction_id DESC LIMIT 1
         ) latest ON TRUE
         LEFT JOIN LATERAL (
           SELECT resulting_state FROM social_case_actions a
            WHERE a.tenant_id=e.tenant_id AND a.social_event_id=e.social_event_id
            ORDER BY a.created_at DESC,a.action_id DESC LIMIT 1
         ) state ON TRUE
        WHERE e.tenant_id=$1 AND e.social_event_id=$2 FOR UPDATE OF e`,
      [input.tenant_id, input.social_event_id],
    );
    if (!event.rows[0]) throw new Error("social_event_not_found");
    if (event.rows[0].case_state === "resolved") throw new Error("social_case_resolved");
    if (event.rows[0].effective_category === category) throw new Error("social_category_unchanged");
    eventType = event.rows[0].event_type;
    const route = correctedSocialRoute(eventType, category);
    const inserted = await client.query<SocialCorrectionRow>(
      `INSERT INTO social_classification_corrections
        (social_event_id,tenant_id,previous_category,corrected_category,corrected_route,corrected_priority,reason,actor_type,actor_id,request_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING correction_id,social_event_id,previous_category,corrected_category,corrected_route,corrected_priority,reason,created_at`,
      [input.social_event_id, input.tenant_id, event.rows[0].effective_category, category, route.route, route.priority,
       reason, input.actor.actor_type, input.actor.actor_id, input.request_id],
    );
    correction = inserted.rows[0];
    await client.query(
      `INSERT INTO social_classification_evaluations
        (social_event_id,tenant_id,machine_category,evaluated_category,outcome,reason,actor_type,actor_id,request_id)
       VALUES($1,$2,$3,$4,CASE WHEN $3::text=$4::text THEN 'confirmed' ELSE 'corrected' END,$5,$6,$7,$8)`,
      [input.social_event_id, input.tenant_id, event.rows[0].original_category, category, reason,
       input.actor.actor_type, input.actor.actor_id, input.request_id],
    );
    await client.query(
      `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,reason,before_data,after_data,request_id)
       VALUES($1,$2,$3,'social.classification_corrected','social_event',$4,$5,
              jsonb_build_object('category',$6::text),jsonb_build_object('category',$7::text,'route',$8::text,'priority',$9::text),$10)`,
      [input.tenant_id, input.actor.actor_type, input.actor.actor_id, input.social_event_id, reason,
       event.rows[0].effective_category, category, route.route, route.priority, input.request_id],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  let notificationError = false;
  try {
    await emitSocialModerationNotification({
      tenant_id: input.tenant_id,
      social_event_id: input.social_event_id,
      event_type: eventType,
      category,
      actor_type: input.actor.actor_type,
      actor_id: input.actor.actor_id,
      request_id: input.request_id,
      delivery_mode: input.notification_delivery_mode,
    });
  } catch {
    notificationError = true;
  }
  return { ...correction, notification_error: notificationError };
}

export async function confirmSocialClassification(input: {
  tenant_id: string;
  social_event_id: string;
  reason: unknown;
  actor: SocialActor;
  request_id: string;
}) {
  const reason = validateModerationReason(input.reason);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const event = await client.query(
      `SELECT c.category AS machine_category,
              COALESCE(correction.corrected_category,c.category) AS evaluated_category
         FROM social_events e JOIN social_classifications c ON c.social_event_id=e.social_event_id
         LEFT JOIN LATERAL (
           SELECT corrected_category FROM social_classification_corrections x
            WHERE x.tenant_id=e.tenant_id AND x.social_event_id=e.social_event_id
            ORDER BY x.created_at DESC,x.correction_id DESC LIMIT 1
         ) correction ON TRUE
        WHERE e.tenant_id=$1 AND e.social_event_id=$2 FOR UPDATE OF e`,
      [input.tenant_id, input.social_event_id],
    );
    if (!event.rows[0]) throw new Error("social_event_not_found");
    const inserted = await client.query<SocialEvaluationRow>(
      `INSERT INTO social_classification_evaluations
        (social_event_id,tenant_id,machine_category,evaluated_category,outcome,reason,actor_type,actor_id,request_id)
       VALUES($1,$2,$3,$4,CASE WHEN $3::text=$4::text THEN 'confirmed' ELSE 'corrected' END,$5,$6,$7,$8)
       RETURNING evaluation_id,social_event_id,machine_category,evaluated_category,outcome,reason,created_at`,
      [input.social_event_id, input.tenant_id, event.rows[0].machine_category, event.rows[0].evaluated_category,
       reason, input.actor.actor_type, input.actor.actor_id, input.request_id],
    );
    await client.query(
      `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,reason,after_data,request_id)
       VALUES($1,$2,$3,'social.classification_evaluated','social_event',$4,$5,$6,$7)`,
      [input.tenant_id, input.actor.actor_type, input.actor.actor_id, input.social_event_id, reason,
       { machine_category: event.rows[0].machine_category, evaluated_category: event.rows[0].evaluated_category, outcome: inserted.rows[0].outcome }, input.request_id],
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

export async function recordSocialCaseAction(input: {
  tenant_id: string;
  social_event_id: string;
  action: SocialCaseAction;
  reason: unknown;
  actor: SocialActor;
  request_id: string;
  notification_delivery_mode?: EmitNotificationInput["delivery_mode"];
}) {
  if (!["acknowledge", "resolve", "reopen"].includes(input.action)) throw new Error("invalid_social_case_action");
  const reason = validateModerationReason(input.reason);
  const client = await pool.connect();
  let eventType!: SocialEventType;
  let category!: SocialCategory;
  let actionRow!: SocialActionRow;
  try {
    await client.query("BEGIN");
    const current = await client.query(
      `SELECT e.event_type,COALESCE(correction.corrected_category,c.category) AS category,
              COALESCE(state.resulting_state,'pending') AS case_state
         FROM social_events e JOIN social_classifications c ON c.social_event_id=e.social_event_id
         LEFT JOIN LATERAL (
           SELECT corrected_category FROM social_classification_corrections x
            WHERE x.tenant_id=e.tenant_id AND x.social_event_id=e.social_event_id
            ORDER BY x.created_at DESC,x.correction_id DESC LIMIT 1
         ) correction ON TRUE
         LEFT JOIN LATERAL (
           SELECT resulting_state FROM social_case_actions a
            WHERE a.tenant_id=e.tenant_id AND a.social_event_id=e.social_event_id
            ORDER BY a.created_at DESC,a.action_id DESC LIMIT 1
         ) state ON TRUE
        WHERE e.tenant_id=$1 AND e.social_event_id=$2 FOR UPDATE OF e`,
      [input.tenant_id, input.social_event_id],
    );
    if (!current.rows[0]) throw new Error("social_event_not_found");
    eventType = current.rows[0].event_type;
    category = current.rows[0].category;
    const resultingState = nextSocialCaseState(current.rows[0].case_state as SocialCaseState, input.action);
    const inserted = await client.query<SocialActionRow>(
      `INSERT INTO social_case_actions
        (social_event_id,tenant_id,action,resulting_state,reason,actor_type,actor_id,request_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING action_id,social_event_id,action,resulting_state,reason,created_at`,
      [input.social_event_id, input.tenant_id, input.action, resultingState, reason,
       input.actor.actor_type, input.actor.actor_id, input.request_id],
    );
    actionRow = inserted.rows[0];
    if (input.action === "acknowledge") {
      await client.query(
        `UPDATE notification_events SET status='acknowledged',acknowledged_by=$3,acknowledged_at=NOW(),updated_at=NOW()
          WHERE tenant_id=$1 AND resource_type='social_event' AND resource_id=$2 AND status='open'`,
        [input.tenant_id, input.social_event_id, input.actor.platform_user_id ?? null],
      );
    } else if (input.action === "resolve") {
      await client.query(
        `UPDATE notification_events SET status='resolved',resolved_at=NOW(),updated_at=NOW()
          WHERE tenant_id=$1 AND resource_type='social_event' AND resource_id=$2 AND status IN ('open','acknowledged')`,
        [input.tenant_id, input.social_event_id],
      );
    }
    await client.query(
      `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,reason,before_data,after_data,request_id)
       VALUES($1,$2,$3,$4,'social_event',$5,$6,jsonb_build_object('state',$7::text),jsonb_build_object('state',$8::text),$9)`,
      [input.tenant_id, input.actor.actor_type, input.actor.actor_id, `social.case_${input.action}`, input.social_event_id,
       reason, current.rows[0].case_state, resultingState, input.request_id],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  let notificationError = false;
  if (input.action === "reopen") {
    try {
      await emitSocialModerationNotification({
        tenant_id: input.tenant_id,
        social_event_id: input.social_event_id,
        event_type: eventType,
        category,
        actor_type: input.actor.actor_type,
        actor_id: input.actor.actor_id,
        request_id: input.request_id,
        delivery_mode: input.notification_delivery_mode,
      });
    } catch {
      notificationError = true;
    }
  }
  return { ...actionRow, notification_error: notificationError };
}
