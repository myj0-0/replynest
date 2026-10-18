import type { Metadata } from "next";
import { ContactPage } from "../../components/contact-page";

export const metadata: Metadata = {
  title: "联系答巢客服｜ReplyNest",
  description: "通过客服邮箱或答巢AI客服助手微信公众号联系答巢 ReplyNest。",
  alternates: { canonical: "https://replynest.cn/contact", languages: { "zh-CN": "https://replynest.cn/contact", en: "https://replynest.cn/en/contact" } },
  robots: { index: true, follow: true },
};

export default function ChineseContactPage() { return <ContactPage locale="zh" />; }
