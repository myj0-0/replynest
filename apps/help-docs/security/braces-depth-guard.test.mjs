import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {bracesPatchEdits,patchedSource,verifyBracesGuard} from './braces-depth-guard.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),req=createRequire(new URL('../package.json',import.meta.url));
const braces=req('braces');
test('all installed braces copies have exactly the reviewed upstream bytes plus the local patch',()=>{
 const proof=verifyBracesGuard();assert.ok(proof.length>=4);assert.equal(proof.length%4,0);
 for(const edit of bracesPatchEdits){
  const current=readFileSync(req.resolve('braces/lib/'+edit.file),'utf8');assert.equal(patchedSource(current,edit),current);
  assert.throws(()=>patchedSource(current+'\n// unexpected change',edit),/hash_mismatch/);
  assert.throws(()=>patchedSource(current.replace('128','10000'),edit),/context_changed|hash_mismatch/);
 }
});
test('ordinary brace, range, escaped, quoted and glob behavior remains compatible',()=>{
 assert.deepEqual(braces('docs/{en,zh}/{a,b}.md'),['docs/(en|zh)/(a|b).md']);
 assert.deepEqual(braces.expand('img-{1..3}.png'),['img-1.png','img-2.png','img-3.png']);
 assert.deepEqual(braces.expand('{a,b}{1,2}'),['a1','a2','b1','b2']);
 assert.equal(braces.stringify(braces.parse('a/{b,c}/d')),'a/{b,c}/d');
 for(const pattern of ['\\{'.repeat(1000), '"'+'{'.repeat(1000)+'"', '['+'{'.repeat(1000)+']'])assert.doesNotThrow(()=>braces.compile(pattern));
 const match=req('micromatch');assert.deepEqual(match(['docs/en/a.md','docs/zh/b.md','other/c.md'],'docs/{en,zh}/*.md'),['docs/en/a.md','docs/zh/b.md']);
});
for(const method of ['compile','expand','stringify'])test('nested string and direct AST fail promptly in '+method,()=>{
 const code=`const b=require('braces');
  const nested='{'.repeat(4000)+'x'+'}'.repeat(4000);
  for(const input of [nested,'('.repeat(4000)+'x'+')'.repeat(4000)]){
   try{b[${JSON.stringify(method)}](input);process.exit(3);}catch(e){if(e.message!=='braces nesting exceeds safe depth limit')throw e;}
  }
  let ast={type:'root',nodes:[]};const first=ast;
  for(let i=0;i<10000;i++){const next={type:'root',nodes:[]};ast.nodes=[next];ast=next;}
  try{b[${JSON.stringify(method)}](first);process.exit(4);}catch(e){if(e.message!=='braces nesting exceeds safe depth limit')throw e;}`;
 const result=spawnSync(process.execPath,['-e',code],{cwd:root,encoding:'utf8',timeout:5000,maxBuffer:65536,
  env:Object.fromEntries(['PATH','Path','SystemRoot','TEMP','TMP'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]))});
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
});
test('fresh install is rejected before patching, idempotently repaired, and tampering fails closed',()=>{
 const temporary=mkdtempSync(join(tmpdir(),'replynest-braces-regression-'));
 try{
  const directory=join(temporary,'node_modules/braces');mkdirSync(join(directory,'lib'),{recursive:true});
  writeFileSync(join(temporary,'package-lock.json'),JSON.stringify({packages:{'node_modules/braces':{version:'3.0.3'}}}));
  writeFileSync(join(directory,'package.json'),JSON.stringify({version:'3.0.3'}));
  for(const edit of bracesPatchEdits){
   let original=readFileSync(req.resolve('braces/lib/'+edit.file),'utf8');
   for(const [before,after] of [...edit.replacements].reverse())original=original.replace(after,before);
   writeFileSync(join(directory,'lib',edit.file),original);
  }
  assert.throws(()=>verifyBracesGuard({projectRoot:temporary}),/patch_not_installed/);
  assert.equal(verifyBracesGuard({projectRoot:temporary,apply:true}).length,4);
  assert.deepEqual(verifyBracesGuard({projectRoot:temporary}),verifyBracesGuard({projectRoot:temporary,apply:true}));
  const file=join(directory,'lib/compile.js');writeFileSync(file,readFileSync(file,'utf8')+'\n// tampered');
  assert.throws(()=>verifyBracesGuard({projectRoot:temporary}),/hash_mismatch/);
  assert.throws(()=>verifyBracesGuard({projectRoot:temporary,apply:true}),/hash_mismatch/);
 }finally{
  assert.ok(realpathSync(temporary).startsWith(realpathSync(tmpdir())+sep));
  assert.ok(resolve(temporary).includes('replynest-braces-regression-'));rmSync(temporary,{recursive:true});
 }
});
