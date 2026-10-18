import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const base = process.argv[2] ?? 'http://127.0.0.1:3375';
const candidate = process.argv[3];
const root = new URL('../', import.meta.url);
const source = readFileSync(new URL('apps/console/components/public-demo.tsx', root), 'utf8');
const block = source.split('export const demoPages = [')[1].split('] as const;')[0];
const pages = [...block.matchAll(/\['([^']*)', '([^']+)', '[^']+'\]/g)].map(m => [m[1], m[2]]);
assert.equal(pages.length, 26);
let checks = 1;
const check = (value, label) => { assert.ok(value, label); checks++; };
for (const [path, title] of pages) {
  const r = await fetch(base + '/demo' + (path ? '/' + path : ''));
  const html = await r.text();
  check(r.status === 200, path + ' status');
  check(html.includes(title) && html.includes('合成数据 · 只读演示'), path + ' content');
  check(!r.headers.has('set-cookie'), path + ' must not issue session');
  check(r.headers.get('content-security-policy')?.includes("connect-src 'none'"),path+' no browser connections');
  check(!html.includes('<form') && !html.includes('<input') && !html.includes('<textarea'), path + ' no business mutations');
  const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map(m => m[1]);
  check(links.every(u => u.startsWith('/demo') || ['/register', 'https://replynest.cn/', 'https://docs.replynest.cn/'].includes(u)), path + ' closed destinations');
}
for (const role of ['agent', 'supervisor', '__proto__', 'constructor', 'tenant_admin&tenant_id=real']) {
  const r = await fetch(base + '/demo?role=' + encodeURIComponent(role)); const html = await r.text();
  check(r.status === 200 && !r.headers.has('set-cookie'), role + ' no session');
  if (role === 'agent') check(!html.includes('href="/demo/billing?') && !html.includes('href="/demo/settings/members?'), 'agent hides restricted entries');
}
const denied = await fetch(base + '/demo/settings/members?role=agent');
check((await denied.text()).includes('此角色无权查看该栏目'), 'direct restricted demo URL consistent notice');
check((await fetch(base + '/demo/unknown')).status === 404, 'unknown route');
for (const url of ['/api/quick-replies', '/api/billing/checkout']) {
  const r = await fetch(base + url); check(r.status === 401, 'real endpoint remains protected ' + url);
}
for (const url of ['/demo', '/demo/billing/history']) {
  const r = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check(r.status === 405, 'write methods explicitly rejected ' + url);
}
check(!source.includes('fetch('), 'no outgoing fetch');
if (candidate) {
  const folder = new URL('output/public-demo/' + candidate + '/', root);
  const image = JSON.parse(readFileSync(new URL('image.json', folder)));
  writeFileSync(new URL('http-proof.json', folder), JSON.stringify({ passed: true, candidate, image: image.image, checks, pages: pages.length, external_calls: 0, test_sha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex') }, null, 2));
}
console.log(JSON.stringify({ passed: true, checks, pages: pages.length }));
