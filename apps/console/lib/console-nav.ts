import type { LucideIcon } from "lucide-react";
import { BellRing, Bot, Blocks, ContactRound, Gauge, LibraryBig, Megaphone, PlugZap, Settings, ShieldCheck, UserRoundPlus, UsersRound, WalletCards } from "lucide-react";

export type ConsoleNavItem = { label: string; icon: LucideIcon; href: string };
export const consoleNavItems: ConsoleNavItem[] = [
  { label: "home", icon: Gauge, href: "/" },
  { label: "channels", icon: PlugZap, href: "/channels" },
  { label: "customers", icon: ContactRound, href: "/customers" },
  { label: "campaigns", icon: Megaphone, href: "/operations/outbound" },
  { label: "notifications", icon: BellRing, href: "/notifications" },
  { label: "reception", icon: Bot, href: "/settings/automatic-reception" },
  { label: "knowledge", icon: LibraryBig, href: "/knowledge" },
  { label: "extensions", icon: Blocks, href: "/extensions" },
  { label: "templateMarket", icon: LibraryBig, href: "/template-market" },
  { label: "members", icon: UsersRound, href: "/settings/members" },
  { label: "settings", icon: Settings, href: "/settings/communications" },
  { label: "privacy", icon: ShieldCheck, href: "/settings/privacy" },
  { label: "activity", icon: ShieldCheck, href: "/settings/activity" },
  { label: "billing", icon: WalletCards, href: "/billing" },
  { label: "referrals", icon: UserRoundPlus, href: "/referrals" },
];

export const consoleNavLabels: Record<string, { zh: string; en: string }> = {
  home: { zh: "首页", en: "Home" },
  channels: { zh: "渠道与接入", en: "Channels" },
  customers: { zh: "客户运营", en: "Customers" },
  campaigns: { zh: "消息与活动", en: "Messages & campaigns" },
  notifications: { zh: "通知中心", en: "Notifications" },
  knowledge: { zh: "知识库", en: "Knowledge base" },
  extensions: { zh: "AI 定制工坊", en: "AI Custom Studio" },
  templateMarket: { zh: "模板市场", en: "Template market" },
  members: { zh: "团队与成员", en: "Team & members" },
  settings: { zh: "企业设置", en: "Workspace settings" },
  reception: { zh: "AI 接待", en: "AI reception" },
  privacy: { zh: "隐私与账号", en: "Privacy & account" },
  activity: { zh: "账号安全日志", en: "Security activity" },
  billing: { zh: "套餐与账务", en: "Plans & billing" },
  referrals: { zh: "邀请有礼", en: "Referrals" },
};

export const consoleNavGroups = [
  { id: 'service', zh: '客服运营', en: 'Customer service', labels: ['home', 'channels', 'customers', 'campaigns', 'notifications'] },
  { id: 'ai', zh: 'AI 与知识', en: 'AI & knowledge', labels: ['reception', 'knowledge', 'extensions', 'templateMarket'] },
  { id: 'organization', zh: '组织与安全', en: 'Organization & security', labels: ['members', 'settings', 'privacy', 'activity'] },
  { id: 'billing', zh: '套餐与增长', en: 'Billing & growth', labels: ['billing', 'referrals'] },
] as const;

export function consoleNavGroupFor(label: string) {
  return consoleNavGroups.find(group => (group.labels as readonly string[]).includes(label))!;
}

export function isConsoleNavActive(href: string, activePath: string) {
  return href === activePath || (href !== '/' && activePath.startsWith(href + '/'));
}
