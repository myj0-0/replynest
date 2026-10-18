import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const req=createRequire(new URL('../apps/console/package.json',import.meta.url)),ts=req('typescript'),React=req('react'),jsx=req('react/jsx-runtime'),render=req('react-dom/server').renderToStaticMarkup;
const source=p=>readFileSync(new URL('../apps/console/'+p,import.meta.url),'utf8');
function load(p,deps,extra={}){const m={exports:{}};vm.runInNewContext(ts.transpileModule(source(p),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports:m.exports,require:k=>k==='react/jsx-runtime'?jsx:deps(k),process:{env:{}},URLSearchParams,AbortSignal,...extra});return m.exports}
const shell=({children})=>jsx.jsx('div',{children}),time='2026-10-10T01:00:00Z';
const form=load('components/privacy-handling-form.tsx',p=>{assert.equal(p,'react');return {...React,useState:v=>[v,()=>{}]}}).PrivacyHandlingForm;
const sample={request:{tenant_name:'Synthetic workspace',user_name:'Synthetic user',user_email:'privacy@example.invalid',request_type:'access',status:'in_review',details:'<script>private request detail</script>',created_at:time,due_at:time},events:[{privacy_request_event_id:'1',event_type:'review_started',reason:'内部办理过程：核对并准备交付',actor_name:'Synthetic admin',created_at:time,facts:{record_kind:'handling_note'}}],page:1,has_more:false};
async function detail(role,data=sample){const page=load('app/internal-admin/privacy/[id]/page.tsx',p=>p==='next/navigation'?{redirect:()=>{throw Error('redirect')}}:p.endsWith('/platform-admin-shell')?{PlatformAdminShell:shell}:p.endsWith('/privacy-handling-form')?{PrivacyHandlingForm:form}:p.endsWith('/platform-admin-session')?{fetchPlatformAdminSession:async()=>({user:{role}})}:{platformAdminLoad:async()=>data});return render(await page.default({params:Promise.resolve({id:'11111111-1111-4111-8111-111111111111'}),searchParams:Promise.resolve({})}))}
test('admin detail renders escaped submitted explanation and internal handling timeline',async()=>{
 const html=await detail('owner');assert.ok(html.includes('&lt;script&gt;private request detail&lt;/script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(html.includes('内部办理记录'));assert.ok(html.includes('追加办理记录'));assert.ok(html.includes('保存办理状态'));
});
test('support and auditor can read details but cannot see mutation forms; terminal requests have no forms',async()=>{
 for(const role of ['support','auditor']){const html=await detail(role);assert.ok(html.includes('private request detail'));assert.ok(!html.includes('<form'));}
 const html=await detail('owner',{...sample,request:{...sample.request,status:'fulfilled'}});assert.ok(html.includes('历史记录不可修改'));assert.ok(!html.includes('<form'));
});
test('completion explicitly requires identity and actual manual work; notes and states are separate',()=>{
 const html=render(form({id:'synthetic',status:'in_review'}));assert.ok(html.includes('name="identity_verified"'));assert.ok(html.includes('name="manual_completed"'));assert.match(html,/只登记结果/);assert.equal((html.match(/type="checkbox"[^>]+required/g)??[]).length,2);
 const submitted=render(form({id:'synthetic',status:'submitted'}));assert.ok(!submitted.includes('value="fulfilled"'));assert.ok(!submitted.includes('value="rejected"'));
});
test('missing privacy detail shows a meaningful error, not an empty request or silent homepage redirect',async()=>{
 const html=await detail('owner',null);assert.ok(html.includes('无权查看或暂时无法加载'));
});
async function activity(status=200){const workspace={tenant_id:'fixture',role:'tenant_admin'},session={user:{},workspaces:[workspace],selected_tenant_id:'fixture',impersonation:null};
 const page=load('app/settings/activity/page.tsx',p=>p==='next/navigation'?{redirect:t=>{throw Error(t)}}:p.endsWith('/console-shell')?{ConsoleShell:shell}:p.endsWith('/console-page-heading')?{ConsolePageHeading:shell}:p.endsWith('/console-access-denied')?{ConsoleAccessDenied:()=>null}:p.endsWith('/console-session')?{fetchConsoleSession:async()=>session,sessionToken:async()=> 'synthetic',gatewayUrl:p=>'http://fixture'+p}:p.endsWith('/console-locale-server')?{getConsoleLocale:async()=> 'zh'}:{canAccessConsolePath:()=>true},{fetch:async()=>({status,ok:status===200,json:async()=>({data:{items:[{event_id:'1',category:'login',actor_name:'Test',http_status:200,client_ip:'203.0.113.2',user_agent:'<script>UA</script>',action:'identity.login_succeeded',created_at:time,request_id:'opaque-id'}],has_more:true,next:'synthetic-cursor',capture_warning:false}})})});return render(await page.default({searchParams:Promise.resolve({load:'1'})}));}
test('security page shows IP, escaped browser information and paginated on-demand tracing',async()=>{
 const html=await activity();assert.ok(html.includes('203.0.113.2'));assert.ok(html.includes('&lt;script&gt;UA&lt;/script&gt;'));assert.ok(html.includes('<details'));assert.ok(html.includes('before=synthetic-cursor'));assert.ok(html.includes('六个自然月'));
});
test('security query failures show unavailable instead of a false empty-history claim; stale sessions redirect',async()=>{
 const html=await activity(503);assert.ok(html.includes('无法加载'));assert.ok(!html.includes('暂无符合条件'));await assert.rejects(activity(401),/login\?error=expired/);
});
const layoutFilter=load('lib/page-list-filter.ts',()=>{throw Error('unexpected import')});
const privacyFilter=load('components/privacy-history-filter.tsx',p=>p==='react'?React:p.endsWith('/page-list-filter')?layoutFilter:undefined);
async function history(query={},status=200,body={data:[],pagination:{page_size:20,next:null,previous:null}},en=false){
 let queries=0;
 const component=load('components/privacy-request-history.tsx',p=>p==='next/navigation'?{redirect:t=>{throw Error(t)}}:p==='lucide-react'?{Clock3:()=>null}:p.endsWith('/privacy-history-filter')?privacyFilter:p.endsWith('/page-list-filter')?layoutFilter:{gatewayUrl:p=>'http://fixture'+p},{fetch:async(url,options)=>{queries++;assert.equal(options.cache,'no-store');assert.equal(options.headers.authorization,'Bearer private-server-token');assert.ok(url.startsWith('http://fixture/api/v1/privacy/requests?'));return {status,ok:status===200,json:async()=>body}}});
 return {html:render(await component.PrivacyRequestHistory({query,token:'private-server-token',en})),queries};
}
test('privacy history performs zero queries before opt-in, including after submission or unrelated cursor parameters',async()=>{
 for(const q of [{},{submitted:'1'},{before:'cursor'},{history:'0'}]){const result=await history(q);assert.equal(result.queries,0);assert.ok(result.html.includes('查看申请记录'));assert.ok(!result.html.includes('暂无申请'));assert.ok(!result.html.includes('private-server-token'));assert.match(result.html,/href="\/settings\/privacy\?history=1#privacy-history"/);}
 const pageSource=source('app/settings/privacy/page.tsx');assert.ok(!pageSource.includes('await fetch('));assert.ok(pageSource.includes('await PrivacyRequestHistory({token,en,query})'));
});
test('opted-in privacy history is compact, escaped and navigable forward/back, refreshable and collapsible',async()=>{
 const result=await history({history:'1'},200,{data:[{privacy_request_id:'1',request_type:'deletion',status:'partially_fulfilled',details:'<script>private explanation</script>',created_at:time,due_at:time,resolution_summary:'人工结果',legal_hold_reason:'保留原因'}],pagination:{page_size:20,next:'next_cursor',previous:'previous_cursor'}});
 assert.equal(result.queries,1);assert.ok(result.html.includes('<details'));assert.ok(!result.html.includes(' open'));assert.ok(result.html.includes('&lt;script&gt;private explanation'));assert.ok(result.html.includes('人工结果'));assert.ok(result.html.includes('保留原因'));assert.ok(result.html.includes('before=next_cursor'));assert.ok(result.html.includes('after=previous_cursor'));assert.ok(result.html.includes('收起记录'));assert.ok(result.html.includes('最新记录 / 刷新'));assert.ok(!result.html.includes('private-server-token'));
});
test('privacy history distinguishes unavailable, empty first page and empty older page; expired identity redirects',async()=>{
 const failed=await history({history:'1',before:'invalid'},503);assert.ok(failed.html.includes('无法加载'));assert.ok(!failed.html.includes('暂无申请。</p>'));assert.ok(failed.html.includes('重试'));
 assert.ok((await history({history:'1'})).html.includes('暂无申请。'));
 assert.ok((await history({history:'1',before:'cursor'})).html.includes('本页暂无申请'));
 assert.ok((await history({history:'1'},200,undefined,true)).html.includes('No requests yet'));
 await assert.rejects(history({history:'1'},401),/login\?error=expired/);
});
