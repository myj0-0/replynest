import { Blocks, BookOpen, ContactRound, BellRing, PlugZap, Settings, ShieldCheck, UsersRound, WalletCards, UserRoundPlus, Megaphone, Code2, FileText } from "lucide-react";
import type { ReactNode } from "react";

const icons = { blocks: Blocks, knowledge: BookOpen, customers: ContactRound, notifications: BellRing, channels: PlugZap, settings: Settings, privacy: ShieldCheck, members: UsersRound, billing: WalletCards, referrals: UserRoundPlus, campaigns: Megaphone, api: Code2, document: FileText };
export function ConsolePageHeading({ icon, children }: { icon: keyof typeof icons; children: ReactNode }) {
  const Icon = icons[icon];
  return <h1 className="console-page-heading flex items-center gap-3 text-2xl font-semibold text-[var(--ink-900)]"><span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-2xl bg-[var(--brand-50)] text-[var(--brand-700)]"><Icon size={22}/></span><span>{children}</span></h1>;
}
