import type { Metadata } from "next";
import { ContactPage } from "../../../components/contact-page";

export const metadata: Metadata = {
  title: "Contact ReplyNest support",
  description: "Contact ReplyNest support by email or through the ReplyNest WeChat Official Account.",
  alternates: { canonical: "https://replynest.cn/en/contact", languages: { "zh-CN": "https://replynest.cn/contact", en: "https://replynest.cn/en/contact" } },
  robots: { index: true, follow: true },
};

export default function EnglishContactPage() { return <ContactPage locale="en" />; }
