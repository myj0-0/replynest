// Exercise the real proxy with isolated upstream/session doubles; no account joins.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const requireConsole=createRequire(new URL('../apps/console/package.json',import.meta.url));
const ts=requireConsole('typescript'),next=requireConsole('next/server');
const compile=path=>ts.transpileModule(readFileSync(new URL('../'+path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function harness({status=200,code='invitation_expired',sessionToken}={}) {
 const env={CONSOLE_PUBLIC_ORIGIN:'https://console.replynest.cn',GATEWAY_INTERNAL_URL:'http://gateway.fixture'};
 const session={exports:{}};
 vm.runInNewContext(compile('apps/console/lib/console-session.ts'),{exports:session.exports,process:{env},URL,require:p=>{assert.equal(p,'next/headers');return {cookies:async()=>({get:()=>sessionToken?{value:sessionToken}:undefined})}}});
 const module={exports:{}},calls=[];
 const forward=async(url,options)=>{calls.push({url,options});return Response.json(status===200?{data:{token:'new-synthetic-session',expires_in:3600}}:{error:{code}},{status})};
 vm.runInNewContext(compile('apps/console/app/api/auth/accept-invitation/route.ts'),{exports:module.exports,
  require:p=>{if(p.endsWith('/activity-gateway-fetch'))return{activityGatewayFetch:forward};assert.ok(['next/server','../../../../lib/console-session'].includes(p));return p==='next/server'?next:session.exports},
  fetch:async(url,options)=>{calls.push({url,options});return Response.json(status===200?{data:{token:'new-synthetic-session',expires_in:3600}}:{error:{code}},{status})}});
 return {calls,invoke:module.exports.POST};
}
function request(origin) {return new next.NextRequest('https://console.replynest.cn/api/auth/accept-invitation',{
 method:'POST',headers:{...(origin!==undefined?{origin}:{}),'content-type':'application/x-www-form-urlencoded'},
 body:new URLSearchParams({token:'b'.repeat(64),password:'synthetic-password-only'})});}
test('invite and reset token pages both declare origin-only metadata',()=>{
 for(const path of ['invite','reset-password']) {
  const ast=ts.createSourceFile('page.tsx',readFileSync(new URL(`../apps/console/app/${path}/page.tsx`,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const metadata=ast.statements.flatMap(s=>ts.isVariableStatement(s)?[...s.declarationList.declarations]:[]).find(d=>d.name.getText(ast)==='metadata');
  assert.ok(metadata&&ts.isObjectLiteralExpression(metadata.initializer));
  assert.equal(metadata.initializer.properties.find(p=>p.name.getText(ast)==='referrer').initializer.text,'strict-origin');
 }
});
test('opaque, missing, external, lookalike and downgraded origins stay rejected before forwarding',async()=>{
 for(const origin of [undefined,'null','https://evil.invalid','https://console.replynest.cn.evil.invalid','http://console.replynest.cn']) {
  const h=harness(),result=await h.invoke(request(origin));assert.equal(result.status,403);assert.equal(h.calls.length,0);
 }
});
test('same-origin new member form reaches upstream once and receives its authenticated cookie',async()=>{
 const h=harness(),result=await h.invoke(request('https://console.replynest.cn'));
 assert.equal(result.status,303);assert.equal(result.headers.get('location'),'https://console.replynest.cn/');
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'http://gateway.fixture/api/v1/auth/accept-invitation');
 assert.deepEqual(JSON.parse(h.calls[0].options.body),{token:'b'.repeat(64),password:'synthetic-password-only'});
 assert.equal(h.calls[0].options.headers.authorization,undefined);
 assert.equal(result.cookies.get('crm_console_session').value,'new-synthetic-session');
 assert.match(result.headers.get('set-cookie'),/HttpOnly/);assert.match(result.headers.get('set-cookie'),/SameSite=lax/);
});
test('existing member session is preserved for the recipient-account verification',async()=>{
 const h=harness({sessionToken:'existing-synthetic-session'});await h.invoke(request('https://console.replynest.cn'));
 assert.equal(h.calls[0].options.headers.authorization,'Bearer existing-synthetic-session');
});
test('expired or wrong-account invitations do not set a cookie or bypass gateway checks',async()=>{
 for(const [status,code] of [[410,'invitation_expired'],[409,'existing_user_login_required']]) {
  const h=harness({status,code}),result=await h.invoke(request('https://console.replynest.cn'));
  assert.equal(result.status,303);const url=new URL(result.headers.get('location'));assert.equal(url.pathname,'/invite');assert.equal(url.searchParams.get('error'),'invalid');
  assert.equal(result.cookies.get('crm_console_session'),undefined);assert.equal(h.calls.length,1);
 }
});
