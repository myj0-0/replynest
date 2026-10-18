import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const demo = read('apps/console/components/public-demo.tsx');
const page = read('apps/console/app/demo/[[...path]]/page.tsx');
test('public demo is independent from authentication, data and delivery', () => {
  for (const text of ['fetch(', 'cookies(', 'sessionToken', 'fetchConsoleSession', 'gatewayUrl', 'process.env', '<form', '<input', '<textarea', 'use server', 'dangerouslySetInnerHTML', 'http://']) assert.ok(!demo.includes(text) && !page.includes(text), text);
  assert.equal((demo.match(/from /g) ?? []).length, 4);
  for (const text of ['不创建登录会话', '不调用模型', '不扣点', '合成数据 · 只读演示', 'example.invalid', '192.0.2.10']) assert.ok(demo.includes(text), text);
});
test('closed routes and closed role values, not arbitrary tenant or resource IDs', () => {
  assert.match(page, /if \(!demoPages.some\(page => page\[0\] === path\)\) notFound\(\)/);
  assert.match(demo, /Object.hasOwn\(demoRoles, value\)/);
  assert.match(demo, /canAccessConsolePath\('\/' \+ path, role\)/);
  assert.match(page, /index: false, follow: false/);
  for (const route of ['channels/web-chat', 'knowledge/document', 'knowledge/quick-replies', 'billing/history', 'workbench', 'open-platform']) assert.ok(demo.includes("['" + route + "'"));
});
test('public demo does not turn on the legacy production demo-login gate', () => {
  const route = read('apps/console/app/api/auth/demo/route.ts');
  assert.ok(route.includes('CONSOLE_DEMO_LOGIN !== "true"'));
  assert.ok(route.includes('["localhost", "127.0.0.1", "::1"]'));
  assert.ok(read('apps/console/app/login/page.tsx').includes('href="/demo"'));
  for (const p of ['home', 'en']) assert.ok(read(`apps/console/app/${p}/page.tsx`).includes('<DemoEntry'));
});
test('demo boundary blocks write methods and browser outbound connections', () => {
  const proxy=read('apps/console/proxy.ts');
  for(const term of ["['GET','HEAD'].includes(request.method)", 'status:405', "connect-src 'none'", "form-action 'none'", "frame-src 'none'", 'PLATFORM_ADMIN_PUBLIC_ORIGIN', '"/demo/:path*"']) assert.ok(proxy.includes(term),term);
});
