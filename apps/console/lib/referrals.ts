import { gatewayUrl } from "./console-session";

export type ReferralOverview = {
  growth_policy?:{first_bps:number;repeat_bps:number;invitee_gift_minor:number;observation_days:number};
  commissions?:{commission_id:string;payment_kind:string;cash_minor:string;rate_bps:number;amount_minor:string;retained_minor:string|null;status:string}[];
  campaign: null | { campaign_key: string; version: number; name: string; starts_at: string; ends_at: string; qualification_rule: { min_first_cash_payment_minor: number; observation_days: number } };
  inviter_eligibility: null | { eligible: boolean; reason_codes: string[];access_mode?:'partner'|'standard' };
  invite_code: null | { invite_code: string; created_at: string };
  statistics: Record<"attributed" | "pending" | "review" | "qualified" | "rejected" | "revoked", number>;
};

export async function fetchReferrals(token: string, includeHistory = false): Promise<ReferralOverview | undefined> {
  try {
    const response = await fetch(gatewayUrl("/api/v1/growth/referrals"+(includeHistory?'':'?view=summary')), { headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return undefined;
    return (await response.json() as { data: ReferralOverview }).data;
  } catch { return undefined; }
}
