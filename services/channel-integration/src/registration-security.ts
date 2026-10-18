import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { PoolClient } from "pg";
import { pool } from "./database.js";
import { secretValue } from "./secret-value.js";
import { resolvePilotInvite } from "./registration-pilot.js";
import { registrationSmsBudget } from "./registration-budget.js";

export type RegistrationAccessMode = "invite_only" | "public";
export type RegistrationRiskContext = { ip?: string; device_id?: string };
type Signal = { kind: "ip" | "device" | "email" | "phone"; hash: string; limit: number; windowSeconds: number };

export class RegistrationAccessError extends Error { constructor(public code: string) { super(code); } }
export class RegistrationRateLimitError extends Error {
  constructor(public code: string, public retry_after_seconds: number) { super(code); }
}

function positiveInt(name: string, fallback: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isSafeInteger(value) && value > 0 && value <= max ? value : fallback;
}
function pepper() {
  const value = secretValue("REGISTRATION_RISK_PEPPER") || secretValue("RISK_SIGNAL_PEPPER");
  if (!value || value.length < 32) throw new Error("REGISTRATION_RISK_PEPPER or RISK_SIGNAL_PEPPER must be at least 32 characters");
  return value;
}
function signalHash(kind: string, value: string) {
  return createHmac("sha256", pepper()).update(`registration:v1:${kind}:${value}`).digest("hex");
}
function normalizedIp(value?: string) {
  const candidate = String(value ?? "").trim().replace(/^::ffff:/, "");
  return isIP(candidate) ? candidate : "";
}
function normalizedDevice(value?: string) {
  const candidate = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]{32,128}$/.test(candidate) ? candidate : "";
}
export function registrationAccessMode(): RegistrationAccessMode {
  return process.env.REGISTRATION_ACCESS_MODE === "public" ? "public" : "invite_only";
}

export type RegistrationInviteAccess = { kind: "public" } | { kind: "referral" } | { kind: "pilot"; pilot_invite_id: string; pilot_batch_id: string };

export async function requireRegistrationInvite(code: string | null, now = new Date(), db: Pick<PoolClient,"query"> | typeof pool = pool, lockPilot = false): Promise<RegistrationInviteAccess> {
  if (registrationAccessMode() === "public") return { kind: "public" };
  if (!code) throw new RegistrationAccessError("registration_invite_required");
  const found = await db.query(
    `SELECT 1 FROM referral_invite_codes i JOIN growth_campaigns c ON c.campaign_id=i.campaign_id
      WHERE i.invite_code=$1 AND i.status='active' AND i.revoked_at IS NULL
        AND c.status='active' AND c.starts_at<=$2 AND c.ends_at>$2 LIMIT 1`, [code, now]
  );
  if (found.rowCount) return { kind: "referral" };
  const pilot = await resolvePilotInvite(code, now, db, lockPilot);
  if (pilot) return { kind: "pilot", pilot_invite_id: pilot.pilot_invite_id, pilot_batch_id: pilot.pilot_batch_id };
  throw new RegistrationAccessError("registration_invite_invalid");
}

export async function reserveRegistrationVerification(input: { email: string; phone_e164: string; context?: RegistrationRiskContext }, requestId: string) {
  const ip = normalizedIp(input.context?.ip);
  const device = normalizedDevice(input.context?.device_id);
  const signals: Signal[] = [
    ...(ip ? [{ kind: "ip" as const, hash: signalHash("ip", ip), limit: positiveInt("REGISTRATION_IP_STARTS_PER_HOUR", 10, 10_000), windowSeconds: 3600 }] : []),
    ...(device ? [{ kind: "device" as const, hash: signalHash("device", device), limit: positiveInt("REGISTRATION_DEVICE_STARTS_PER_HOUR", 5, 10_000), windowSeconds: 3600 }] : []),
    { kind: "email", hash: signalHash("email", input.email), limit: positiveInt("REGISTRATION_EMAIL_STARTS_PER_DAY", 3, 10_000), windowSeconds: 86400 },
    { kind: "phone", hash: signalHash("phone", input.phone_e164), limit: positiveInt("REGISTRATION_PHONE_STARTS_PER_DAY", 3, 10_000), windowSeconds: 86400 },
  ];
  const globalHash = signalHash("global", new Date().toISOString().slice(0, 10));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const signal of [...signals].sort((a, b) => `${a.kind}:${a.hash}`.localeCompare(`${b.kind}:${b.hash}`))) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`registration:${signal.kind}:${signal.hash}`]);
    }
    let blocked: Signal | undefined;
    for (const signal of signals) {
      const count = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int count FROM registration_security_events
          WHERE signal_kind=$1 AND signal_hash=$2 AND outcome='allowed'
            AND created_at>NOW()-make_interval(secs=>$3)`, [signal.kind, signal.hash, signal.windowSeconds]
      );
      if (Number(count.rows[0]?.count ?? 0) >= signal.limit) { blocked = signal; break; }
    }
    if (blocked) {
      await client.query(
        `INSERT INTO registration_security_events(request_id,signal_kind,signal_hash,outcome,reason_code)
         VALUES($1,$2,$3,'denied','registration_rate_limited') ON CONFLICT DO NOTHING`, [requestId, blocked.kind, blocked.hash]
      );
      await client.query("COMMIT");
      throw new RegistrationRateLimitError("registration_rate_limited", blocked.windowSeconds);
    }
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('registration-sms-budget'))`);
    const dailyBudget = await registrationSmsBudget(client);
    const budget = await client.query(
      `INSERT INTO registration_verification_budgets(budget_date,channel,reserved_count)
       VALUES((NOW() AT TIME ZONE 'UTC')::date,'sms',1)
       ON CONFLICT(budget_date,channel) DO UPDATE SET reserved_count=registration_verification_budgets.reserved_count+1,updated_at=NOW()
       WHERE registration_verification_budgets.reserved_count<$1 RETURNING reserved_count`, [dailyBudget]
    );
    if (!budget.rowCount) {
      await client.query(
        `INSERT INTO registration_security_events(request_id,signal_kind,signal_hash,outcome,reason_code)
         VALUES($1,'global',$2,'denied','registration_sms_budget_exhausted') ON CONFLICT DO NOTHING`, [requestId, globalHash]
      );
      await client.query("COMMIT");
      throw new RegistrationRateLimitError("registration_sms_budget_exhausted", 3600);
    }
    for (const signal of signals) {
      await client.query(
        `INSERT INTO registration_security_events(request_id,signal_kind,signal_hash,outcome,reason_code)
         VALUES($1,$2,$3,'allowed','verification_reserved') ON CONFLICT DO NOTHING`, [requestId, signal.kind, signal.hash]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
