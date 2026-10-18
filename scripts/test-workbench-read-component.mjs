// Execute the actual React component effects in a controlled DOM/visibility
// harness. This does NOT claim a real browser or native database acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(new URL('../apps/console/package.json',import.meta.url)),ts=require('typescript'),React=require('react'),jsx=require('react/jsx-runtime');
const source=readFileSync(new URL('../apps/console/components/workbench-read-receipt.tsx',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const diagnosticSource=readFileSync(new URL('../apps/console/lib/workbench-read-diagnostics.ts',import.meta.url),'utf8'),diagnostics={exports:{}};
vm.runInNewContext(ts.transpileModule(diagnosticSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:diagnostics.exports});
function fixture(){
 const timers=new Map(),listeners=new Map(),events=[],requests=[],refs=[],effects=[],state=[];let timerId=0,refIndex=0,stateIndex=0,observer,cleanup;
 const nodes=['older','middle','newest'].map(id=>({dataset:{incomingMessageId:id},rect:{top:20,bottom:80,left:20,right:80},getBoundingClientRect(){return this.rect;}}));
 const s={enabled:true,focused:true,display:true,visibility:'visible',response:()=>Response.json({data:{conversation_id:'conversation',unread_count:3,capped:false}}),nodes};
 const root={querySelectorAll:()=>nodes,getClientRects:()=>s.display?[{}]:[]};
 const document={get visibilityState(){return s.visibility;},hasFocus:()=>s.focused,addEventListener:(key,fn)=>listeners.set(key,fn),removeEventListener:(key)=>listeners.delete(key)};
 const window={innerHeight:600,innerWidth:900,addEventListener:(key,fn)=>listeners.set(key,fn),removeEventListener:(key)=>listeners.delete(key),dispatchEvent:event=>events.push(event.detail)};
 class Observer{constructor(callback,options){this.callback=callback;this.options=options;this.nodes=[];observer=this;}observe(n){this.nodes.push(n);}disconnect(){this.disconnected=true;}}
 const m={exports:{}};vm.runInNewContext(code,{exports:m.exports,require:p=>p==='../lib/workbench-read-diagnostics'?diagnostics.exports:p==='react/jsx-runtime'?jsx:{...React,
  useRef:initial=>{const n=refIndex++;return refs[n]??(refs[n]={current:n===0?root:initial});},
  useState:initial=>{const n=stateIndex++;state[n]??=initial;return [state[n],v=>{state[n]=typeof v==='function'?v(state[n]):v;}];},useEffect:fn=>effects.push(fn)},
  document,window,IntersectionObserver:Observer,CustomEvent,AbortController,AbortSignal,crypto,performance,console:{warn:()=>{}},
  setTimeout:(fn,ms)=>{assert.equal(ms,300);const id=++timerId;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
  fetch:async(url,options)=>{requests.push({url,options,body:JSON.parse(options.body)});return s.response(options);}});
 function render(props={}){cleanup?.();refIndex=stateIndex=0;effects.length=0;const tree=m.exports.WorkbenchReadReceipt({tenantId:'tenant',conversationId:'conversation',enabled:s.enabled,en:false,children:'synthetic',...props});cleanup=effects.map(fn=>fn()).find(Boolean);return tree;}
 const visible=(ids,ratio=1)=>observer?.callback(nodes.map(n=>({target:n,isIntersecting:ids.includes(n.dataset.incomingMessageId),intersectionRatio:ids.includes(n.dataset.incomingMessageId)?ratio:0})));
 async function flush(){const pending=[...timers.values()];timers.clear();pending.forEach(fn=>fn());for(let i=0;i<8;i++)await Promise.resolve();}
 return {s,events,requests,refs,listeners,render,visible,flush,get observer(){return observer;},dispose:()=>cleanup?.(),timers,state};
}
test('disabled component never observes, prefetches or acknowledges',async()=>{
 const f=fixture();f.s.enabled=false;f.render();assert.equal(f.observer,undefined);await f.flush();assert.equal(f.requests.length,0);f.dispose();
});
test('hidden, unfocused, undisplayed and off-viewport bubbles never acknowledge',async()=>{
 for(const condition of ['hidden','focus','display','viewport']){const f=fixture();f.render();if(condition==='hidden')f.s.visibility='hidden';if(condition==='focus')f.s.focused=false;if(condition==='display')f.s.display=false;
  if(condition==='viewport')f.s.nodes.forEach(n=>{n.rect={...n.rect,top:700,bottom:750};});f.visible(['older','middle','newest']);await f.flush();assert.equal(f.requests.length,0);f.dispose();}
});
test('only exact visible public IDs are submitted, not the highest-ID watermark',async()=>{
 const f=fixture();f.render();assert.equal(f.observer.options.threshold,0.25);f.visible(['middle']);await f.flush();assert.equal(f.requests.length,1);
 assert.deepEqual(f.requests[0].body,{message_ids:['middle']});assert.equal(f.requests[0].options.headers['x-replynest-workspace'],'tenant');assert.equal(f.requests[0].options.cache,'no-store');
 assert.equal(f.events.length,1);assert.equal(f.events[0].count,3);f.visible(['older','middle']);await f.flush();assert.deepEqual(f.requests[1].body,{message_ids:['older']});f.dispose();
});

test('less than 25 percent intersection and threshold exit cannot acknowledge barely visible bubbles',async()=>{
 const f=fixture();f.render();f.visible(['middle'],0.24);await f.flush();assert.equal(f.requests.length,0);
 f.visible(['middle'],0.3);f.visible(['middle'],0.1);await f.flush();assert.equal(f.requests.length,0);
 f.visible(['middle'],0.25);await f.flush();assert.equal(f.requests.length,1);assert.deepEqual(f.requests[0].body,{message_ids:['middle']});f.dispose();
});

test('exact 1000 and capped 1000 read receipts are both valid but a smaller capped count cannot clear badge',async()=>{
 for(const capped of [false,true]){const f=fixture();f.s.response=()=>Response.json({data:{conversation_id:'conversation',unread_count:1000,capped}});f.render();f.visible(['middle']);await f.flush();assert.equal(f.events[0].count,1000);assert.equal(f.events[0].capped,capped);f.dispose();}
 const f=fixture();f.s.response=()=>Response.json({data:{conversation_id:'conversation',unread_count:999,capped:true}});f.render();f.visible(['middle']);await f.flush();assert.equal(f.events.length,0);f.dispose();
});
test('repeated observer events and refreshed children do not repeat confirmed IDs',async()=>{
 const f=fixture();f.render();f.visible(['older','middle']);await f.flush();f.visible(['older','middle']);await f.flush();assert.equal(f.requests.length,1);
 f.render({children:'refreshed'});f.visible(['older','middle']);await f.flush();assert.equal(f.requests.length,1);f.visible(['newest']);await f.flush();assert.equal(f.requests.length,2);f.dispose();
});
test('failed/invalid receipts never optimistically clear unread or auto-loop',async()=>{
 for(const response of [()=>Response.json({}, {status:503}),()=>Response.json({data:{conversation_id:'foreign',unread_count:0,capped:false}}),
  ()=>Response.json({data:{conversation_id:'conversation',unread_count:1001,capped:false}}),()=>{throw Error('lost reply');}]){
  const f=fixture();f.s.response=response;f.render();f.visible(['newest']);await f.flush();assert.equal(f.events.length,0);assert.equal(f.state[0],true);
  f.visible(['newest']);await f.flush();assert.equal(f.requests.length,1);f.dispose();
 }
});
test('explicit retry can confirm an uncertain idempotent read without clearing other bubbles',async()=>{
 const f=fixture();f.s.response=()=>Response.json({}, {status:503});f.render();f.visible(['newest']);await f.flush();assert.equal(f.events.length,0);
 const tree=f.render();tree.props.children[1].props.children[2].props.onClick();
 f.s.response=()=>Response.json({data:{conversation_id:'conversation',unread_count:2,capped:false}});f.render();f.visible(['newest']);await f.flush();assert.equal(f.requests.length,2);assert.equal(f.events[0].count,2);f.dispose();
});
test('in-flight refresh is canceled; stale response cannot publish to another workspace',async()=>{
 const f=fixture();let release;f.s.response=()=>new Promise(r=>{release=r;});f.render();f.visible(['middle']);await f.flush();assert.equal(f.requests.length,1);
 f.render({tenantId:'other'});assert.equal(f.requests[0].options.signal.aborted,true);release(Response.json({data:{conversation_id:'conversation',unread_count:0,capped:false}}));await f.flush();assert.equal(f.events.length,0);f.dispose();
});
test('scope switch does not carry confirmed IDs to another tenant/conversation',async()=>{
 const f=fixture();f.render();f.visible(['newest']);await f.flush();f.render({tenantId:'other'});f.visible(['newest']);await f.flush();assert.equal(f.requests.length,2);assert.equal(f.requests[1].options.headers['x-replynest-workspace'],'other');f.dispose();
});
test('focus restore resumes visible receipts, cleanup disconnects observers and timers',async()=>{
 const f=fixture();f.s.focused=false;f.render();f.visible(['middle']);await f.flush();assert.equal(f.requests.length,0);f.s.focused=true;f.listeners.get('focus')();await f.flush();assert.equal(f.requests.length,1);
 f.dispose();assert.equal(f.observer.disconnected,true);assert.equal(f.timers.size,0);assert.equal(f.listeners.size,0);
});
