// The existing JSON request snapshot carries versioned scheduling metadata.
// It is stripped before storing effective entitlements, so it never grants capacity.
export type ManualValidity = { version: 1; days: number | null };
export function manualValidity(mode: unknown = 'days', days: unknown = 30): ManualValidity {
  if (mode === 'unlimited') return { version: 1, days: null };
  if (mode !== 'days' || !/^[1-9]\d{0,3}$/.test(String(days))) throw new Error('invalid_subscription_validity');
  const value = Number(days);
  if (value > 3650) throw new Error('invalid_subscription_validity');
  return { version: 1, days: value };
}
export function snapshotValidity(snapshot: unknown): ManualValidity | undefined {
  const raw = (snapshot as Record<string, unknown> | null)?.manual_validity;
  // Old pending requests retain their original indefinite scheduling policy.
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid_subscription_validity');
  const value = raw as Record<string, unknown>;
  if (value.version !== 1) throw new Error('invalid_subscription_validity');
  return manualValidity(value.days === null ? 'unlimited' : 'days', value.days);
}
