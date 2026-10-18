import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://console.replynest.cn"),
  title: "ReplyNest / 答巢 · 运营中心",
  description: "微信公众号优先的智能客服 SaaS 运营控制台",
  robots: { index: false, follow: false },
  icons: { icon: "/replynest-mark.png", apple: "/pwa/apple-touch-icon.png" },
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "ReplyNest", statusBarStyle: "default" },
};

export const viewport: Viewport = { themeColor: "#1687f8", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
