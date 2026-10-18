import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(new URL('../apps/console/package.json',import.meta.url)),ts=require('typescript');
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const module={exports:{}};
vm.runInNewContext(ts.transpileModule(read('apps/console/lib/console-nav.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:module.exports,require:()=>new Proxy({},{get:()=>()=>null})});
const nav=module.exports;
test('four groups cover every navigation item exactly once and do not use deeper nesting',()=>{
 assert.equal(nav.consoleNavGroups.length,4);
 const labels=Array.from(nav.consoleNavGroups.flatMap(g=>g.labels));
 assert.equal(new Set(labels).size,labels.length);
 assert.deepEqual(labels.slice().sort(),Array.from(nav.consoleNavItems.map(i=>i.label)).sort());
});
test('active links use path boundaries and AI reception has its own entry',()=>{
 assert.equal(nav.isConsoleNavActive('/billing','/billing/history'),true);
 assert.equal(nav.isConsoleNavActive('/billing','/billing-other'),false);
 assert.equal(nav.isConsoleNavActive('/','/customers'),false);
 assert.ok(nav.consoleNavItems.some(i=>i.href==='/settings/automatic-reception'));
});
test('home attention precedes metrics and saved insight charts; pie reads remain bounded',()=>{
 const s=read('apps/console/app/page.tsx');
 assert.ok(s.indexOf('需要关注')<s.indexOf('{metrics.map'));
 assert.ok(s.indexOf('{metrics.map')<s.indexOf('<CustomerInsightsDashboard'));
 const chart=read('apps/console/components/customer-insights-dashboard.tsx');
 assert.ok(chart.includes('hidden min-w-0 lg:block'));
 assert.equal((chart.match(/<InsightPie /g)||[]).length,3);
});
test('settings preserve one editor instance, existing purpose authorization and in-flight guards',()=>{
 const s=read('apps/console/components/automatic-reception-layout.tsx');
 for(const name of ['AutomaticReceptionManagement','ReceptionPersonalization','CustomerInsightsSettings'])assert.equal((s.match(new RegExp('<'+name+' ','g'))||[]).length,1);
 assert.ok(s.includes('[data-layout-mutation-busy="true"]'));
 assert.ok(s.includes("location.hash.slice(1)"));
 const p=read('apps/console/components/reception-personalization.tsx');
 assert.ok(p.includes('hidden={section===\'style\'}'));
 assert.ok(p.includes('disclosureVersion:view.disclosures[pending].version'));
 assert.ok(p.includes('disabled={busy||!confirmed}'));
 assert.ok(!s.includes("method:'POST'"));
});
