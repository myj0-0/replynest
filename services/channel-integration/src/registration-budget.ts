import { pool } from "./database.js";
import type { PoolClient } from "pg";

export function parseSmsBudget(value: unknown): number {
  if ((typeof value !== "number" && typeof value !== "string") || !/^\d+$/.test(String(value))) throw new Error("invalid_sms_budget");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > 1_000_000) throw new Error("invalid_sms_budget");
  return n;
}
export async function registrationSmsBudget(db: Pick<PoolClient,"query"> = pool) {
  const result = await db.query(`SELECT sms_daily_budget FROM registration_runtime_controls WHERE control_key='self_service_registration'`);
  if (result.rows[0]?.sms_daily_budget != null) return parseSmsBudget(result.rows[0].sms_daily_budget);
  try { return parseSmsBudget(process.env.REGISTRATION_SMS_DAILY_BUDGET ?? 100); } catch { return 100; }
}
export async function setRegistrationSmsBudget(input: { limit: unknown; expected_limit: unknown; reason: string; admin_id: string; actor_role: string; request_id: string }) {
  const limit = parseSmsBudget(input.limit), expected = parseSmsBudget(input.expected_limit), reason = input.reason.trim();
  if (!["owner","admin"].includes(input.actor_role)) throw new Error("forbidden");
  if (reason.length < 10 || reason.length > 500) throw new Error("reason_required");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('registration-sms-budget'))`);
    const before = await registrationSmsBudget(db);
    if (before !== expected) throw new Error("sms_budget_changed_reload");
    await db.query(`UPDATE registration_runtime_controls SET sms_daily_budget=$1 WHERE control_key='self_service_registration'`, [limit]);
    await db.query(`INSERT INTO platform_admin_audit_logs(actor_admin_id,actor_role,action,resource_type,resource_id,reason,before_data,after_data,request_id)
      VALUES($1,$2,'registration.sms_budget_updated','registration_runtime_control','self_service_registration',$3,$4::jsonb,$5::jsonb,$6)`,
      [input.admin_id,input.actor_role,reason,JSON.stringify({limit:before}),JSON.stringify({limit}),input.request_id]);
    await db.query("COMMIT");
    return { limit };
  } catch(error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
