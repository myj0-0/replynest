import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "答巢 ReplyNest 客服工作台",
    short_name: "答巢",
    description: "答巢全渠道智能客服运营中心与客服工作台",
    start_url: "/?source=pwa",
    scope: "/",
    display: "standalone",
    display_override: ["window-controls-overlay", "standalone"],
    orientation: "any",
    background_color: "#f5f8fc",
    theme_color: "#1687f8",
    categories: ["business", "productivity"],
    icons: [
      { src: "/pwa/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/pwa/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "客服工作台", short_name: "工作台", description: "查看并回复客户消息", url: "/workbench?source=pwa-shortcut", icons: [{ src: "/pwa/icon-192.png", sizes: "192x192", type: "image/png" }] },
      { name: "渠道与接入", short_name: "渠道", description: "管理客服渠道", url: "/channels?source=pwa-shortcut", icons: [{ src: "/pwa/icon-192.png", sizes: "192x192", type: "image/png" }] },
      { name: "通知中心", short_name: "通知", description: "查看运营与消息提醒", url: "/notifications?source=pwa-shortcut", icons: [{ src: "/pwa/icon-192.png", sizes: "192x192", type: "image/png" }] },
    ],
  };
}
