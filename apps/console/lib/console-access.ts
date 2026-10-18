// Presentation policy only. Gateway authorization remains authoritative.
export type ConsoleRole = "tenant_admin" | "supervisor" | "agent";
const roles: readonly string[] = ["tenant_admin", "supervisor", "agent"];
const matches = (path: string, base: string) => path === base || path.startsWith(base + "/");

export function canAccessConsolePath(path: string, role: string, impersonating = false): boolean {
  if (!roles.includes(role)) return false;
  if (matches(path, "/settings/activity")) return !impersonating;
  if (matches(path, "/extensions") || matches(path, "/template-market") || matches(path, "/settings/automatic-reception")) {
    return role === "tenant_admin" && !impersonating;
  }
  if (/^\/knowledge\/[^/]+\/review(?:\/|$)/.test(path) || matches(path, "/settings/members") || matches(path, "/settings/communications")) {
    return role === "tenant_admin";
  }
  if (matches(path, "/billing") || matches(path, "/referrals") || matches(path, "/notifications") || matches(path, "/operations/outbound")) {
    return role === "tenant_admin" || role === "supervisor";
  }
  return path === "/" || ["/customers", "/channels", "/knowledge", "/workbench", "/settings/privacy"].some(base => matches(path, base));
}

export function canManageConsoleFunds(role: string, impersonating = false): boolean {
  return role === "tenant_admin" && !impersonating;
}

export function canViewBillingHistory(view: string, role: string, impersonating = false): boolean {
  if (!canAccessConsolePath("/billing", role, impersonating)) return false;
  return !["reception", "template-payouts", "insights"].includes(view) || canManageConsoleFunds(role, impersonating);
}
