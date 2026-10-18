import type { PoolClient } from "pg";
import { pool } from "./database.js";
import { registrationAccessMode } from "./registration-security.js";
import { smsProviderDiagnostic } from "./sms-provider.js";
import { registrationLegalState } from "./registration-legal.js";

import { registrationSmsBudget } from "./registration-budget.js";
const maskEmail = (value: string) => value.replace(/^(.{1,2}).*(@.*)$/, "$1***$2");
const maskPhone = (value: string) => value.replace(/^(\+861\d{2})\d{4}(\d{4})$/, "$1****$2");
const boundedInt = (name: string, fallback: number, maximum = 1_000_000) => {
  const value = Number(process.env[name] ?? fallback);
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : fallback;
};

async function smsDeliveryMetrics() {
  const [summary, categories] = await Promise.all([
    pool.query<{ attempted: number; accepted: number; failed: number; pending: number; retryable_failed: number; estimated_cost_minor: number }>(`SELECT
      COUNT(*)::int attempted,
      COUNT(*) FILTER(WHERE send_status='accepted')::int accepted,
      COUNT(*) FILTER(WHERE send_status='failed')::int failed,
      COUNT(*) FILTER(WHERE send_status='pending')::int pending,
      COUNT(*) FILTER(WHERE send_status='failed' AND failure_retryable IS TRUE)::int retryable_failed,
      COALESCE(SUM(estimated_cost_minor),0)::int estimated_cost_minor
      FROM phone_verification_challenges p
      LEFT JOIN registration_attempts r ON r.phone_challenge_id=p.challenge_id
      WHERE p.purpose='registration' AND p.created_at>NOW()-INTERVAL '24 hours'
        AND (r.registration_id IS NULL OR r.idempotency_key NOT LIKE 'phase-%')`),
    pool.query<{ failure_category: string; count: number }>(`SELECT COALESCE(failure_category,'unknown') failure_category,COUNT(*)::int count
      FROM phone_verification_challenges p
      LEFT JOIN registration_attempts r ON r.phone_challenge_id=p.challenge_id
      WHERE p.purpose='registration' AND p.send_status='failed' AND p.created_at>NOW()-INTERVAL '24 hours'
        AND (r.registration_id IS NULL OR r.idempotency_key NOT LIKE 'phase-%')
      GROUP BY 1 ORDER BY count DESC,1`),
  ]);
  const value = summary.rows[0] ?? { attempted: 0, accepted: 0, failed: 0, pending: 0, retryable_failed: 0, estimated_cost_minor: 0 };
  const warningMinor = boundedInt("REGISTRATION_SMS_COST_WARNING_MINOR", 400, 100_000_000);
  return {
    ...value,
    failure_rate: value.attempted ? value.failed / value.attempted : null,
    estimated_cost_currency: "CNY",
    cost_warning_minor: warningMinor,
    cost_warning: warningMinor > 0 && value.estimated_cost_minor >= warningMinor,
    failure_categories: categories.rows,
  };
}

export async function registrationControlState(client: Pick<PoolClient, "query"> | typeof pool = pool) {
  const result = await client.query<{ emergency_paused: boolean; reason: string | null; updated_at: Date }>(
    `SELECT emergency_paused,reason,updated_at FROM registration_runtime_controls WHERE control_key='self_service_registration'`
  );
  const budget = await client.query<{ reserved_count: number }>(
    `SELECT reserved_count FROM registration_verification_budgets
      WHERE budget_date=(NOW() AT TIME ZONE 'UTC')::date AND channel='sms'`
  );
  const limit = await registrationSmsBudget(client), reserved = Number(budget.rows[0]?.reserved_count ?? 0);
  const environmentEnabled = process.env.SELF_SERVICE_REGISTRATION_ENABLED === "true";
  const emergencyPaused = result.rows[0]?.emergency_paused ?? false;
  const legal = registrationLegalState();
  return {
    environment_enabled: environmentEnabled,
    emergency_paused: emergencyPaused,
    effective_enabled: environmentEnabled && !emergencyPaused && legal.publish_ready,
    legal,
    access_mode: registrationAccessMode(),
    sms_provider: process.env.SMS_PROVIDER ?? "mock",
    sms_live_enabled: process.env.SMS_LIVE_SEND_ENABLED === "true",
    budget: { date_utc: new Date().toISOString().slice(0, 10), limit, reserved, remaining: Math.max(0, limit - reserved) },
    reason: result.rows[0]?.reason ?? null,
    updated_at: result.rows[0]?.updated_at ?? null,
  };
}

export async function registrationEffectiveEnabled() {
  return (await registrationControlState()).effective_enabled;
}

