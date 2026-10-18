import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyBracesGuard} from './braces-depth-guard.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const blockedSeverities=['moderate','high','critical'];
export function auditFindings(audit,guardVerified){
 if(audit?.auditReportVersion!==2||audit.error||!audit.metadata?.vulnerabilities||!audit.vulnerabilities)throw Error('dependency_audit_unavailable');
 for(const severity of blockedSeverities){
  const declared=audit.metadata.vulnerabilities[severity];
  const actual=Object.values(audit.vulnerabilities).filter(v=>v.severity===severity).length;
  if(!Number.isSafeInteger(declared)||declared<0||declared!==actual)throw Error('dependency_audit_metadata_mismatch');
 }
 const roots=new Map(),blocked=[];
 for(const [name,v] of Object.entries(audit.vulnerabilities))for(const via of v.via??[]){
  if(typeof via==='string'||!blockedSeverities.includes(via.severity))continue;
  const id=via.url?.split('/').at(-1);
  const mitigated=guardVerified&&name==='braces'&&via.name==='braces'&&via.severity==='high'&&via.url==='https://github.com/advisories/GHSA-vfj7-8cjw-p6xm'&&via.range==='<=3.0.3';
  const finding={name,id,severity:via.severity,mitigated};
  if(roots.has(via.source)&&JSON.stringify(roots.get(via.source))!==JSON.stringify(finding))throw Error('dependency_audit_conflicting_advisory');
  roots.set(via.source,finding);
 }
 // Parent-only moderate+ entries must resolve to known advisory roots. Unknown or
 // cyclic metadata fails closed; package names alone never create exceptions.
 const resolveRoots=(name,seen=new Set())=>{
  if(seen.has(name))throw Error('dependency_audit_cycle');
  const v=audit.vulnerabilities[name];if(!v)throw Error('dependency_audit_unknown_path');
  const next=new Set(seen);next.add(name);let count=0;
  for(const via of v.via??[]){
   if(typeof via==='string')count+=resolveRoots(via,next);
   else if(blockedSeverities.includes(via.severity)){count++;const r=roots.get(via.source);if(!r?.mitigated)blocked.push(r??{name,id:'unknown'});}
  }
  return count;
 };
 for(const [name,v] of Object.entries(audit.vulnerabilities))if(blockedSeverities.includes(v.severity)&&resolveRoots(name)===0)throw Error('dependency_audit_unresolved_path');
 return {raw:audit.metadata.vulnerabilities,advisories:[...roots.values()],unmitigated:[...new Map(blocked.map(v=>[v.id,v])).values()]};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const proof=verifyBracesGuard();
 if(!process.env.npm_execpath)throw Error('Run through npm run security:check');
 const r=spawnSync(process.execPath,[process.env.npm_execpath,'audit','--json'],{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
 if(r.error||![0,1].includes(r.status))throw Error('dependency_audit_command_failed');
 const result=auditFindings(JSON.parse(r.stdout),proof.length>0);
 console.log(JSON.stringify({status:result.unmitigated.length?'blocked':'no_unmitigated_moderate_or_higher',...result}));
 if(result.unmitigated.length)process.exitCode=1;
}
