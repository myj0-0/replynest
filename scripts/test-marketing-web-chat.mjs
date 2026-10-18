import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const component = read('apps/console/components/marketing-web-chat.tsx');

test('both homepage languages expose a dedicated Web Chat section', () => {
  for (const page of ['home', 'en']) {
    const source = read(`apps/console/app/${page}/page.tsx`);
    assert.match(source, /import \{ MarketingWebChat \}/);
    assert.match(source, /<MarketingWebChat/);
    assert.ok(source.includes('Web Chat'));
  }
  assert.ok(read('apps/console/app/home/page.tsx').includes('href="#web-chat"'));
  assert.ok(component.includes('id="web-chat"'));
  assert.ok(component.includes('aria-labelledby="web-chat-title"'));
});
test('illustration does not send messages, mount a widget or enable AI', () => {
  for (const forbidden of ['<script', '<iframe', '<form', '<button', 'fetch(', 'useEffect', 'dangerouslySetInnerHTML']) assert.ok(!component.includes(forbidden), forbidden);
  for (const text of ['非真实会话', 'not a live conversation', '安装聊天入口不等于开启 AI 自动回复', '每企业支持 1 个网站渠道', '消耗点数', '不代表已验证身份']) {
    assert.ok(component.includes(text), text);
  }
});
test('setup links match the published tutorial and registration destinations', () => {
  for (const url of ['https://docs.replynest.cn/website-chat', 'https://docs.replynest.cn/en/website-chat', 'https://console.replynest.cn/register']) assert.ok(component.includes(url));
  const guide = read('apps/help-docs/docs/website-chat.md');
  assert.match(guide, /HTTPS/);
  assert.match(guide, /每个企业支持一个网站聊天渠道/);
  assert.match(guide, /不会.*自动接待|不.*自动接待|不.*自动回复/);
});
