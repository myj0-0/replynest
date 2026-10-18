import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified=new Date("2026-09-15T00:00:00+08:00");
  return [
    { url: "https://replynest.cn/", lastModified, changeFrequency: "weekly", priority: 1 },
    { url: "https://replynest.cn/en", lastModified, changeFrequency: "weekly", priority: .8 },
    { url: "https://replynest.cn/contact", lastModified, changeFrequency: "monthly", priority: .6 },
    { url: "https://replynest.cn/en/contact", lastModified, changeFrequency: "monthly", priority: .5 },
    { url: "https://replynest.cn/legal/privacy", lastModified, changeFrequency: "monthly", priority: .5 },
    { url: "https://replynest.cn/legal/terms", lastModified, changeFrequency: "monthly", priority: .5 },
    { url: "https://replynest.cn/en/legal/privacy", lastModified, changeFrequency: "monthly", priority: .4 },
    { url: "https://replynest.cn/en/legal/terms", lastModified, changeFrequency: "monthly", priority: .4 },
  ];
}
