import Script from "next/script";
export default async function WebChatPreview({ searchParams }: { searchParams: Promise<{ site?: string }> }) {
  const { site } = await searchParams;
  if (!site || !/^[0-9a-f-]{36}$/i.test(site)) return <main className="p-8">Invalid website identifier / 网站标识无效</main>;
  return <main className="min-h-dvh bg-slate-50 p-8"><div className="mx-auto max-w-xl rounded-2xl border bg-white p-6"><h1 className="text-xl font-semibold">ReplyNest · Website chat preview</h1><p className="mt-4 leading-7">点击右下角聊天气泡，模拟网站访客咨询。在答巢客服工作台刷新会话列表，即可查看并人工回复。</p><p className="mt-4 leading-7">Open the chat bubble below to send a visitor message. Refresh your ReplyNest support workspace to view and reply.</p><p className="mt-4 text-sm text-slate-500">这是实际会话测试，请勿填写敏感个人信息。 / This creates a real conversation. Do not enter sensitive personal information.</p></div><Script src={`/widget/${site}`} strategy="afterInteractive"/></main>;
}
