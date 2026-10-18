import { createHash } from "node:crypto";
import { pool } from "./database.js";
import { requiredEnv } from "./shared.js";
import { hashConsolePassword } from "./console-password.js";

type ChatwootProfile = {
  id: number;
  email: string;
  name?: string;
  display_name?: string;
  confirmed: boolean;
  accounts?: Array<{ id: number; status: string; role: string }>;
};

function apiKeyHash(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export async function bootstrapDemoMembership(): Promise<void> {
  const chatwootBaseUrl = requiredEnv("CHATWOOT_BASE_URL");
  const chatwootAccessToken = requiredEnv("CHATWOOT_API_ACCESS_TOKEN");
  const tenantId = requiredEnv("DEMO_TENANT_ID");
  const demoApiKey = requiredEnv("DEMO_TENANT_API_KEY");
  const accountId = Number(requiredEnv("CHATWOOT_ACCOUNT_ID"));
  const response = await fetch(`${chatwootBaseUrl}/api/v1/profile`, {
    headers: { api_access_token: chatwootAccessToken, "x-forwarded-proto": "https" },
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error(`Chatwoot profile bootstrap returned ${response.status}`);
  const profile = await response.json() as ChatwootProfile;
  const account = profile.accounts?.find(item => Number(item.id) === accountId && item.status === "active");
  if (!profile.confirmed || !Number.isInteger(profile.id) || !profile.email || !account) {
    throw new Error("Chatwoot profile is not an active confirmed member of the mapped account");
  }

  const email = profile.email.trim().toLowerCase();
  const displayName = String(profile.display_name ?? profile.name ?? "Demo administrator").slice(0, 200);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const user = await client.query<{ platform_user_id: string }>(
      `INSERT INTO platform_users (email,display_name,status,email_verified_at)
       VALUES ($1,$2,'active',NOW())
       ON CONFLICT (email) DO UPDATE SET display_name=EXCLUDED.display_name,
         email_verified_at=COALESCE(platform_users.email_verified_at,NOW()),updated_at=NOW()
       RETURNING platform_user_id`,
      [email, displayName]
    );
    const platformUserId = user.rows[0].platform_user_id;
    const bootstrapPassword = process.env.CONSOLE_BOOTSTRAP_PASSWORD;
    if (bootstrapPassword && !bootstrapPassword.startsWith("CHANGE_ME")) {
      const passwordHash = await hashConsolePassword(bootstrapPassword);
      await client.query(
        `UPDATE platform_users SET password_hash=COALESCE(password_hash,$1),updated_at=NOW()
          WHERE platform_user_id=$2`,
        [passwordHash, platformUserId]
      );
    } else if (bootstrapPassword) {
      console.warn("CONSOLE_BOOTSTRAP_PASSWORD is still a placeholder; password login remains disabled for the demo administrator");
    }
    await client.query(
      `INSERT INTO tenant_memberships
        (tenant_id,platform_user_id,role,status,chatwoot_user_id,chatwoot_user_email,chatwoot_account_id)
       VALUES ($1,$2,'tenant_admin','active',$3,$4,$5)
       ON CONFLICT (tenant_id,platform_user_id) DO UPDATE SET
         role=EXCLUDED.role,status='active',chatwoot_user_id=EXCLUDED.chatwoot_user_id,
         chatwoot_user_email=EXCLUDED.chatwoot_user_email,chatwoot_account_id=EXCLUDED.chatwoot_account_id,updated_at=NOW()`,
      [tenantId, platformUserId, profile.id, email, accountId]
    );
    await client.query(
      `UPDATE tenant_api_keys SET platform_user_id=$1
        WHERE tenant_id=$2 AND key_hash=$3 AND status='active'`,
      [platformUserId, tenantId, apiKeyHash(demoApiKey)]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function bootstrapDemoMembershipWithRetry(maxAttempts = 10,shouldStop:()=>boolean=()=>false): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if(shouldStop())return;
    try {
      await bootstrapDemoMembership();
      console.info("Demo identity mapping is ready");
      return;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (attempt === maxAttempts) {
        console.warn("Demo identity mapping bootstrap exhausted retries", detail);
        return;
      }
      console.warn(`Demo identity mapping bootstrap deferred (${attempt}/${maxAttempts})`, detail);
      await new Promise(resolve => setTimeout(resolve, 3_000));
    }
  }
}
