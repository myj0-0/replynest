export function websiteOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password || url.hostname === "localhost" || !url.hostname.includes(".")) return null; return url.origin; } catch { return null; }
}
export function webChatInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const origin = websiteOrigin(input.website_url);
  if (!origin || typeof input.display_name !== "string" || !input.display_name.trim() || input.display_name.length > 80 || Object.keys(input).some(key => !["website_url", "display_name"].includes(key))) return null;
  return { website_url: origin, display_name: input.display_name.trim() };
}
export function widgetLoader(baseUrl: string, token: string) {
  const literal = (value: string) => JSON.stringify(value).replace(/</g, "\\u003c");
  return `(()=>{if(window.__replynestWidgetLoading)return;window.__replynestWidgetLoading=true;const base=${literal(new URL(baseUrl).origin)},token=${literal(token)};window.chatwootSettings={position:'right',type:'standard',locale:(document.documentElement.lang||navigator.language||'en').toLowerCase().startsWith('zh')?'zh_CN':'en',useBrowserLanguage:true};const s=document.createElement('script');s.src=base+'/packs/js/sdk.js';s.async=true;s.onload=()=>{if(window.chatwootSDK)window.chatwootSDK.run({websiteToken:token,baseUrl:base});};s.onerror=()=>{window.__replynestWidgetLoading=false;};document.head.appendChild(s);})();`;
}
