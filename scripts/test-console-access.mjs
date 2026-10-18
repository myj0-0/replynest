import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const req=createRequire(new URL('../apps/console/package.json',import.meta.url));
const ts=req('typescript'),React=req('react'),jsx=req('react/jsx-runtime');
const source=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
function load(path,dependency=()=>{throw Error('Unexpected dependency')},globals={}) {
 const m={exports:{}};
 vm.runInNewContext(ts.transpileModule(source(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,
 {exports:m.exports,require:p=>p==='react/jsx-runtime'?jsx:dependency(p),process:{env:{}},AbortSignal,Response,URL,...globals});
 return m.exports;
}
const access=load('apps/console/lib/console-access.ts');
const icon=()=>null,icons=new Proxy({},{get:()=>icon});
const nav=load('apps/console/lib/console-nav.ts',()=>icons);
const paths=role=>nav.consoleNavItems.filter(i=>access.canAccessConsolePath(i.href,role)).map(i=>i.href);
test('agent navigation retains usable pages and hides restricted management entries',()=>{
 assert.deepEqual(Array.from(paths('agent')),['/','/channels','/customers','/knowledge','/settings/privacy','/settings/activity']);
 assert.equal(access.canAccessConsolePath('/workbench','agent'),true);
 assert.deepEqual(Array.from(paths('unrecognized')),[]);
});
test('supervisor retains billing and operational reads, not administrator-only management',()=>{
 for(const path of ['/billing','/billing/history','/referrals','/notifications','/operations/outbound'])assert.ok(access.canAccessConsolePath(path,'supervisor'));
 for(const path of ['/settings/members','/settings/communications','/extensions','/template-market','/settings/automatic-reception','/knowledge/a/review'])assert.equal(access.canAccessConsolePath(path,'supervisor'),false);
 assert.equal(paths('tenant_admin').length,nav.consoleNavItems.length);
});
test('impersonation cannot expose personal-only studio, market or financial actions',()=>{
 for(const path of ['/extensions','/template-market/studio','/settings/automatic-reception','/settings/activity'])assert.equal(access.canAccessConsolePath(path,'tenant_admin',true),false);
 for(const role of ['agent','supervisor'])assert.equal(access.canManageConsoleFunds(role),false);
 assert.equal(access.canManageConsoleFunds('tenant_admin',true),false);
 assert.equal(access.canManageConsoleFunds('tenant_admin'),true);
 for(const view of ['reception','template-payouts','insights'])assert.equal(access.canViewBillingHistory(view,'supervisor'),false);
 assert.equal(access.canViewBillingHistory('orders','supervisor'),true);
});
test('navigation role gates agree with gateway member and billing authorization',()=>{
 const acl=load('services/channel-integration/src/access-control.ts');
 for(const role of ['agent','supervisor','tenant_admin'])for(const [path,permission]of [['/billing','tenant.billing.read'],['/settings/members','tenant.members.read']])
 assert.equal(access.canAccessConsolePath(path,role),acl.hasPermission({domain:'tenant',role},permission));
 assert.match(source('services/channel-integration/src/template-market-api.ts'),/auth\.role!=='tenant_admin'/);
});
const denied=()=>null;
async function blockedPage(path,role,impersonation=null,view=''){
 const workspace={tenant_id:'isolated',tenant_name:'Fixture',role},session={user:{display_name:'Fixture'},workspaces:[workspace],selected_tenant_id:'isolated',impersonation};
 let dataCalls=0;
 const reject=()=>{dataCalls++;throw Error('Forbidden page attempted data load')};
 const modules=new Proxy({},{get:(_,name)=>name==='getConsoleLocale'?async()=> 'zh':reject});
 const page=load('apps/console/app/'+path+'/page.tsx',p=>{
  if(p==='next/navigation')return {redirect:target=>{throw Error('Unexpected redirect '+target)},notFound:reject};
  if(p.endsWith('/console-session'))return {fetchConsoleSession:async()=>session,sessionToken:async()=>'fixture',gatewayUrl:reject};
  if(p.endsWith('/console-access-denied'))return {ConsoleAccessDenied:denied};
  if(p.endsWith('/console-access'))return access;
  if(p.endsWith('/billing-history-links'))return {billingHistoryViews:[],BillingHistoryLinks:reject};
  return modules;
 },{fetch:reject});
 const result=await page.default({params:Promise.resolve({kind:'studio',id:'fixture'}),searchParams:Promise.resolve({view})});
 assert.equal(result.type,denied,path);assert.equal(result.props.workspace,workspace);assert.equal(dataCalls,0,path);
}
for(const path of ['settings/members','settings/communications','settings/automatic-reception','extensions','template-market','template-market/[kind]','billing','billing/history','referrals','notifications','operations/outbound','operations/outbound/[id]','knowledge/[id]/review'])
 test('direct agent URL shows the common notice without querying restricted data: '+path,()=>blockedPage(path,'agent'));
test('supervisor/admin impersonation specific histories stop before fetching records',async()=>{
 for(const view of ['reception','template-payouts','insights'])await blockedPage('billing/history','supervisor',null,view);
 await blockedPage('billing/history','tenant_admin',{id:'fixture'},'insights');
 for(const path of ['extensions','template-market','template-market/[kind]','settings/automatic-reception'])await blockedPage(path,'tenant_admin',{id:'fixture'});
});
test('desktop and mobile render identical filtered navigation for every role',async()=>{
 const stubs={BrandLogo:icon,ConsoleLocaleSwitch:icon,PwaInstall:icon};
 const navigation=load('apps/console/components/console-navigation.tsx',p=>p.endsWith('/console-nav')?nav:p.endsWith('/console-access')?access:icons);
 const mobile=load('apps/console/components/mobile-navigation.tsx',p=>{
  if(p==='react')return {...React,useState:()=>[true,()=>{}],useRef:()=>({current:null}),useEffect:()=>{},useId:()=> 'fixture'};
  if(p==='react-dom')return {createPortal:content=>content};
  if(p==='lucide-react')return icons;
  if(p.endsWith('/console-access'))return access;
  if(p.endsWith('/console-nav'))return nav;
  if(p.endsWith('/console-navigation'))return navigation;
  if(p.endsWith('/console-i18n'))return {consoleText:()=>({impersonation:()=> 'Fixture'})};
  return stubs;
 },{document:{body:{}},requestAnimationFrame:()=>{}}).MobileNavigation;
 const shell=load('apps/console/components/console-shell.tsx',p=>{
  if(p==='lucide-react')return icons;
  if(p.endsWith('/console-access'))return access;
  if(p.endsWith('/console-nav'))return nav;
  if(p.endsWith('/console-navigation'))return navigation;
  if(p.endsWith('/console-locale-server'))return {getConsoleLocale:async()=> 'zh'};
  if(p.endsWith('/console-i18n'))return {consoleText:()=>({impersonation:()=> 'Fixture'})};
  if(p.endsWith('/mobile-navigation'))return {MobileNavigation:icon};
  return stubs;
 }).ConsoleShell;
 const server=req('react-dom/server');
 for(const role of ['agent','supervisor','tenant_admin'])for(const impersonating of [false,true]){
  const desktop=server.renderToStaticMarkup(await shell({session:{user:{display_name:'Fixture'},workspaces:[],selected_tenant_id:'fixture',impersonation:impersonating?{id:'fixture'}:null},workspace:{tenant_id:'fixture',tenant_name:'Fixture',role},activePath:'/',statusPageUrl:'https://status.fixture'}));
  const handheld=server.renderToStaticMarkup(mobile({tenantName:'Fixture',statusPageUrl:'https://status.fixture',locale:'zh',role,impersonating}));
  for(const item of nav.consoleNavItems){const expected=access.canAccessConsolePath(item.href,role,impersonating);for(const html of [desktop,handheld]){
   // Logo/root controls also link home. Other navigation links are unique.
   if(item.href!=='/')assert.equal(html.includes(`href="${item.href}"`),expected,role+' '+item.href);
  }}
 }
});
test('financial mutation buttons are hidden rather than merely disabled for read-only roles',()=>{
 assert.match(source('apps/console/components/ai-points-balance.tsx'),/canWrite&&data\?\.enabled&&data.pack&&<button/);
 assert.match(source('apps/console/components/wallet-panel.tsx'),/includes\(p.plan_code\)\?canWrite&&<button/);
 assert.match(source('apps/console/app/billing/page.tsx'),/canWrite=canManageConsoleFunds/);
 assert.match(source('apps/console/app/referrals/page.tsx'),/canWrite=\{canManageConsoleFunds/);
});