export async function registrationOperationsOverview() {
  const [control, smsDelivery, funnel, statuses, denied, hourly, attempts, security, controls] = await Promise.all([
    registrationControlState(),
    smsDeliveryMetrics(),
    pool.query(`SELECT
      COUNT(*)::int AS started,
      COUNT(*) FILTER(WHERE email_verified_at IS NOT NULL)::int AS email_verified,
      COUNT(*) FILTER(WHERE phone_verified_at IS NOT NULL)::int AS phone_verified,
      COUNT(*) FILTER(WHERE status='completed')::int AS completed,
      COUNT(*) FILTER(WHERE status='failed')::int AS failed,
      COUNT(*) FILTER(WHERE status='expired' OR (status<>'completed' AND expires_at<=NOW()))::int AS expired
      FROM registration_attempts WHERE created_at>NOW()-INTERVAL '7 days'`),
    pool.query(`SELECT status,COUNT(*)::int count FROM registration_attempts WHERE created_at>NOW()-INTERVAL '7 days' GROUP BY status ORDER BY status`),
    pool.query(`SELECT reason_code,COUNT(DISTINCT request_id)::int count FROM registration_security_events WHERE outcome='denied' AND created_at>NOW()-INTERVAL '24 hours' GROUP BY reason_code ORDER BY count DESC,reason_code`),
    pool.query(`SELECT date_trunc('hour',created_at) AS hour_bucket,COUNT(*)::int started,COUNT(*) FILTER(WHERE status='completed')::int completed FROM registration_attempts WHERE created_at>NOW()-INTERVAL '24 hours' GROUP BY 1 ORDER BY 1`),
    pool.query<{ registration_id: string; email: string; phone_e164: string; company_name: string; status: string; referral_code: string | null; email_verified_at: Date | null; phone_verified_at: Date | null; failure_code: string | null; created_at: Date; completed_at: Date | null }>(
      `SELECT registration_id,email,phone_e164,company_name,status,referral_code,email_verified_at,phone_verified_at,failure_code,created_at,completed_at FROM registration_attempts ORDER BY created_at DESC LIMIT 50`
    ),
    pool.query(`SELECT request_id,signal_kind,outcome,reason_code,created_at FROM registration_security_events ORDER BY created_at DESC LIMIT 100`),
    pool.query(`SELECT e.control_event_id,e.action,e.reason,e.actor_role,a.display_name actor_name,e.request_id,e.created_at FROM registration_control_events e JOIN platform_admin_accounts a ON a.admin_id=e.actor_admin_id ORDER BY e.created_at DESC LIMIT 30`),
  ]);
  const row = funnel.rows[0] ?? {};
  return {
    control,
    sms_delivery_24h: smsDelivery,
    funnel_7d: { ...row, completion_rate: Number(row.started) ? Number(row.completed) / Number(row.started) : null },
    statuses_7d: statuses.rows,
    denied_reasons_24h: denied.rows,
    hourly_24h: hourly.rows,
    recent_attempts: attempts.rows.map(item => ({
      registration_id: item.registration_id, company_name: item.company_name, email: maskEmail(item.email), phone: maskPhone(item.phone_e164),
      status: item.status, invite_supplied: Boolean(item.referral_code), email_verified: Boolean(item.email_verified_at), phone_verified: Boolean(item.phone_verified_at),
      failure_code: item.failure_code, created_at: item.created_at, completed_at: item.completed_at,
    })),
    recent_security_events: security.rows,
    control_events: controls.rows,
  };
}

export async function registrationSmsHealth() {
  const [control, delivery] = await Promise.all([registrationControlState(), smsDeliveryMetrics()]);
  const diagnostic = smsProviderDiagnostic();
  const failureMinimum = boundedInt("REGISTRATION_SMS_FAILURE_SAMPLE_MINIMUM", 5, 100_000);
  const failureWarnPercent = boundedInt("REGISTRATION_SMS_FAILURE_RATE_WARN_PERCENT", 20, 100);
  const failureWarning = delivery.attempted >= failureMinimum && (delivery.failure_rate ?? 0) * 100 >= failureWarnPercent;
  const providerReady = diagnostic.provider !== "mock" && diagnostic.configured && diagnostic.live_send_enabled;
  const active = control.effective_enabled;
  const degraded = active && (!providerReady || failureWarning || delivery.cost_warning);
  return {
    status: !active ? "registration_closed" : degraded ? "degraded" : "operational",
    registration_enabled: active,
    provider: diagnostic.provider,
    provider_ready: providerReady,
    attempted_24h: delivery.attempted,
    accepted_24h: delivery.accepted,
    failed_24h: delivery.failed,
    failure_rate_percent: delivery.failure_rate === null ? null : Number((delivery.failure_rate * 100).toFixed(2)),
    estimated_cost_minor_24h: delivery.estimated_cost_minor,
    estimated_cost_currency: delivery.estimated_cost_currency,
    cost_warning: delivery.cost_warning,
    failure_warning: failureWarning,
  };
}

export async function setRegistrationEmergencyPause(input: { action: "pause" | "resume"; reason: string; admin_id: string; actor_role: string; request_id: string }) {
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 500) throw new Error("reason_required");
  const after = input.action === "pause";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('registration-runtime-control'))`);
    const current = await client.query<{ emergency_paused: boolean }>(`SELECT emergency_paused FROM registration_runtime_controls WHERE control_key='self_service_registration' FOR UPDATE`);
    const before = current.rows[0]?.emergency_paused ?? false;
    if (before === after) throw new Error(after ? "registration_already_paused" : "registration_already_resumed");
    await client.query(`UPDATE registration_runtime_controls SET emergency_paused=$1,reason=$2,updated_by=$3,updated_at=NOW() WHERE control_key='self_service_registration'`, [after, reason, input.admin_id]);
    const event = await client.query<{ control_event_id: string }>(
      `INSERT INTO registration_control_events(action,before_paused,after_paused,reason,actor_admin_id,actor_role,request_id)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING control_event_id`, [after ? "paused" : "resumed", before, after, reason, input.admin_id, input.actor_role, input.request_id]
    );
    await client.query(
      `INSERT INTO platform_admin_audit_logs(actor_admin_id,actor_role,action,resource_type,resource_id,reason,after_data,request_id)
       VALUES($1,$2,$3,'registration_runtime_control','self_service_registration',$4,jsonb_build_object('emergency_paused',$5::boolean),$6)`,
      [input.admin_id, input.actor_role, after ? "registration.emergency_paused" : "registration.emergency_resumed", reason, after, input.request_id]
    );
    await client.query("COMMIT");
    return { control_event_id: event.rows[0].control_event_id, ...(await registrationControlState(client)), idempotent_replay: false };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}
