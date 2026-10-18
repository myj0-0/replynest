export type TenantRole = "tenant_admin" | "supervisor" | "agent";
export type PlatformRole = "owner" | "admin" | "support" | "auditor";

export type Permission =
  | "tenant.members.read"
  | "tenant.members.manage"
  | "tenant.billing.read"
  | "platform.dashboard.read"
  | "platform.tenants.read"
  | "platform.orders.read"
  | "platform.finance.read"
  | "platform.settings.read"
  | "platform.queues.read"
  | "platform.audit.read"
  | "platform.admins.manage"
  | "platform.subscriptions.manage"
  | "platform.registration.read"
  | "platform.registration.manage"
  | "platform.campaigns.read"
  | "platform.privacy.read"
  | "platform.privacy.manage"
  | "platform.impersonation.start";

const tenantPermissions: Record<TenantRole, ReadonlySet<Permission>> = {
  tenant_admin: new Set(["tenant.members.read", "tenant.members.manage", "tenant.billing.read"]),
  supervisor: new Set(["tenant.billing.read"]),
  agent: new Set(),
};

const platformReadPermissions: Permission[] = [
  "platform.dashboard.read", "platform.tenants.read", "platform.orders.read",
  "platform.finance.read", "platform.settings.read", "platform.queues.read", "platform.audit.read",
  "platform.registration.read", "platform.campaigns.read", "platform.privacy.read",
];

const platformPermissions: Record<PlatformRole, ReadonlySet<Permission>> = {
  owner: new Set([...platformReadPermissions, "platform.admins.manage", "platform.subscriptions.manage", "platform.registration.manage", "platform.privacy.manage", "platform.impersonation.start"]),
  admin: new Set([...platformReadPermissions, "platform.subscriptions.manage", "platform.registration.manage", "platform.privacy.manage", "platform.impersonation.start"]),
  support: new Set(["platform.dashboard.read", "platform.tenants.read", "platform.orders.read", "platform.queues.read", "platform.audit.read", "platform.registration.read", "platform.privacy.read", "platform.impersonation.start"]),
  auditor: new Set(platformReadPermissions),
};

export type Principal = { domain: "tenant"; role: TenantRole } | { domain: "platform"; role: PlatformRole };

export function hasPermission(principal: Principal, permission: Permission): boolean {
  return principal.domain === "tenant"
    ? tenantPermissions[principal.role].has(permission)
    : platformPermissions[principal.role].has(permission);
}
