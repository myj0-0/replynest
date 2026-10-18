/** @type {import('@docusaurus/types').Config} */
const config = {
  title: "答巢帮助中心",
  tagline: "ReplyNest Help Center",
  favicon: "img/replynest-mark.png",
  url: "https://docs.replynest.cn",
  baseUrl: "/",
  onBrokenLinks: "throw",
  i18n: {
    defaultLocale: "zh-Hans",
    locales: ["zh-Hans", "en"],
    localeConfigs: {
      "zh-Hans": { label: "简体中文", htmlLang: "zh-CN" },
      en: { label: "English", htmlLang: "en" },
    },
  },
  presets: [["classic", {
    docs: { routeBasePath: "/", sidebarPath: require.resolve("./sidebars.js") },
    blog: false,
    theme: { customCss: require.resolve("./src/css/custom.css") },
  }]],
  themeConfig: {
    colorMode: { defaultMode: "light", respectPrefersColorScheme: true },
    navbar: {
      title: "答巢帮助中心",
      logo: { alt: "答巢 ReplyNest", src: "img/replynest-brand-cn.png" },
      items: [
        { type: "docSidebar", sidebarId: "helpSidebar", position: "left", label: "使用指南" },
        { href: "https://console.replynest.cn/", label: "运营控制台", position: "right" },
        { href: "https://replynest.cn/contact", label: "联系客服", position: "right" },
        { href: "https://status.replynest.cn/", label: "系统状态", position: "right" },
        { type: "localeDropdown", position: "right" },
      ],
    },
    footer: {
      style: "light",
      links: [{ title: "ReplyNest", items: [
        { label: "官网", href: "https://replynest.cn/" },
        { label: "联系客服", href: "https://replynest.cn/contact" },
        { label: "隐私政策", href: "https://replynest.cn/legal/privacy" },
        { label: "服务协议", href: "https://replynest.cn/legal/terms" },
      ] }],
      copyright: `© ${new Date().getFullYear()} 您的服务运营主体`,
    },
  },
};

export default config;
