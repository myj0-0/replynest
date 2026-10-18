import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('Tinypool preserves worker API and ignores polluted inherited worker options',()=>{
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('./tinypool-pollution-fixture.mjs',import.meta.url))],{
  cwd:fileURLToPath(new URL('../',import.meta.url)),encoding:'utf8',timeout:10000,maxBuffer:65536,
  env:Object.fromEntries(['PATH','Path','SystemRoot','TEMP','TMP'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]))});
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
});
