import { MailPlus, ShieldCheck, UserRoundCog } from "lucide-react";
import { redirect } from "next/navigation";
import { ConsoleAccessDenied } from "../../../components/console-access-denied";
import { fetchConsoleSession, gatewayUrl, sessionToken } from "../../../lib/console-session";
import { ConsoleShell } from "../../../components/console-shell";
import { getConsoleLocale } from "../../../lib/console-locale-server";
import { memberErrorMessage } from "../../../lib/member-errors";
import { memberRoleInfo, memberRoleLabel, memberRoles } from "../../../lib/member-roles";
import { MemberRoleSelect } from "../../../components/member-role-select";

export const dynamic = "force-dynamic";

type Member = {
  platform_user_id: string;
  email: string;
  display_name: string;
  role: string;
  status: string;
  chatwoot_sync_status: string;
  chatwoot_sync_error?: string;
};

type Invitation = {
  invitation_id: string;
  email: string;
  display_name: string;
  role: string;
  expires_at: string;
};

export default async function MembersPage({
  searchParams
}: {
  searchParams: Promise<{ status?: string; error?: string }>;
}) {
  const session = await fetchConsoleSession();
  const locale = await getConsoleLocale();
  const en = locale === "en";
  const token = await sessionToken();
  if (!session || !token) redirect("/login?error=expired");

  const workspace = session.workspaces.find(item => item.tenant_id === session.selected_tenant_id);
  if (!workspace) redirect("/workspaces");
  if (workspace.role !== "tenant_admin") return <ConsoleAccessDenied session={session} workspace={workspace} activePath="/settings/members"/>;

  const upstream = await fetch(gatewayUrl("/api/v1/members"), {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store"
  });
  if (upstream.status === 401) redirect("/login?error=expired");

  const body = await upstream.json() as { data?: { members: Member[]; invitations: Invitation[]; capacity?: { limit: number | null; active: number; pending: number } } };
  const params = await searchParams;

  return (
    <ConsoleShell session={session} workspace={workspace} activePath="/settings/members" statusPageUrl={process.env.STATUS_PUBLIC_URL ?? "http://localhost:3300"}><main className="mx-auto min-h-screen max-w-5xl p-4 md:p-8">
      <div className="flex items-start gap-3">
        <div className="grid size-11 place-items-center rounded-2xl bg-[var(--brand-50)] text-[var(--brand-700)]">
          <UserRoundCog size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">{en ? "Team & members" : "团队与成员"}</h1>
          <p className="mt-1 text-sm text-[var(--ink-500)]">{workspace.tenant_name} · {en ? "Manage team members and access permissions" : "管理团队成员与访问权限"}</p>
        </div>
      </div>

      {params.status === "invited" && <div className="mt-5 rounded-xl bg-green-50 px-4 py-3 text-sm text-green-700">{en ? "Invitation email sent." : "邀请邮件已发送。"}</div>}
      {params.status === "revoked" && <div role="status" className="mt-5 rounded-xl bg-green-50 px-4 py-3 text-sm text-green-700">{en ? "Invitation revoked. Its link no longer works and its reserved seat is released." : "邀请已撤销，原邀请链接已失效，预留坐席名额已释放。"}</div>}
      {params.error && <div role="alert" className="mt-5 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{memberErrorMessage(params.error, en)}</div>}

      <details open={!!params.error} className="mt-6 rounded-2xl border border-[var(--border-subtle)] bg-white p-5 shadow-[var(--shadow-card)]">
        <summary className="flex cursor-pointer items-center gap-2 font-semibold"><MailPlus size={18} />{en ? "Invite a member" : "邀请成员"}</summary>
        <p className="mt-2 text-sm text-[var(--ink-500)]">{en ? "Invite any valid email address, including QQ and 163. Members do not need the same email domain." : "支持 QQ、163、企业邮箱等不同域名的有效邮箱，无需与管理员邮箱同域。"}</p>
        {body.data?.capacity && <p className="mt-2 text-sm text-[var(--ink-500)]">{en ? `Seats: ${body.data.capacity.active} active + ${body.data.capacity.pending} pending / ${body.data.capacity.limit ?? "unlimited"}. Pending invitations reserve a seat until accepted, revoked or expired.` : `坐席占用：已启用 ${body.data.capacity.active} + 待接受邀请 ${body.data.capacity.pending} / ${body.data.capacity.limit ?? "不限"}。待接受邀请会预留名额，撤销或到期后释放。`}</p>}
        <form action="/api/members/invite" method="post" className="mt-4 grid items-start gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_210px_auto]">
          <input name="display_name" required placeholder={en ? "Member name" : "成员姓名"} className="min-w-0 rounded-xl border border-[var(--border-subtle)] px-3 py-2.5" />
          <input name="email" type="email" required placeholder="member@example.com" className="min-w-0 rounded-xl border border-[var(--border-subtle)] px-3 py-2.5" />
          <MemberRoleSelect en={en} label={en ? "Invitation role" : "邀请成员角色"} />
          <button className="rounded-xl bg-[var(--brand-500)] px-4 py-2.5 text-sm font-semibold text-white">{en ? "Send invitation" : "发送邀请"}</button>
        </form>
      </details>

      <details aria-labelledby="member-role-guide" className="mt-6 rounded-2xl border border-[var(--border-subtle)] bg-white p-5 shadow-[var(--shadow-card)]">
        <summary id="member-role-guide" className="flex items-center gap-2 font-semibold"><ShieldCheck size={18} />{en ? "Role permissions" : "角色与权限"}</summary>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {memberRoles.map(role => {
            const info = memberRoleInfo(role, en);
            return <div key={role} className="rounded-xl bg-slate-50 p-4">
              <h3 className="font-semibold">{info.label}</h3>
              <ul className="mt-3 list-disc space-y-2 pl-4 text-sm leading-6">{info.permissions.map(text => <li key={text}>{text}</li>)}</ul>
              <p className="mt-3 text-xs leading-5 text-[var(--ink-500)]">{info.restriction}</p>
            </div>;
          })}
        </div>
        <p className="mt-3 text-xs leading-5 text-[var(--ink-500)]">{en ? "Available features depend on your plan and channel. Marketing broadcasts require a Professional plan and an independent official account; shared channels cannot broadcast." : "可用功能以套餐及渠道条件为准。营销群发仅限专业版独立公众号，共享渠道不支持群发。"}</p>
      </details>

      <section className="mt-5 overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-white shadow-[var(--shadow-card)]">
        <div className="border-b border-[var(--border-subtle)] p-5 font-semibold">{en ? "Current members" : "当前成员"}</div>
        <div className="divide-y divide-[var(--border-subtle)]">
          {body.data?.members.map(member => {
            const isCurrent = member.platform_user_id === session.user.id;
            const syncFailed = member.chatwoot_sync_status === "failed";
            const nextStatus = syncFailed ? member.status : member.status === "active" ? "disabled" : "active";
            return (
              <div key={member.platform_user_id} className="grid gap-3 p-5 md:grid-cols-[1fr_230px_150px_auto] md:items-center">
                <div>
                  <p className="font-medium">{member.display_name}</p>
                  <p className="mt-1 text-xs text-[var(--ink-500)]">{member.email}</p>
                </div>
                {isCurrent ? (
                  <div className="text-sm">{memberRoleLabel(member.role, en)}</div>
                ) : (
                  <form action={`/api/members/${member.platform_user_id}`} method="post" className="grid grid-cols-[1fr_auto] items-start gap-2">
                    <MemberRoleSelect defaultRole={member.role} en={en} compact label={`${member.display_name} ${en ? "role" : "角色"}`} />
                    <button className="rounded-lg border border-[var(--border-subtle)] px-2 py-2 text-xs">{en ? "Update" : "更新"}</button>
                  </form>
                )}
                <div className="text-xs" title={member.chatwoot_sync_error}>
                  <span className={`rounded-full px-2 py-1 ${member.chatwoot_sync_status === "synced" ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"}`}>
                    {member.status} · {member.chatwoot_sync_status}
                  </span>
                </div>
                {isCurrent ? (
                  <span className="text-xs text-[var(--ink-500)]">{en ? "Current account" : "当前账号"}</span>
                ) : (
                  <form action={`/api/members/${member.platform_user_id}`} method="post" className="flex gap-2">
                    <input type="hidden" name="status" value={nextStatus} />
                    <button className="rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-xs font-medium">
                      {syncFailed ? (en ? "Retry sync" : "重试同步") : member.status === "active" ? (en ? "Disable" : "禁用") : (en ? "Enable again" : "重新启用")}
                    </button>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {Boolean(body.data?.invitations.length) && (
        <section className="mt-5 rounded-2xl border border-[var(--border-subtle)] bg-white p-5 shadow-[var(--shadow-card)]">
          <div className="flex items-center gap-2 font-semibold"><ShieldCheck size={18} />{en ? "Pending invitations" : "待接受邀请"}</div>
          <div className="mt-4 space-y-3">
            {body.data?.invitations.map(item => (
              <div key={item.invitation_id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 px-4 py-3">
                <div>
                  <p className="text-sm font-medium">{item.display_name}</p>
                  <p className="mt-1 break-all text-xs text-[var(--ink-500)]">{item.email} · {memberRoleLabel(item.role, en)}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-[var(--ink-500)]">{en ? "Expires" : "到期时间"}：{new Date(item.expires_at).toLocaleString(en ? "en-US" : "zh-CN", { timeZone: "Asia/Shanghai" })}</span>
                  <form action={`/api/members/invitations/${item.invitation_id}/revoke`} method="post">
                    <button aria-label={`${en ? "Revoke invitation for" : "撤销邀请"} ${item.email}`} className="rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-xs font-medium">{en ? "Revoke invitation" : "撤销邀请"}</button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </main></ConsoleShell>
  );
}
