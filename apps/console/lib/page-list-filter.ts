/** Client-side filtering only over the supplied bounded page; never fetches other pages. */
export function filterPageItems<T>(items: T[], keyword: string, fields: (item: T) => string[]): T[] {
  const term = keyword.trim().toLocaleLowerCase();
  return term ? items.filter(item => fields(item).some(value => value.toLocaleLowerCase().includes(term))) : items;
}

export const privacyTerminalStatuses = new Set(['fulfilled', 'partially_fulfilled', 'rejected', 'cancelled']);
export function privacyProgress(status: string): number | null {
  return ({submitted: 0, identity_verification: 1, in_review: 2, fulfilled: 3, partially_fulfilled: 3, rejected: 3, cancelled: 3} as Record<string, number>)[status] ?? null;
}
