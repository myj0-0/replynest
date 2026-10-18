import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { postJson, readBody, requiredEnv, sendJson, signature } from "./shared.js";

const port = Number(process.env.PORT ?? 3100);
const gatewayUrl = process.env.GATEWAY_URL ?? "http://channel-gateway:3001/webhooks/wechat";
const signingSecret = requiredEnv("MOCK_WECHAT_SECRET");
const outbound = new Map<string, unknown>();

const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Mock 微信</title>
<style>body{font:16px system-ui;max-width:820px;margin:40px auto;padding:0 20px;color:#17202a}form,section{border:1px solid #dfe6e9;border-radius:12px;padding:20px;margin:18px 0}label{display:block;margin:10px 0 4px}input,textarea{box-sizing:border-box;width:100%;padding:10px}button{margin-top:12px;padding:10px 18px;background:#07c160;color:white;border:0;border-radius:8px}pre{white-space:pre-wrap;background:#f5f6f7;padding:12px;border-radius:8px}</style></head>
<body><h1>Mock 微信渠道</h1><p>模拟微信用户向 Chatwoot 发消息，并查看客服回复。</p><form id="form"><label>用户 ID</label><input name="user_id" value="wx-demo-user"><label>昵称</label><input name="user_name" value="演示客户"><label>消息</label><textarea name="text">你好，我想咨询订单进度。</textarea><button>发送到 Chatwoot</button></form><section><h2>执行结果</h2><pre id="result">等待发送</pre></section><section><h2>客服回复</h2><button id="refresh" type="button">刷新回复</button><pre id="messages">[]</pre></section>
<script>const result=document.querySelector('#result'),messages=document.querySelector('#messages');async function refresh(){messages.textContent=JSON.stringify(await(await fetch('/messages')).json(),null,2)}document.querySelector('#refresh').onclick=refresh;document.querySelector('#form').onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.target));const r=await fetch('/simulate/inbound',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});result.textContent=JSON.stringify(await r.json(),null,2);await refresh()};refresh();setInterval(refresh,3000)</script></body></html>`;

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return response.end(page);
    }
    if (request.method === "GET" && url.pathname === "/health") return sendJson(response, 200, { status: "ok", service: "mock-wechat" });
    if (request.method === "GET" && url.pathname === "/messages") return sendJson(response, 200, [...outbound.values()]);
    if (request.method === "POST" && url.pathname === "/messages") {
      const payload = JSON.parse((await readBody(request)).toString("utf8"));
      if (!payload.message_id || !payload.user_id) return sendJson(response, 400, { error: "invalid_payload" });
      const duplicate = outbound.has(String(payload.message_id));
      outbound.set(String(payload.message_id), { ...payload, received_at: new Date().toISOString() });
      return sendJson(response, 200, { ok: true, duplicate });
    }
    if (request.method === "POST" && url.pathname === "/simulate/inbound") {
      const input = JSON.parse((await readBody(request)).toString("utf8"));
      if (!input.user_id || !input.text) return sendJson(response, 400, { error: "user_id_and_text_required" });
      const eventId = input.event_id ?? randomUUID();
      const messageId = input.message_id ?? randomUUID();
      const payload = { event_id: eventId, message_id: messageId, user_id: input.user_id, user_name: input.user_name, text: input.text, occurred_at: new Date().toISOString() };
      const raw = Buffer.from(JSON.stringify(payload));
      const timestamp = String(Date.now());
      const nonce = randomUUID();
      const gateway = await postJson(gatewayUrl, payload, {
        "x-wechat-timestamp": timestamp,
        "x-wechat-nonce": nonce,
        "x-wechat-signature": signature(signingSecret, timestamp, nonce, raw)
      });
      return sendJson(response, 202, { ok: true, event_id: eventId, message_id: messageId, gateway });
    }
    return sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    console.error(error);
    return sendJson(response, 502, { error: "upstream_error", detail: error instanceof Error ? error.message : String(error) });
  }
});
server.listen(port, "0.0.0.0", () => console.log(`mock-wechat listening on ${port}`));
