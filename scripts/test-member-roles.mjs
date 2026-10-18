import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const req = createRequire(new URL('../apps/console/package.json', import.meta.url));
const ts = req('typescript'), React = req('react'), jsx = req('react/jsx-runtime');
const { renderToStaticMarkup } = req('react-dom/server');
const escapedText = text => renderToStaticMarkup(React.createElement('span', null, text)).slice(6, -7);
const source = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
function load(path, deps = {}, globals = {}) {
  const m = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source(path), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX
  } }).outputText, { exports: m.exports, require: p => {
    if (p === 'react/jsx-runtime') return jsx;
    assert.ok(p in deps, 'Unexpected dependency: ' + p); return deps[p];
  }, process: { env: {} }, ...globals });
  return m.exports;
}
const roles = load('apps/console/lib/member-roles.ts');
const access = load('apps/console/lib/console-access.ts');
const quick = load('services/channel-integration/src/quick-reply-permissions.ts');

test('all three roles have localized labels, capabilities and limitations; unknown IDs are not echoed', () => {
  assert.deepEqual(Array.from(roles.memberRoles), ['agent', 'supervisor', 'tenant_admin']);
  for (const en of [false, true]) for (const role of roles.memberRoles) {
    const info = roles.memberRoleInfo(role, en);
    assert.ok(info.label && info.summary && info.restriction);
    assert.equal(info.permissions.length, 2);
    assert.equal(roles.memberRoleLabel(role, en), info.label);
  }
  assert.equal(roles.memberRoleLabel('private-role', false), '未知角色');
  assert.equal(roles.memberRoleLabel('__proto__', true), 'Unknown role');
});

test('descriptions match financial, member and quick-reply permission boundaries', () => {
  for (const role of roles.memberRoles) {
    const info = roles.memberRoleInfo(role, false);
    assert.equal(access.canManageConsoleFunds(role), role === 'tenant_admin');
    assert.equal(access.canAccessConsolePath('/settings/members', role), role === 'tenant_admin');
    assert.equal(quick.canManageQuickReplies({ role, auth_kind: 'console_session', platform_user_id: 'synthetic' }), role !== 'agent');
    if (role !== 'tenant_admin') assert.match(info.restriction, /不能.*成员/);
  }
  assert.match(roles.memberRoleInfo('supervisor', false).restriction, /不能批准或调度群发、购买或提现/);
  assert.match(roles.memberRoleInfo('tenant_admin', false).restriction, /不是答巢平台管理员/);
  assert.match(roles.memberRoleInfo('agent', false).permissions.join(' '), /10 分钟或提前恢复/);
});

function selector(defaultRole = 'agent', en = false) {
  let value;
  const component = load('apps/console/components/member-role-select.tsx', {
    react: { useId: () => 'synthetic-role', useState: initial => [value ?? initial, next => { value = next; }] },
    '../lib/member-roles': roles
  });
  return () => component.MemberRoleSelect({ defaultRole, en, label: en ? 'Role' : '角色' });
}

test('role selection updates its accessible summary without submitting a form or making a request', () => {
  const render = selector();
  for (const role of roles.memberRoles) {
    render().props.children[0].props.onChange({ target: { value: role } });
    const tree = render(), select = tree.props.children[0], help = tree.props.children[1];
    assert.equal(select.props.name, 'role'); assert.equal(select.props.value, role);
    assert.equal(select.props['aria-describedby'], help.props.id);
    assert.equal(help.props['aria-live'], 'polite');
    assert.equal(help.props.children, roles.memberRoleInfo(role, false).summary);
  }
  assert.ok(!source('apps/console/components/member-role-select.tsx').includes('fetch('));
});

test('invite defaults to agent, editing retains each existing role, Chinese and English SSR are readable', () => {
  for (const en of [false, true]) for (const role of roles.memberRoles) {
    const tree = selector(role, en)();
    assert.equal(tree.props.children[0].props.value, role);
    const html = renderToStaticMarkup(tree);
    assert.match(html, /name="role"/);
    assert.ok(html.includes(roles.memberRoleInfo(role, en).label));
    assert.ok(html.includes(escapedText(roles.memberRoleInfo(role, en).summary)));
  }
  assert.equal(selector()().props.children[0].props.value, 'agent');
});

test('actual team page renders the permission guide, two selectors and localized current/pending roles', async () => {
  for (const en of [false, true]) {
    const workspace = { tenant_id: 'synthetic', tenant_name: 'Synthetic', role: 'tenant_admin' };
    const session = { user: { id: 'self' }, selected_tenant_id: workspace.tenant_id, workspaces: [workspace] };
    let requests = 0;
    const { MemberRoleSelect } = load('apps/console/components/member-role-select.tsx', { react: React, '../lib/member-roles': roles });
    const icon = () => null;
    const page = load('apps/console/app/settings/members/page.tsx', {
      'lucide-react': { MailPlus: icon, ShieldCheck: icon, UserRoundCog: icon },
      'next/navigation': { redirect: () => { throw Error('Unexpected redirect'); } },
      '../../../components/console-access-denied': { ConsoleAccessDenied: icon },
      '../../../components/console-shell': { ConsoleShell: ({ children }) => children },
      '../../../lib/console-session': { fetchConsoleSession: async () => session, sessionToken: async () => 'synthetic', gatewayUrl: p => p },
      '../../../lib/console-locale-server': { getConsoleLocale: async () => en ? 'en' : 'zh' },
      '../../../lib/member-errors': { memberErrorMessage: () => '' },
      '../../../lib/member-roles': roles,
      '../../../components/member-role-select': { MemberRoleSelect }
    }, { fetch: async () => { requests++; return { status: 200, json: async () => ({ data: {
      members: [{ platform_user_id: 'self', display_name: 'Self', role: 'tenant_admin' }, { platform_user_id: 'other', display_name: 'Other', role: 'supervisor' }],
      invitations: [{ invitation_id: 'fixture', display_name: 'Pending', role: 'agent', expires_at: '2026-10-10T00:00:00Z' }]
    } }) }; } });
    const html = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({}) }));
    assert.equal(requests, 1, 'no extra role or billing API queries');
    assert.ok(html.includes(en ? 'Role permissions' : '角色与权限'));
    for (const role of roles.memberRoles) assert.ok(html.includes(escapedText(roles.memberRoleInfo(role, en).restriction)));
    assert.equal((html.match(/name="role"/g) ?? []).length, 2);
    assert.ok(!html.includes(' · agent</p>')); assert.ok(!html.includes('>tenant_admin</div>'));
    assert.match(html, /action="\/api\/members\/invite" method="post"/);
    assert.match(html, /action="\/api\/members\/other" method="post"/);
    assert.match(html, /md:grid-cols-3/);
  }
});
