import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,sep} from 'node:path';
import {createServer,type Socket} from 'node:net';
import {fileURLToPath} from 'node:url';
import {parseDocument} from './document-parser.js';

const require=createRequire(import.meta.url);
const root=fileURLToPath(new URL('../',import.meta.url));
const childEnv=Object.fromEntries(['PATH','Path','SystemRoot','TEMP','TMP'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]!]));
const run=(args:string[])=>spawnSync(process.execPath,args,{cwd:root,env:childEnv,encoding:'utf8',timeout:5000,maxBuffer:65536});

test('SDK resolves fixed IP and date dependencies without changing SDK versions',()=>{
 const fromTea=createRequire(require.resolve('@darabonba/typescript'));
 const fromSocks=createRequire(require.resolve('socks'));
 assert.equal(require('ip-address/package.json').version,'10.7.4');
 assert.equal(require('moment/package.json').version,'2.31.0');
 assert.equal(fromSocks.resolve('ip-address'),require.resolve('ip-address'));
 assert.equal(fromTea.resolve('moment'),require.resolve('moment'));
 assert.equal(require('@alicloud/dysmsapi20170525/package.json').version,'4.6.0');
});

test('IP classification rejects cross-family subnet matches and recognizes complete local ranges',()=>{
 const {Address4,Address6}=require('ip-address');
 for(const ip of ['fe80::1','fea0::1','febf::1'])assert.equal(new Address6(ip).isLinkLocal(),true);
 assert.equal(new Address6('fec0::1').isLinkLocal(),false);
 assert.equal(new Address6('64:ff9b:1::1').isPrivate(),true);
 assert.equal(new Address6('64:ff9b:1::1').getType(),'NAT64 (local-use)');
 for(const method of ['isInSubnet','isHostInSubnet']){
  assert.equal(new Address6('::1')[method](new Address4('0.0.0.0/0')),false);
  assert.equal(new Address4('127.0.0.1')[method](new Address6('::/0')),false);
 }
 assert.equal(new Address6('2001:db8::7').isInSubnet(new Address6('2001:db8::/32')),true);
});

test('oversized IPv6 diagnostics remain bounded in an isolated process',()=>{
 const result=run(['-e',"const {Address6}=require('ip-address');try{new Address6('a'.repeat(1000000));process.exit(2)}catch(e){if(e.message.length>1024)process.exit(3)}"]);
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
});

test('SDK SOCKS5 transport still negotiates IPv6 using an isolated loopback proxy',async context=>{
 const peers=new Set<Socket>();let requested:Buffer|undefined;
 const server=createServer(socket=>{
  peers.add(socket);socket.on('close',()=>peers.delete(socket));socket.on('error',()=>{});
  let buffer=Buffer.alloc(0),stage=0;
  socket.on('data',chunk=>{
   buffer=Buffer.concat([buffer,chunk]);
   if(stage===0&&buffer.length>=2+buffer[1]){buffer=buffer.subarray(2+buffer[1]);stage=1;socket.write(Buffer.from([5,0]));}
   if(stage===1&&buffer.length>=22){requested=Buffer.from(buffer);stage=2;socket.write(Buffer.from([5,0,0,1,127,0,0,1,31,144]));}
  });
 });
 context.after(async()=>{for(const peer of peers)peer.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const address=server.address();assert.ok(address&&typeof address!=='string');
 const {socket}=await require('socks').SocksClient.createConnection({proxy:{host:'127.0.0.1',port:address.port,type:5},command:'connect',destination:{host:'2001:db8::7',port:443},timeout:2000});
 socket.destroy();assert.ok(requested);assert.equal(requested[3],4);assert.equal(requested.readUInt16BE(20),443);
 assert.equal(requested.subarray(4,20).toString('hex'),'20010db8000000000000000000000007');
});

test('date formatting, SDK date wrapper and timezone conversions remain compatible',()=>{
 const moment=require('moment'),TeaDate=require('@darabonba/typescript/dist/date').default;
 assert.equal(moment.utc('2026-10-17T00:00:00Z').format('YYYY-MM-DDTHH:mm:ss[Z]'),'2026-10-17T00:00:00Z');
 assert.equal(new TeaDate('2026-10-17T00:00:00Z').unix(),1792195200);
 assert.equal(require('moment-timezone').tz('2026-10-17 08:00','Asia/Shanghai').utc().format('HH:mm'),'00:00');
 assert.match(require('@alicloud/openapi-util').default.getTimestamp(),/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});

test('crafted non-string locale cannot trigger a relative module load',()=>{
 const result=run(['-e',`const moment=require('moment'),Module=require('module'),original=Module._load;let loads=0;
  Module._load=function(name,...rest){if(name.startsWith('./locale/')){loads++;throw Error('unexpected locale load')}return original.call(this,name,...rest)};
  try{moment.locale({toLowerCase(){return {replace(){return '../package'}}}})}catch{}
  Module._load=original;if(loads!==0)process.exit(2);`]);
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
});

async function syntheticDocx(){
 const fromMammoth=createRequire(require.resolve('mammoth')),Zip=fromMammoth('jszip'),zip=new Zip();
 zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
 zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>合成知识文档</w:t></w:r></w:p><w:p><w:r><w:t>Offline dependency regression</w:t></w:r></w:p></w:body></w:document>');
 return zip.generateAsync({type:'nodebuffer',compression:'STORE'});
}

test('Mammoth raw extraction still works through the real bounded child parser',async()=>{
 const result=await parseDocument('docx',await syntheticDocx());
 assert.equal(result.text,'合成知识文档\n\nOffline dependency regression');assert.equal(result.ocrRequired,false);
 const fromMammoth=createRequire(require.resolve('mammoth'));
 assert.equal(fromMammoth('argparse/package.json').version,'2.0.1');
 assert.throws(()=>fromMammoth.resolve('sprintf-js'),{code:'MODULE_NOT_FOUND'});
});

test('Mammoth CLI retains help, validation, HTML and Markdown with argparse 2',async()=>{
 const cli=require.resolve('mammoth/bin/mammoth'),directory=mkdtempSync(join(tmpdir(),'replynest-docx-dependency-'));
 try{
  const file=join(directory,'synthetic.docx');writeFileSync(file,await syntheticDocx());
  const help=run([cli,'--help']);assert.equal(help.status,0);assert.match(help.stdout,/--output-format/);
  for(const format of ['html','markdown']){
   const result=run([cli,file,'--output-format',format]);assert.equal(result.status,0,result.stderr);
   assert.match(result.stdout,/合成知识文档/);assert.match(result.stdout,/Offline dependency regression/);
   if(format==='html')assert.match(result.stdout,/<p>合成知识文档<\/p>/);
  }
  const invalid=run([cli,file,'--output-format','invalid']);assert.equal(invalid.status,2);assert.match(invalid.stderr,/invalid choice/);
  const exclusive=run([cli,file,join(directory,'unused.html'),'--output-dir',directory]);assert.equal(exclusive.status,2);
 }finally{
  assert.ok(realpathSync(directory).startsWith(realpathSync(tmpdir())+sep));assert.ok(directory.includes('replynest-docx-dependency-'));
  rmSync(directory,{recursive:true});
 }
});
