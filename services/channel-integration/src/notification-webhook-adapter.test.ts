import assert from "node:assert/strict";
import test from "node:test";
import { publicIpAddress, sendNotificationWebhook, validateWebhookEndpoint, webhookPayload } from "./notification-webhook-adapter.js";
import { fakeWebhookResponse } from './webhook-test-transport.js';

test("provider endpoints are restricted to their official HTTPS hosts", () => {
  assert.equal(validateWebhookEndpoint("feishu", "https://open.feishu.cn/open-apis/bot/v2/hook/example").hostname, "open.feishu.cn");
  assert.equal(validateWebhookEndpoint("wecom", "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=example").hostname, "qyapi.weixin.qq.com");
  assert.equal(validateWebhookEndpoint("dingtalk", "https://oapi.dingtalk.com/robot/send?access_token=example").hostname, "oapi.dingtalk.com");
  assert.throws(() => validateWebhookEndpoint("custom", "http://example.com/hook"));
  assert.throws(() => validateWebhookEndpoint("custom", "https://127.0.0.1/hook"));
  assert.throws(() => validateWebhookEndpoint("wecom", "https://example.com/cgi-bin/webhook/send?key=x"));
});

test("private and special-use addresses are rejected", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.1.1", "::1", "fd00::1"]) {
    assert.equal(publicIpAddress(address), false, address);
  }
  assert.equal(publicIpAddress("8.8.8.8"), true);
  assert.equal(publicIpAddress("2606:4700:4700::1111"), false); // IPv4-only egress policy.
});

test("DingTalk payload always contains the configured ReplyNest keyword", () => {
  const payload = webhookPayload("dingtalk", { event_id: "event-1", severity: "warning", title: "测试通知", summary: "不含客户正文", occurred_at: new Date(0).toISOString() }) as any;
  assert.match(payload.text.content, /ReplyNest/);
});

test('custom payload never serializes transport credentials or endpoint',()=>{
  const input={event_id:'test',severity:'info' as const,title:'test',summary:'safe',occurred_at:new Date(0).toISOString(),
    endpoint:'https://example.test/secret-path',signing_secret:'synthetic-signing-key',provider:'custom'};
  const output=webhookPayload('custom',input);
  assert.deepEqual(Object.keys(output).sort(),['schema','event_id','severity','title','summary','occurred_at'].sort());
  assert.doesNotMatch(JSON.stringify(output),/synthetic-signing-key|secret-path/);
});

test("provider HTTP failures are surfaced for bounded retry", async () => {
  await assert.rejects(() => sendNotificationWebhook({
    provider: "dingtalk",
    endpoint: "https://oapi.dingtalk.com/robot/send?access_token=synthetic",
    event_id: "synthetic-event",
    severity: "warning",
    title: "故障注入",
    summary: "无客户数据",
    occurred_at: new Date(0).toISOString(),
  }, fakeWebhookResponse(503,'unavailable')), /webhook_http_503/);
});

test("provider application failures are surfaced for bounded retry", async () => {
  await assert.rejects(() => sendNotificationWebhook({
    provider: "wecom",
    endpoint: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic",
    event_id: "synthetic-event",
    severity: "warning",
    title: "故障注入",
    summary: "无客户数据",
    occurred_at: new Date(0).toISOString(),
  }, fakeWebhookResponse(200,JSON.stringify({errcode:93000}))), /webhook_provider_93000/);
});
