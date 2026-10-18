import { gatewayUrl } from "./console-session";

export type TrialBenefit = { trial_days: number; grace_days: number; seat_limit: number; message_limit: number; knowledge_bytes: number; features: string[]; grants: Array<{ account: "gift" | "ai_credit"; currency: string; amount_minor: number }> };
export type TrialOverview = {
  campaign: null | { campaign_key: string; version: number; name: string; starts_at: string; ends_at: string; benefit: TrialBenefit };
  eligibility: null | { outcome: "eligible" | "review" | "rejected"; reason_codes: string[] };
  entitlement: null | { entitlement_id: string; status: "provisioning" | "active" | "expired" | "revoked" | "converted"; starts_at: string; ends_at: string; grace_ends_at: string; campaign_version: number; benefit_snapshot: TrialBenefit };
  server_time: string;
};

export async function fetchTrial(token: string): Promise<TrialOverview | undefined> {
  try {
    const response = await fetch(gatewayUrl("/api/v1/growth/trial"), { headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return undefined;
    return (await response.json() as { data: TrialOverview }).data;
  } catch { return undefined; }
}
