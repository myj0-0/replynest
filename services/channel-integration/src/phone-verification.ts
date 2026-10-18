import { createHmac, randomInt } from "node:crypto";
import { pool } from "./database.js";
import { normalizeMainlandPhone, sendVerificationSms, smsFailureDetails } from "./sms-provider.js";
import { requiredEnv } from "./shared.js";

export type PhoneVerificationPurpose = "registration" | "phone_change" | "account_recovery";

function hashCode(challengeId: string, code: string): string {
  const pepper = requiredEnv("PHONE_VERIFICATION_PEPPER");
  if (pepper.length < 32) throw new Error("PHONE_VERIFICATION_PEPPER must be at least 32 characters");
  return createHmac("sha256", pepper).update(`${challengeId}.${code}`).digest("hex");
}

export async function issuePhoneVerification(phone: string, purpose: PhoneVerificationPurpose, testOptions?: { code?: string }): Promise<{ challenge_id: string; expires_in: number }> {
  const normalized = normalizeMainlandPhone(phone);
  if (!normalized) throw new Error("Invalid mainland China mobile number");
  const e164 = `+86${normalized}`;
  const recent = await pool.query(`SELECT 1 FROM phone_verification_challenges WHERE phone_e164=$1 AND purpose=$2 AND created_at>NOW()-INTERVAL '60 seconds' LIMIT 1`, [e164, purpose]);
  if (recent.rowCount) throw new Error("Phone verification is rate limited");
  if (testOptions?.code && (process.env.SMS_PROVIDER ?? "mock") !== "mock") throw new Error("Fixed verification codes are only allowed with the mock provider");
  const code = testOptions?.code ?? String(randomInt(0, 1_000_000)).padStart(6, "0");
  if (!/^\d{6}$/.test(code)) throw new Error("Verification code must contain six digits");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`phone:${e164}:${purpose}`]);
    await client.query(`UPDATE phone_verification_challenges SET consumed_at=NOW() WHERE phone_e164=$1 AND purpose=$2 AND verified_at IS NULL AND consumed_at IS NULL`, [e164, purpose]);
    const inserted = await client.query<{ challenge_id: string }>(
      `INSERT INTO phone_verification_challenges(phone_e164,purpose,code_hash,provider,send_status,expires_at)
       VALUES ($1,$2,'pending','mock','pending',NOW()+INTERVAL '5 minutes') RETURNING challenge_id`, [e164, purpose]
    );
    const challengeId = inserted.rows[0].challenge_id;
    await client.query(`UPDATE phone_verification_challenges SET code_hash=$2 WHERE challenge_id=$1`, [challengeId, hashCode(challengeId, code)]);
    await client.query("COMMIT");
    try {
      const delivery = await sendVerificationSms(normalized, code);
      const unitCost = Math.max(0, Math.min(10_000, Number(process.env.REGISTRATION_SMS_ESTIMATED_UNIT_COST_MINOR ?? 5) || 5));
      await pool.query(`UPDATE phone_verification_challenges SET provider=$2,provider_message_id=$3,provider_code='OK',send_status='accepted',estimated_cost_minor=$4,delivery_updated_at=NOW() WHERE challenge_id=$1`, [challengeId, delivery.provider, delivery.message_id, unitCost]);
    } catch (error) {
      const failure = smsFailureDetails(error);
      await pool.query(`UPDATE phone_verification_challenges SET send_status='failed',provider_code=$2,failure_category=$3,failure_retryable=$4,consumed_at=NOW(),delivery_updated_at=NOW() WHERE challenge_id=$1`, [challengeId, failure.provider_code, failure.category, failure.retryable]);
      throw error;
    }
    return { challenge_id: challengeId, expires_in: 300 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function verifyPhoneChallenge(challengeId: string, code: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(challengeId) || !/^\d{6}$/.test(code)) return false;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ code_hash: string; attempts: number }>(
      `SELECT code_hash,attempts FROM phone_verification_challenges
        WHERE challenge_id=$1 AND send_status='accepted' AND verified_at IS NULL AND consumed_at IS NULL AND expires_at>NOW() FOR UPDATE`, [challengeId]
    );
    const challenge = result.rows[0];
    if (!challenge || challenge.attempts >= 5) { await client.query("ROLLBACK"); return false; }
    if (hashCode(challengeId, code) !== challenge.code_hash) {
      await client.query(`UPDATE phone_verification_challenges SET attempts=attempts+1,consumed_at=CASE WHEN attempts+1>=5 THEN NOW() ELSE consumed_at END WHERE challenge_id=$1`, [challengeId]);
      await client.query("COMMIT");
      return false;
    }
    await client.query(`UPDATE phone_verification_challenges SET verified_at=NOW(),attempts=attempts+1 WHERE challenge_id=$1`, [challengeId]);
    await client.query("COMMIT");
    return true;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
