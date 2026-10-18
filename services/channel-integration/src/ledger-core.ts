import { createHash } from "node:crypto";

export const ledgerAccounts = ["cash", "gift", "referral", "ai_credit", "revenue", "clearing"] as const;
export const tenantBalanceAccounts = ["cash", "gift", "referral", "ai_credit"] as const;
export const ledgerTransactionTypes = ["opening", "topup", "charge", "refund", "gift_grant", "referral_reward", "ai_credit_grant", "expiration", "adjustment", "reversal"] as const;
export type LedgerAccount = typeof ledgerAccounts[number];
export type TenantBalanceAccount = typeof tenantBalanceAccounts[number];
export type LedgerDirection = "debit" | "credit";
export type LedgerEntryInput = { account: LedgerAccount; direction: LedgerDirection; amount_minor: number; expires_at?: string | null };
export type LedgerTransactionInput = {
  transaction_type: typeof ledgerTransactionTypes[number]; currency: string; idempotency_key: string;
  source_type: string; source_id: string; occurred_at: string; metadata?: Record<string, unknown>;
  entries: LedgerEntryInput[];
};

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (plainObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

export function validateLedgerInput(raw: unknown): LedgerTransactionInput {
  if (!plainObject(raw)) throw new Error("ledger input must be an object");
  const type = String(raw.transaction_type ?? "") as LedgerTransactionInput["transaction_type"];
  const currency = String(raw.currency ?? "").toUpperCase();
  const idempotencyKey = String(raw.idempotency_key ?? "").trim();
  const sourceType = String(raw.source_type ?? "").trim();
  const sourceId = String(raw.source_id ?? "").trim();
  const occurredAt = String(raw.occurred_at ?? "");
  if (!ledgerTransactionTypes.includes(type) || type === "reversal") throw new Error("invalid ledger transaction type");
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("invalid ledger currency");
  if (!idempotencyKey || idempotencyKey.length > 128) throw new Error("invalid ledger idempotency key");
  if (!sourceType || sourceType.length > 64 || !sourceId || sourceId.length > 200) throw new Error("invalid ledger source");
  if (!Number.isFinite(Date.parse(occurredAt))) throw new Error("invalid ledger occurrence time");
  const metadata = raw.metadata === undefined ? {} : raw.metadata;
  if (!plainObject(metadata) || Buffer.byteLength(JSON.stringify(metadata), "utf8") > 4096) throw new Error("invalid ledger metadata");
  if (!Array.isArray(raw.entries) || raw.entries.length < 2 || raw.entries.length > 20) throw new Error("ledger transaction requires 2-20 entries");
  let debit = 0;
  let credit = 0;
  const entries = raw.entries.map((item): LedgerEntryInput => {
    if (!plainObject(item)) throw new Error("invalid ledger entry");
    const account = String(item.account ?? "") as LedgerAccount;
    const direction = String(item.direction ?? "") as LedgerDirection;
    const amount = Number(item.amount_minor);
    const expiresAt = item.expires_at === undefined || item.expires_at === null ? null : String(item.expires_at);
    if (!ledgerAccounts.includes(account) || !["debit", "credit"].includes(direction)) throw new Error("invalid ledger account or direction");
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("ledger amount must be a positive safe integer");
    if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || direction !== "credit" || !["gift", "referral", "ai_credit"].includes(account))) throw new Error("invalid ledger entitlement expiry");
    if (direction === "debit") debit += amount; else credit += amount;
    if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit)) throw new Error("ledger total exceeds safe integer range");
    return { account, direction, amount_minor: amount, expires_at: expiresAt };
  });
  if (debit <= 0 || debit !== credit) throw new Error("ledger transaction must balance");
  return { transaction_type: type, currency, idempotency_key: idempotencyKey, source_type: sourceType, source_id: sourceId, occurred_at: new Date(occurredAt).toISOString(), metadata: stable(metadata) as Record<string, unknown>, entries };
}

export function ledgerRequestHash(input: LedgerTransactionInput): string {
  return createHash("sha256").update(JSON.stringify(stable(input))).digest("hex");
}

export function reverseLedgerEntries(entries: LedgerEntryInput[]): LedgerEntryInput[] {
  return entries.map(entry => ({ ...entry, direction: entry.direction === "credit" ? "debit" : "credit", expires_at: null }));
}

export function balanceDelta(account: LedgerAccount, direction: LedgerDirection, amountMinor: number): number {
  if (!(tenantBalanceAccounts as readonly string[]).includes(account)) return 0;
  return direction === "credit" ? amountMinor : -amountMinor;
}
