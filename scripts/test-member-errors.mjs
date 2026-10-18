import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const ts=createRequire(new URL('../apps/console/package.json',import.meta.url))('typescript');
function load(path,deps={},globals={}) {
 const module={exports:{}};
 const src=readFileSync(new URL('../'+path,import.meta.url),'utf8');
 vm.runInNewContext(ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:module.exports,require:k=>{assert.ok(k in deps,k);return deps[k]},Response,URL,fetch,...globals});
 return module.exports;
}
const errors=load('apps/console/lib/member-errors.ts');
test('seat, duplicate member and delivery failure have distinct actionable bilingual messages',()=>{
 for(const code of ['entitlement_limit_reached','member_exists','invitation_delivery_failed','invitation_not_pending']) {
  assert.ok(errors.memberErrorMessage(code,false));assert.ok(errors.memberErrorMessage(code,true));
 }
 assert.match(errors.memberErrorMessage('entitlement_limit_reached',false),/待接受邀请/);
 assert.match(errors.memberErrorMessage('invalid_invitation',false),/QQ、163/);
});
test('unknown error codes and malformed upstream bodies are never echoed into redirects',async()=>{
 for(const body of [{error:{code:'sensitive_private_value'}},{error:{code:'__proto__'}},{}]) {
  assert.equal(await errors.memberErrorCode(Response.json(body)),'operation_failed');
 }
 assert.equal(await errors.memberErrorCode(new Response('<private-error>')),'operation_failed');
 assert.equal(await errors.memberErrorCode(Response.json({error:{code:'entitlement_limit_reached'}})),'entitlement_limit_reached');
 assert.ok(!errors.memberErrorMessage('private-value',false).includes('private-value'));
});
function routeHarness(path,{valid=true,token='synthetic-session',status=409,code='entitlement_limit_reached'}={}) {
 const calls=[];
 const forward=async(url,options)=>{calls.push({url,options});return Response.json({error:{code}},{status})};
 const route=load(path,{
  'next/server':{NextResponse:{json:(body,init)=>({body,...init}),redirect:(url,status)=>({url:url.toString(),status})}},
  [path.includes('/invitations/')?'../../../../../../lib/console-session':'../../../../lib/console-session']:{hasValidOrigin:()=>valid,sessionToken:async()=>token,consoleUrl:p=>new URL(p,'https://fixture.invalid'),gatewayUrl:p=>'http://gateway.fixture.invalid'+p},
  [path.includes('/invitations/')?'../../../../../../lib/member-errors':'../../../../lib/member-errors']:errors,
  [path.includes('/invitations/')?'../../../../../../lib/activity-gateway-fetch':'../../../../lib/activity-gateway-fetch']:{activityGatewayFetch:forward},
 },{fetch:async(url,options)=>{calls.push({url,options});return Response.json({error:{code}},{status})}});
 return {route,calls};
}
test('all member mutation proxies validate origin and use an allowlisted error code, not raw status',()=>{
 for(const path of ['apps/console/app/api/members/invite/route.ts','apps/console/app/api/members/[id]/route.ts','apps/console/app/api/members/invitations/[id]/revoke/route.ts']) {
  const source=readFileSync(new URL('../'+path,import.meta.url),'utf8');
  assert.match(source,/hasValidOrigin\(request\)/);assert.match(source,/memberErrorCode\(upstream\)/);assert.ok(!source.includes('error=${upstream.status}'));
  assert.match(source,/upstream.status\s*===\s*401/);
 }
});
test('revoke rejects missing origin or session before contacting the gateway',async()=>{
 const path='apps/console/app/api/members/invitations/[id]/revoke/route.ts';
 const denied=routeHarness(path,{valid:false});assert.equal((await denied.route.POST({}, {params:Promise.resolve({id:'x'})})).status,403);
 const anon=routeHarness(path,{token:null});assert.match((await anon.route.POST({}, {params:Promise.resolve({id:'x'})})).url,/login\?error=expired/);
 assert.equal(denied.calls.length,0);assert.equal(anon.calls.length,0);
});
test('invitation form preserves the server error code rather than a misleading 409',async()=>{
 const h=routeHarness('apps/console/app/api/members/invite/route.ts');
 const result=await h.route.POST({formData:async()=>new Map([['email','member@example.com'],['display_name','Member'],['role','agent']])});
 assert.equal(result.status,303);assert.match(result.url,/error=entitlement_limit_reached/);
 assert.equal(h.calls.length,1);assert.equal(JSON.parse(h.calls[0].options.body).email,'member@example.com');
});
test('revoke sends only the authenticated POST; stale sessions return to login',async()=>{
 const path='apps/console/app/api/members/invitations/[id]/revoke/route.ts',id='11111111-1111-4111-8111-111111111111';
 const h=routeHarness(path,{status:200});assert.match((await h.route.POST({}, {params:Promise.resolve({id})})).url,/status=revoked/);
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].options.method,'POST');assert.equal(h.calls[0].options.headers.authorization,'Bearer synthetic-session');
 const expired=routeHarness(path,{status:401});assert.match((await expired.route.POST({}, {params:Promise.resolve({id})})).url,/login\?error=expired/);
});
