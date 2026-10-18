import test from 'node:test';
import assert from 'node:assert/strict';
import {automaticSharedRouteDecision} from './automatic-shared-wechat-policy.js';
import type {RoutingState} from './shared-wechat-routing.js';
const now=Date.parse('2026-10-02T01:00:00Z');
const fence={appId:'wx0123456789abcdef',openId:'test-user',tenantId:'A',routeVersion:3};
const single:RoutingState={appId:fence.appId,openId:fence.openId,version:3,lastTransitionAt:now-1000,associations:[{tenantId:'A',name:'A'}]};
const multi:RoutingState={...single,associations:[...single.associations,{tenantId:'B',name:'B'}],selected:{tenantId:'A',expiresAt:now+60000}};
test('single association bypasses selection and neither mutates nor increments route version',()=>{
 const before=JSON.stringify(single);assert.deepEqual(automaticSharedRouteDecision(fence,single,now),{allowed:true});assert.equal(JSON.stringify(single),before);
});
test('multiple associations require the exact active selection',()=>{
 assert.deepEqual(automaticSharedRouteDecision(fence,multi,now),{allowed:true});
 assert.deepEqual(automaticSharedRouteDecision(fence,{...multi,selected:undefined},now),{allowed:false,reason:'merchant_selection_required'});
 assert.deepEqual(automaticSharedRouteDecision(fence,{...multi,selected:{tenantId:'A',expiresAt:now}},now),{allowed:false,reason:'merchant_selection_required'});
 assert.deepEqual(automaticSharedRouteDecision(fence,{...multi,selected:{tenantId:'B',expiresAt:now+1}},now),{allowed:false,reason:'merchant_changed'});
});

test('legacy fractional database expiry is accepted without extending the expiry boundary',()=>{
 const legacy={...multi,selected:{tenantId:'A',expiresAt:now+60000.875}};
 const original=JSON.stringify(legacy);
 assert.deepEqual(automaticSharedRouteDecision(fence,legacy,now),{allowed:true});
 assert.deepEqual(automaticSharedRouteDecision(fence,legacy,now+60000),{allowed:false,reason:'merchant_selection_required'});
 assert.deepEqual(automaticSharedRouteDecision({...fence,routeVersion:2},legacy,now),{allowed:false,reason:'route_changed'});
 assert.equal(JSON.stringify(legacy),original);
 for(const expiry of ['9999999999999',NaN,Infinity,Number.MAX_SAFE_INTEGER+1])
  assert.equal(automaticSharedRouteDecision(fence,{...multi,selected:{tenantId:'A',expiresAt:expiry as number}},now).allowed,false);
});
test('switching away and back still invalidates the original route fence',()=>{
 for(const state of [{...multi,version:4,selected:{tenantId:'B',expiresAt:now+1}},{...multi,version:5}]){
  assert.deepEqual(automaticSharedRouteDecision(fence,state,now),{allowed:false,reason:'route_changed'});
 }
});
test('foreign app/contact, unsubscription and missing target fail closed',()=>{
 for(const state of [{...single,appId:'wx1111111111111111'},{...single,openId:'other'}]){
  assert.deepEqual(automaticSharedRouteDecision(fence,state,now),{allowed:false,reason:'route_changed'});
 }
 for(const associations of [[],[{tenantId:'B',name:'B'}]])assert.deepEqual(automaticSharedRouteDecision(fence,{...single,associations},now),{allowed:false,reason:'merchant_changed'});
});
test('invalid scene/entry flag overrides single-association convenience',()=>{
 assert.deepEqual(automaticSharedRouteDecision(fence,{...single,needsMerchantEntry:true},now),{allowed:false,reason:'merchant_entry_required'});
 assert.deepEqual(automaticSharedRouteDecision(fence,{...single,needsMerchantEntry:false},now),{allowed:true});
});
test('ambiguous/corrupt persisted state and malformed versions never allow a route',()=>{
 for(const state of [{...single,version:NaN},{...single,version:-1},{...single,version:1.5},{...single,lastTransitionAt:now+1},
  {...single,associations:[...single.associations,...single.associations]},{...single,associations:[{tenantId:'',name:''}]},
  {...single,associations:Array.from({length:101},(_,i)=>({tenantId:String(i),name:'x'}))}]){
  assert.deepEqual(automaticSharedRouteDecision(fence,state,now),{allowed:false,reason:'invalid_route'});
 }
 for(const routeVersion of [-1,1.5,NaN,Infinity])assert.equal(automaticSharedRouteDecision({...fence,routeVersion},single,now).allowed,false);
 for(const expiresAt of [NaN,Infinity,now-1])assert.equal(automaticSharedRouteDecision(fence,{...multi,selected:{tenantId:'A',expiresAt}},now).allowed,false);
});
