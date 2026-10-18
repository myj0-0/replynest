// Default tests never inherit operator credentials, feature flags or database URLs.
// Database integration suites remain an explicit, separately configured command.
import {spawnSync} from 'node:child_process';
import {readdirSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {unitEnvironment} from './unit-environment.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const env=unitEnvironment();
const tests=readdirSync(resolve(root,'src')).filter(n=>n.endsWith('.test.ts')).sort().map(n=>'dist/'+n.replace(/\.ts$/,'.js'));
if(!tests.length||tests.some(n=>!existsSync(resolve(root,n))))throw Error('Build the gateway before running unit tests');
const result=spawnSync(process.execPath,['--test','--test-concurrency=4','--test-reporter=tap',...tests],{cwd:root,env,encoding:'utf8',timeout:240000,maxBuffer:16*1024*1024});
const log=(result.stdout??'')+'\n'+(result.stderr??'');
const directory=resolve(root,'../../output/code-review/unit-tests');mkdirSync(directory,{recursive:true});
writeFileSync(resolve(directory,'gateway.tap'),log);
const count=name=>Number(log.match(new RegExp('^# '+name+' (\\d+)$','m'))?.[1]??0);
const report={files:tests.length,tests:count('tests'),passed:count('pass'),failed:count('fail'),skipped:count('skipped'),
 safe_environment:true,database_integration_enabled:false,success:result.status===0&&count('tests')>0&&count('fail')===0};
writeFileSync(resolve(directory,'gateway.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
if(!report.success){console.error(log);process.exitCode=1;}
