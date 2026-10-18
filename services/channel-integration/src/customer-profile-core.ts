export type CustomerProfileInput = { name: string; email: string; phone: string; note: string; revision: string };
export function validateCustomerProfile(value: unknown): CustomerProfileInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["name", "email", "phone", "note", "revision"].includes(key))) return null;
  if (!["name", "email", "phone", "note", "revision"].every(key => typeof input[key] === "string")) return null;
  const data = Object.fromEntries(Object.entries(input).map(([key, text]) => [key, (text as string).trim()])) as CustomerProfileInput;
  if (!data.name || data.name.length > 200 || data.email.length > 320 || data.phone.length > 64 || data.note.length > 5000 || !/^\d{1,20}$/.test(data.revision)) return null;
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) return null;
  return data;
}
export function canEditCustomerProfile(role: string, actor: string, assignee: string | null) {
  return ["tenant_admin", "supervisor"].includes(role) || (role === "agent" && actor === assignee);
}
