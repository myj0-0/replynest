import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';import {createRequire} from 'node:module';
const require=createRequire(new URL('../apps/console/package.json',import.meta.url)),React=require('react'),jsx=require('react/jsx-runtime'),ts=require('typescript');
const walk=node=>!node?[]:Array.isArray(node)?node.flatMap(walk):React.isValidElement(node)?[node,...walk(node.props.children)]:[];
function fixture(manage=true,enabled=true){
 let cursor=0,tree;const state=[],calls=[];state[1]=manage;state[7]=false;state[15]=enabled;
 const hooks={...React,useEffect:()=>{},useState:init=>{const i=cursor++;if(!(i in state))state[i]=typeof init==='function'?init():init;return[state[i],v=>state[i]=typeof v==='function'?v(state[i]):v];},useRef:init=>{const i=cursor++;if(!(i in state))state[i]={current:init};return state[i];}};
 const module={exports:{}},image={asset_id:'22222222-2222-4222-a222-222222222222',file_name:'synthetic.png',size_bytes:8,preview_url:'https://untrusted.invalid/never-use'};
 vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../apps/console/components/quick-reply-manager.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports:module.exports,require:p=>p==='react'?hooks:p==='react/jsx-runtime'?jsx:p==='lucide-react'?new Proxy({},{get:(_,p)=>()=>String(p)}):assert.fail(p),File,FormData,fetch:async(url,options)=>{calls.push({url,options});return {ok:true,status:201,json:async()=>({data:url==='/api/quick-reply-images'?image:{quick_reply_id:'synthetic'}})};}});
 const render=()=>{cursor=0;tree=module.exports.QuickReplyManager({en:false});};render();
 return {calls,state,render,nodes:()=>walk(tree),upload:async(file)=>{walk(tree).find(n=>n.type==='input'&&n.props.accept==='image/jpeg,image/png,image/gif').props.onChange({target:{files:[file]}});await new Promise(r=>setImmediate(r));},change:(field,value)=>{const index={shortcut:0,title:1,content:2}[field];walk(tree).filter(n=>(n.type==='input'||n.type==='textarea')&&n.props.required!==undefined)[index].props.onChange({target:{value}});}};
}
test('agents have no management controls; flag off leaves only text management',()=>{
 const agent=fixture(false);assert.equal(agent.nodes().some(n=>n.props.children==='添加图片'),false);
 const disabled=fixture(true,false);assert.equal(disabled.nodes().some(n=>n.type==='input'&&n.props.accept==='image/jpeg,image/png,image/gif'),false);
 assert.equal(disabled.nodes().find(n=>n.type==='textarea').props.required,true);
});
test('scanned image permits an empty text draft and uses only same-origin preview',async()=>{
 const f=fixture();await f.upload(new File([new Uint8Array(8)],'synthetic.png',{type:'image/png'}));f.render();
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'/api/quick-reply-images');assert.ok(f.calls[0].options.body instanceof FormData);
 assert.equal(f.nodes().find(n=>n.type==='textarea').props.required,false);
 assert.equal(f.nodes().find(n=>n.type==='img').props.src,'/api/quick-reply-images/22222222-2222-4222-a222-222222222222/content');
 assert.equal(f.nodes().find(n=>n.type==='button'&&n.props.children==='保存快捷回复').props.disabled,false);
 assert.ok(!f.calls.some(c=>c.url.includes('/conversations/')));
});
test('invalid or oversized browser upload creates no request',async()=>{
 for(const file of [new File(['x'],'bad.svg',{type:'image/svg+xml'}),new File([new Uint8Array(2*1024*1024+1)],'big.png',{type:'image/png'})]){const f=fixture();await f.upload(file);assert.equal(f.calls.length,0);f.render();assert.ok(f.nodes().some(n=>n.props.role==='alert'));}
});
test('saving the image draft forwards the asset reference, never media sending',async()=>{
 const f=fixture();await f.upload(new File([new Uint8Array(8)],'synthetic.png',{type:'image/png'}));f.render();f.change('shortcut','picture');f.render();f.change('title','Pure image');f.render();
 f.nodes().find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await new Promise(r=>setImmediate(r));
 assert.equal(f.calls.length,2);assert.equal(f.calls[1].url,'/api/quick-replies');assert.deepEqual(JSON.parse(f.calls[1].options.body),{shortcut:'picture',title:'Pure image',content:'',image_asset_id:'22222222-2222-4222-a222-222222222222'});
 assert.ok(!f.calls.some(c=>c.url.includes('/conversations/')));
});
