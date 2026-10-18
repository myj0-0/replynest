import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(new URL('../package.json',import.meta.url));

test('SockJS retains synchronous CJS UUID v4 connection IDs with the fixed package',()=>{
 const fromSockjs=createRequire(require.resolve('sockjs'));
 assert.equal(fromSockjs('uuid/package.json').version,'11.1.1');
 const {SockJSConnection}=require('sockjs/lib/transport');
 const one=new SockJSConnection({prefix:'/synthetic'}),two=new SockJSConnection({prefix:'/synthetic'});
 assert.equal(fromSockjs('uuid').version(one.id),4);assert.notEqual(one.id,two.id);
 assert.equal(one.prefix,'/synthetic');
 const short=Buffer.alloc(15,7);assert.throws(()=>fromSockjs('uuid').v5('test',fromSockjs('uuid').v5.DNS,short),RangeError);
 assert.ok(short.every(value=>value===7));
});
test('fast-uri normalizes encoded host case and preserves URI and schema behavior',()=>{
 const uri=require('fast-uri');assert.equal(require('fast-uri/package.json').version,'3.1.8');
 assert.equal(uri.normalize('https://%65XAMPLE.com/a'),'https://example.com/a');
 assert.equal(uri.equal('https://%65XAMPLE.com/a','https://example.com/a'),true);
 assert.equal(uri.resolve('https://example.com/docs/a','../b'),'https://example.com/b');
 const Ajv=require('ajv'),ajv=new Ajv();
 const validate=ajv.compile({$id:'https://example.com/schema',type:'object',required:['name'],properties:{name:{type:'string'}}});
 assert.equal(validate({name:'synthetic'}),true);assert.equal(validate({name:5}),false);
});
test('selector parser and CSS plugins preserve attributes, pseudos, variables and media rules',async()=>{
 const parse=require('postcss-selector-parser');assert.equal(require('postcss-selector-parser/package.json').version,'7.1.6');
 const selector=':is(.a, .b) > a[data-id="中文" i]:not(:hover)::before';
 assert.equal(parse().processSync(selector),selector);
 const classes=[];parse(ast=>ast.walkClasses(node=>classes.push(node.value))).processSync(selector);assert.deepEqual(classes,['a','b']);
 const postcss=require('postcss'),cssnano=require('cssnano');
 const css=':root { --brand: #1684ff; } .a, .b { color: var(--brand); margin: 0px 0px 0px 0px; } @media (max-width: 600px) { .a:is(:hover,:focus) { display: block; } }';
 const result=await postcss([cssnano({preset:require('@docusaurus/cssnano-preset')()})]).process(css,{from:undefined});
 assert.equal(result.warnings().length,0);
 assert.match(result.css,/--brand:#1684ff/);assert.match(result.css,/color:var\(--brand\)/);
 assert.match(result.css,/margin:0/);assert.match(result.css,/@media\s*\(max-width:600px\)/);
 assert.match(result.css,/:is\(:hover,:focus\)/);
});
test('flat-selector attack completes in a bounded isolated process',()=>{
 const child=spawnSync(process.execPath,['-e',"const p=require('postcss-selector-parser'); const selector='.a'.repeat(20000); const ast=p().astSync(selector); if(ast.first.nodes.length!==20000)process.exit(2);"],{
  cwd:root,encoding:'utf8',timeout:5000,maxBuffer:65536,
  env:Object.fromEntries(['PATH','Path','SystemRoot','TEMP','TMP'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]))
 });
 assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr);
});
