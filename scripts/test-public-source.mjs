import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const files=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
test('public source excludes private inputs, history, generated files and media recordings',()=>{
 for(const file of files){
  assert.ok(!/(^|\/)(?:PW\.md|\.env|node_modules|\.next|\.docusaurus|output|outputs|artifacts|credentials|secrets)(?:\/|$)/.test(file),file);
  assert.ok(!/^docs\/(?:history|marketing)\//.test(file)&&!/^deploy\/(?:production|china-edge)\//.test(file),file);
  assert.ok(!/^apps\/help-docs\/build/.test(file)&&!/^scripts\/(?:release-|prepare-|.*-remote\.)/.test(file),file);
  assert.ok(!/\.(?:pem|key|p12|pfx|dump|gpg|mp4|webm|log)$/.test(file),file);
 }
});
test('official website and MIT are discoverable without old development records',()=>{
 const readme=readFileSync(resolve(root,'README.md'),'utf8');
 assert.match(readme.slice(0,1000),/https:\/\/replynest\.cn\//);
 assert.match(readFileSync(resolve(root,'LICENSE'),'utf8'),/MIT License/);
 assert.ok(existsSync(resolve(root,'THIRD_PARTY_NOTICES.md')));
 assert.ok(existsSync(resolve(root,'patches/chatwoot-v4.16.2-ce-saas-sso/UPSTREAM_LICENSE')));
 assert.ok(!files.includes('compose.production.yaml')&&!files.includes('docs/DEPLOYMENT_STATUS.md'));
});
test('current Markdown links refer to files included in this source snapshot',()=>{
 for(const name of files.filter(p=>p.endsWith('.md'))){
  const text=readFileSync(resolve(root,name),'utf8');
  for(const m of text.matchAll(/\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)){
   const target=m[1].split('#')[0];if(!target||target.startsWith('/')||/^[a-z]+:/i.test(target))continue;
   assert.ok(existsSync(resolve(root,dirname(name),decodeURIComponent(target))),name+' -> '+target);
  }
 }
});
