export const publicLocales = ["zh", "en"] as const;
export type PublicLocale = (typeof publicLocales)[number];

export const publicLocale = {
  zh: { htmlLang: "zh-CN", home: "/", privacy: "/legal/privacy", terms: "/legal/terms", label: "中文" },
  en: { htmlLang: "en", home: "/en", privacy: "/en/legal/privacy", terms: "/en/legal/terms", label: "English" },
} as const;

export const replyNestOperator = {
  registeredNameZh: "您的服务运营主体",
  displayNameEn: "Your service operator",
  registeredAddressZh: "请填写您的服务运营地址",
  registeredAddressEn: "Configure your service operator address",
  supportEmail: "support@fs.replynest.cn",
  supportWechatOfficialAccount: "答巢AI客服助手",
} as const;
