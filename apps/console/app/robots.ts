import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/copilot", "/notifications", "/operations/", "/settings/", "/workspaces"] }, sitemap: "https://replynest.cn/sitemap.xml", host: "https://replynest.cn" };
}
