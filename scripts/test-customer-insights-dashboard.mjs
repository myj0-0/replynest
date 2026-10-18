// Executes actual UI/pie functions with synthetic responses. No model/production connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../apps/console/package.json',import.meta.url));
const ts=require('typescript'),React=require('react'),jsx=require('react/jsx-runtime'),{renderToStaticMarkup}=require('react-dom/server');
function load(file,imports={},globals={}){
 const m={exports:{}};const code=ts.transpileModule(readFileSync(new URL('../apps/console/'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(code,{exports:m.exports,require:p=>{assert.ok(Object.hasOwn(imports,p),'unexpected import '+p);return imports[p];},AbortController,setTimeout,clearTimeout,...globals});return m.exports;
}
const parser=load('lib/customer-insights.ts'),charts=load('lib/customer-insights-charts.ts',{'./customer-insights':parser});
const topics=(total=2)=>({total,topics:Object.keys(parser.insightTopicLabels).map(topic=>({topic,count:topic==='shipping'?total:0,percent:topic==='shipping'&&total?100:0}))});
const profiles=(total=2)=>({total,classified:total,unclassified:0,categories:Object.keys(parser.insightProfileLabels).map(category=>({category,count:['shipping_speed','concise_reply','written_contact'].includes(category)?total:0,percent:['shipping_speed','concise_reply','written_contact'].includes(category)&&total?100:0}))});
function fixture(){
 const states=[],refs=[],deps=[],cleanups=[],calls=[];let si=0,ri=0,ei=0,workspace='a';
 const state={deferred:null,fail:false,topics:topics(),profiles:profiles()};
 const hooks={...React,useState:init=>{const i=si++;if(!(i in states))states[i]=init;return [states[i],v=>states[i]=typeof v==='function'?v(states[i]):v];},useRef:init=>refs[ri++]??(refs[ri-1]={current:init}),useEffect:(fn,d)=>{const i=ei++;if(!deps[i]||d.some((v,j)=>v!==deps[i][j])){cleanups[i]?.();deps[i]=d;cleanups[i]=fn();}}};
 const m=load('components/customer-insights-dashboard.tsx',{'react':hooks,'react/jsx-runtime':jsx,'../lib/customer-insights':parser,'../lib/customer-insights-charts':charts},{fetch:async(url,options)=>{
  calls.push({url,options});if(state.deferred)return await state.deferred;return Response.json({data:url.endsWith('topics')?state.topics:state.profiles},{status:state.fail?503:200});
 }});
 const render=(id=workspace,canManage=true,locale='zh-CN')=>{workspace=id;si=ri=ei=0;return m.CustomerInsightsDashboard({workspaceId:id,canManage,locale});};
 function nodes(tree,predicate,out=[]){if(tree&&typeof tree==='object'){if(predicate(tree))out.push(tree);React.Children.forEach(tree.props?.children,c=>nodes(c,predicate,out));}return out;}
 return {state,calls,render,nodes,html:tree=>renderToStaticMarkup(tree),refresh:tree=>nodes(tree,n=>n.type==='button')[0].props.onClick(),dispose:()=>cleanups.forEach(fn=>fn?.()),m};
}
const flush=async()=>{await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));};
test('home loads exactly two bounded GET aggregates without reading grants, transcripts or models',async()=>{
 const h=fixture();h.render();await flush();const html=h.html(h.render());
 assert.equal(h.calls.length,2);assert.deepEqual(h.calls.map(c=>c.url).sort(),['/api/customer-insights/profiles','/api/customer-insights/topics']);
 for(const c of h.calls){assert.equal(c.options.method,'GET');assert.equal(c.options.cache,'no-store');assert.equal(c.options.redirect,'error');assert.equal(c.options.headers['x-replynest-workspace'],'a');assert.equal(c.options.body,undefined);}
 assert.equal((html.match(/<svg/g)||[]).length,3);assert.ok(html.includes('授权与设置'));assert.ok(html.includes('近 7 天'));assert.ok(html.includes('本页不会自动开启生成'));
 h.render();await flush();assert.equal(h.calls.length,2);h.dispose();
});
test('overlapping preferences use normalized category counts while customer coverage remains 100%',()=>{
 const data=parser.parseInsightsProfiles(profiles(1)),s=charts.profilePie(data,true);
 assert.equal(s.length,2);assert.equal(s[0].share,50);assert.equal(s[1].share,50);assert.equal(s[0].coverage,100);assert.equal(s[1].coverage,100);
 assert.equal(charts.profilePie(data,false)[0].share,100);assert.equal(charts.topicPie(parser.parseInsightsTopics(topics(1)))[0].share,100);
});
test('zero categories produce no NaN or invented sample; all-zero graphs explain empty results',async()=>{
 assert.equal(charts.profilePie(parser.parseInsightsProfiles(profiles(0)),true).length,0);
 const h=fixture();h.state.topics=topics(0);h.state.profiles=profiles(0);h.render();await flush();const html=h.html(h.render());
 assert.ok(html.includes('暂无已生成的咨询主题'));assert.ok(html.includes('暂无已归类的服务偏好'));assert.ok(!html.includes('<svg'));assert.ok(!html.includes('NaN'));assert.ok(html.includes('备注覆盖 0'));h.dispose();
});
test('pie geometry supports a full-circle 100% slice and bounded arcs',()=>{
 assert.equal((charts.piePath(0,100).match(/ A /g)||[]).length,2);assert.ok(charts.piePath(0,50).includes(' A 86 86 0 0 1 '));assert.ok(charts.piePath(0,75).includes(' A 86 86 0 1 1 '));
 for(const [a,b] of [[-1,10],[0,0],[0,101],[0,NaN],[Infinity,10]])assert.throws(()=>charts.piePath(a,b));
});
test('English legends remain meaningful and each positive slice has keyboard-accessible details',async()=>{
 const h=fixture();h.render('a',true,'en');await flush();const html=h.html(h.render('a',true,'en'));
 assert.ok(html.includes('Service preferences'));assert.ok(html.includes('customer coverage'));assert.ok(html.includes('tabindex="0"'));assert.ok(html.includes('Text contact'));assert.ok(html.includes('<title>'));h.dispose();
});
test('supervisor sees graphs without an unusable settings button; home hides graph for agent and impersonation',async()=>{
 const h=fixture();h.render('a',false);await flush();const html=h.html(h.render('a',false));assert.ok(!html.includes('/settings/automatic-reception'));assert.ok(html.includes('企业管理员设置'));h.dispose();
 const source=readFileSync(new URL('../apps/console/app/page.tsx',import.meta.url),'utf8');
 assert.match(source,/!session\.impersonation && \["tenant_admin", "supervisor"\]\.includes\(workspace\.role\)/);
 assert.match(source,/canManage=\{workspace\.role === "tenant_admin"\}/);assert.match(source,/CONSOLE_CUSTOMER_INSIGHTS_ENABLED === "true"/);
});
test('home chart failure is explicit and never displayed as no customers',async()=>{
 const h=fixture();h.state.fail=true;h.render();await flush();const html=h.html(h.render());assert.ok(html.includes('role="alert"'));assert.ok(html.includes('图表暂时无法加载'));assert.ok(!html.includes('暂无已生成'));h.dispose();
});
test('workspace change aborts old calls and discards stale tenant results',async()=>{
 const h=fixture();let resolve;h.state.deferred=new Promise(r=>resolve=r);h.render('a');assert.equal(h.calls.length,2);
 h.render('b');assert.ok(h.calls.slice(0,2).every(c=>c.options.signal.aborted));h.dispose();
 resolve(Response.json({data:topics()}));await flush();const html=h.html(h.render('b'));assert.ok(!html.includes('已生成问题画像：2'));h.dispose();
});
test('refresh replaces saved aggregates with no POST, timer polling or accumulating requests',async()=>{
 const h=fixture();h.render();await flush();h.refresh(h.render());await flush();assert.equal(h.calls.length,4);assert.ok(h.calls.every(c=>c.options.method==='GET'));h.dispose();
 const source=readFileSync(new URL('../apps/console/components/customer-insights-dashboard.tsx',import.meta.url),'utf8');assert.doesNotMatch(source,/setInterval|\/history|\/settings\b.*fetch|\/billing/);
});
test('chart backgrounds and borders use existing shared tokens',()=>{
 const css=readFileSync(new URL('../packages/design-tokens/tokens.css',import.meta.url),'utf8'),source=readFileSync(new URL('../apps/console/components/customer-insights-dashboard.tsx',import.meta.url),'utf8');
 for(const token of source.matchAll(/(?:bg|border)-\[var\((--[a-z0-9-]+)\)\]/g))assert.ok(css.includes(token[1]+':'),'undefined token '+token[1]);
});
