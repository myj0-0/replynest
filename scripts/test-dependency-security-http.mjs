// Read-only loopback regression. Never accepts a production destination.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),mode=process.argv[2],base=new URL(process.argv[3]);
const reportRun=process.argv[4]??'dependency-security-20261016';
assert.match(reportRun,/^[a-z0-9][a-z0-9-]{0,79}$/);
assert.ok(['console','docs'].includes(mode));assert.equal(base.hostname,'127.0.0.1');
assert.equal(base.protocol,'http:');assert.equal(base.pathname,'/');assert.ok(!base.username&&!base.password&&!base.search);
let ready=false;
for(let i=0;i<60;i++){
 try{ready=(await fetch(new URL(mode==='console'?'/demo':'/',base),{signal:AbortSignal.timeout(1000)})).status===200;if(ready)break;}catch{}
 await new Promise(r=>setTimeout(r,200));
}
assert.ok(ready,'preview_not_ready');let checks=0;
const check=(v,label)=>{assert.ok(v,label);checks++;};
const fetchLocal=async(path,options={})=>{
 const url=new URL(path,base);assert.equal(url.origin,base.origin);
 return fetch(url,{...options,signal:AbortSignal.timeout(10000)});
};
let pages=0,assets=0;
if(mode==='console'){
 for(const route of ['/home','/en','/contact','/en/contact','/login','/register','/forgot-password','/reset-password','/legal/privacy','/legal/terms']){
  const r=await fetchLocal(route);const html=await r.text();
  check(r.status===200,route+' status');check(html.includes('<html'),route+' html');check(!r.headers.has('set-cookie'),route+' no session');pages++;
 }
 for(const route of ['/billing','/workbench','/settings/members']){
  const r=await fetchLocal(route,{redirect:'manual'});check([302,303,307,308].includes(r.status)&&r.headers.get('location')?.includes('/login'),route+' requires login');
 }
 for(const route of ['/api/quick-replies','/api/billing/checkout'])check((await fetchLocal(route)).status===401,route+' anonymous denied');
 check((await fetchLocal('/api/quick-replies/import')).status===405,'compiled XLSX import module loads and rejects GET');
 const logo=await fetchLocal('/_next/image?url=%2Freplynest-mark.png&w=256&q=75');
 check(logo.status===200&&logo.headers.get('content-type')?.startsWith('image/'),'patched Sharp resizes the local logo');await logo.arrayBuffer();
 const denied=await fetchLocal('/_next/image?url=http%3A%2F%2F127.0.0.1%3A9%2Fsynthetic.png&w=256&q=75');
 check(denied.status===400,'unapproved remote image rejected');
}else{
 const directory=resolve(root,'apps/help-docs/build');
 const walk=p=>readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(resolve(p,e.name)):[resolve(p,e.name)]);
 const htmlFiles=walk(directory).filter(p=>p.endsWith(sep+'index.html'));check(htmlFiles.length>=26,'both locales built');
 const references=new Set();
 for(const file of htmlFiles){
  const route='/'+relative(directory,file).split(sep).join('/').replace(/index\.html$/,'');
  const r=await fetchLocal(route);const text=await r.text();check(r.status===200,route+' status');
  check(text.includes('<html')&&!text.includes('<h1>Page Not Found</h1>'),route+' document');pages++;
  for(const m of text.matchAll(/(?:src|href)=["']([^"']+\.(?:png|jpg|jpeg|webp|svg|css|js))(?:\?[^"']*)?["']/g))if(m[1].startsWith('/')&&!m[1].startsWith('//'))references.add(m[1]);
 }
 for(const path of references)check((await fetchLocal(path,{method:'HEAD'})).status===200,path+' asset');assets=references.size;
 check(references.has('/img/replynest-brand-cn.png'),'packaged brand asset referenced');
}
const report={mode,passed:true,checks,pages,assets,report_run:reportRun,generated_at:new Date().toISOString(),loopback_only:true,real_logins:0,customer_messages:0,model_calls:0};
const out=resolve(root,'output',reportRun);mkdirSync(out,{recursive:true});
writeFileSync(resolve(out,mode+'-http.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
