import type { ConsoleRole } from "./console-access";

export const memberRoles: readonly ConsoleRole[] = ["agent", "supervisor", "tenant_admin"];

// Describe existing permissions only; the gateway still authorizes every action.
const copy = {
  zh: {
    agent: {
      label: "人工客服",
      summary: "接待客户、使用知识与快捷回复；不管理企业或资金。",
      permissions: [
        "在客服工作台处理有权限的会话：回复、便笺、领取未分配会话及更新自己负责的会话状态。",
        "查看客户、渠道状态和知识库，使用快捷回复；可暂停客户自动接待 10 分钟或提前恢复。"
      ],
      restriction: "不能转派给其他坐席、管理成员或企业配置，也不能查看账务和操作资金。"
    },
    supervisor: {
      label: "客服主管",
      summary: "协作接待与转派、管理快捷回复、查看运营与账务；不操作资金。",
      permissions: [
        "具备人工客服的接待能力，另可转派会话、调整会话状态和管理快捷回复。",
        "查看通知、消息活动、账务和邀请奖励；可创建群发草稿、准备受众。"
      ],
      restriction: "不能批准或调度群发、购买或提现；不能管理成员、渠道配置、发布知识或管理 AI 定制工坊。部分账务明细仅管理员本人可查看。"
    },
    tenant_admin: {
      label: "企业管理员",
      summary: "管理本企业成员、渠道、知识、AI 与资金；敏感操作仍需确认。",
      permissions: [
        "具备主管的接待能力，另可邀请成员、调整角色、管理渠道与企业设置、审核发布知识。",
        "管理 AI 接待授权、AI 定制工坊和模板市场；充值、购买、申请退款或提现，批准及调度群发。"
      ],
      restriction: "仅管理本企业，不是答巢平台管理员。AI、资金及发送操作仍受授权、审批和套餐条件限制。"
    }
  },
  en: {
    agent: {
      label: "Agent",
      summary: "Serve customers and use knowledge and quick replies; no company or financial management.",
      permissions: [
        "Handle permitted conversations: replies, notes, claiming unassigned conversations and updating the status of your assigned conversations.",
        "View customers, channel status and knowledge; use quick replies. Pause a customer's automatic reception for 10 minutes or resume early."
      ],
      restriction: "Cannot assign to other agents, manage members or company settings, or access billing and financial actions."
    },
    supervisor: {
      label: "Supervisor",
      summary: "Coordinate reception, assignments and quick replies; view operations and billing without financial actions.",
      permissions: [
        "Includes agent reception capabilities, plus conversation assignments, status updates and quick-reply management.",
        "View notifications, campaigns, billing and referral rewards; create campaign drafts and prepare audiences."
      ],
      restriction: "Cannot approve or schedule campaigns, purchase or withdraw, manage members or channel settings, publish knowledge, or manage AI Studio. Some billing details require the administrator's own session."
    },
    tenant_admin: {
      label: "Workspace admin",
      summary: "Manage this company's members, channels, knowledge, AI and funds; sensitive actions still need confirmation.",
      permissions: [
        "Includes supervisor reception capabilities, plus member invitations, role changes, channel and company settings, and knowledge review and publishing.",
        "Manage AI reception authorization, AI Studio and the template market; top up, purchase, request refunds or withdrawals, approve and schedule campaigns."
      ],
      restriction: "Manages this company only, not the ReplyNest platform. AI, financial and sending actions remain subject to authorization, approval and plan requirements."
    }
  }
} as const;

export function memberRoleInfo(role: ConsoleRole, en: boolean) {
  return copy[en ? "en" : "zh"][role];
}

export function memberRoleLabel(role: string, en: boolean): string {
  return memberRoles.includes(role as ConsoleRole) ? memberRoleInfo(role as ConsoleRole, en).label : (en ? "Unknown role" : "未知角色");
}
