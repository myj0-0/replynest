"use client";

import { useId, useState } from "react";
import type { ConsoleRole } from "../lib/console-access";
import { memberRoleInfo, memberRoles } from "../lib/member-roles";

export function MemberRoleSelect({ defaultRole = "agent", en, label, compact = false }: {
  defaultRole?: string; en: boolean; label: string; compact?: boolean;
}) {
  const [role, setRole] = useState<ConsoleRole>(memberRoles.includes(defaultRole as ConsoleRole) ? defaultRole as ConsoleRole : "agent");
  const id = useId();
  return <div className="min-w-0">
    <select name="role" value={role} aria-label={label} aria-describedby={`${id}-help`}
      onChange={event => setRole(event.target.value as ConsoleRole)}
      className={`w-full rounded-xl border border-[var(--border-subtle)] bg-white ${compact ? "px-2 py-2 text-xs" : "px-3 py-2.5"}`}>
      {memberRoles.map(item => <option key={item} value={item}>{memberRoleInfo(item, en).label}</option>)}
    </select>
    <p id={`${id}-help`} aria-live="polite" className="mt-2 text-xs leading-5 text-[var(--ink-500)]">{memberRoleInfo(role, en).summary}</p>
  </div>;
}
