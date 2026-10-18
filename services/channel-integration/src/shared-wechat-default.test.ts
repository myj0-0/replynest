import test from 'node:test';
import assert from 'node:assert/strict';
import {routeSharedEvent,type RoutingState,type RoutingEvent} from './shared-wechat-routing.js';
const now=1800000000000,official={tenantId:'official',name:'答巢官方'},active=new Set(['official','a','b']);
const initial=():RoutingState=>({appId:'app',openId:'user',associations:[],lastTransitionAt:0,version:0});
const event=(kind:'entry'|'service'|'text'):RoutingEvent=>({appId:'app',openId:'user',eventId:'1',occurredAt:now,kind,...(kind==='text'?{text:'售前咨询'}:{})} as RoutingEvent);
test('generic entry and menu bind a new visitor, text routes first message to official',()=>{
 for(const kind of ['entry','service','text'] as const){const result=routeSharedEvent(initial(),event(kind),active,now,undefined,official);assert.equal(result.tenantId,'official');assert.equal(result.action,kind==='text'?'route':'info');assert.deepEqual(result.state.associations,[official]);}
});
test('default never overwrites existing, disabled or multi-merchant associations',()=>{
 for(const kind of ['entry','service','text'] as const){
  const state=initial();state.associations=[{tenantId:'a',name:'A'}];
  const r=routeSharedEvent(state,event(kind),active,now,undefined,official);assert.equal(r.tenantId,'a');assert.equal(r.state.associations.length,1);
  state.associations.push({tenantId:'b',name:'B'});assert.equal(routeSharedEvent(state,event(kind),active,now,undefined,official).action,'choose');
  assert.equal(routeSharedEvent(state,event(kind),new Set(['official']),now,undefined,official).reason,'no_active_association');
 }
});
test('inactive default, invalid scene and stale events cannot become official routes',()=>{
 assert.equal(routeSharedEvent(initial(),event('text'),new Set(),now,undefined,official).tenantId,undefined);
 const invalid=routeSharedEvent(initial(),{...event('entry'),kind:'scan',scene:null},active,now,undefined,official);
 assert.equal(invalid.reason,'invalid_scene');
 assert.equal(routeSharedEvent(invalid.state,{...event('text'),occurredAt:now+1000},active,now+1000,undefined,official).reason,'no_active_association');
 const stale=initial();stale.lastTransitionAt=now;assert.equal(routeSharedEvent(stale,event('entry'),active,now,undefined,official).reason,'stale_event');
});
