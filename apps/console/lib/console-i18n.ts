export type ConsoleLocale = "zh" | "en";

export function consoleText(locale: ConsoleLocale) {
  const en = locale === "en";
  return {
    currentWorkspace: en ? "Current workspace" : "当前企业",
    hello: en ? "Hello" : "你好",
    overview: en ? "Today’s service and operations overview" : "这是企业今天的服务与运营概况",
    openNavigation: en ? "Open navigation" : "打开导航",
    closeNavigation: en ? "Close navigation" : "关闭导航",
    closeBackdrop: en ? "Close navigation backdrop" : "关闭导航遮罩",
    mobileNavigation: en ? "Mobile navigation" : "移动端主导航",
    workbench: en ? "Open support workspace" : "进入客服工作台",
    workbenchShort: en ? "Support" : "客服",
    status: en ? "Service status" : "系统状态",
    contact: en ? "Contact support" : "联系客服",
    signOut: en ? "Sign out" : "退出登录",
    language: en ? "Language" : "语言",
    impersonation: (name: string) => en
      ? `Platform administrator ${name} is impersonating this workspace. Every request in this session is written to the platform audit log.`
      : `平台管理员 ${name} 正在身份代入；本会话全部请求均记录至平台审计日志`,
    unknownAdmin: en ? "Unknown administrator" : "未知管理员",
  };
}
