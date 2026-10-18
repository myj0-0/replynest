import test from 'node:test';import assert from 'node:assert/strict';
import {Readable} from 'node:stream';import type {IncomingMessage} from 'node:http';import type {Pool,PoolClient} from 'pg';
import {readKnowledgeMultipart,readSingleFileMultipart} from './multipart-upload.js';
import {readableUploadFilename} from './upload-filename.js';
for(const name of ['POSTGRES_HOST','POSTGRES_DATABASE','POSTGRES_USERNAME','POSTGRES_PASSWORD'])process.env[name]??='synthetic-unused';
const {getTenantAiSettings}=await import('./tenant-ai-settings.js');
const {queueKnowledgeReprocessing,KnowledgeProcessingBusy}=await import('./knowledge-retry.js');
function multipart(filename:string,extended=false){
 const body=Buffer.from(`--test-boundary\r\nContent-Disposition: form-data; name="title"\r\n\r\n中文标题\r\n--test-boundary\r\nContent-Disposition: form-data; name="file"; ${extended?"filename*=UTF-8''"+encodeURIComponent(filename):'filename="'+filename+'"'}\r\nContent-Type: text/plain\r\n\r\n通常在两个工作日内发货\r\n--test-boundary--\r\n`);
 const request=Readable.from([body]) as IncomingMessage;request.headers={'content-type':'multipart/form-data; boundary=test-boundary'};return request;
}
for(const [label,reader] of [['knowledge',readKnowledgeMultipart],['attachment',readSingleFileMultipart]] as const){
 test(label+' upload keeps Chinese filename and body',async()=>{
  const file=await reader(multipart('商家A合成验收发货说明.txt'));assert.equal(file.filename,'商家A合成验收发货说明.txt');assert.equal(file.data.toString(),'通常在两个工作日内发货');
 });
 test(label+' upload honours explicitly encoded filename',async()=>assert.equal((await reader(multipart('中文.txt',true))).filename,'中文.txt'));
}
test('legacy filename display repair is lossless and does not touch valid filenames',()=>{
 const name='商家A合成验收发货说明.txt';assert.equal(readableUploadFilename(Buffer.from(name).toString('latin1')),name);
 for(const valid of [name,'résumé.txt','plain.txt','bad\u0081.txt','../中文.txt'])assert.equal(readableUploadFilename(valid),valid);
});
test('missing settings read safe defaults only for an existing usable tenant',async()=>{
 const calls:string[]=[];const db={query:async(sql:string,v:unknown[])=>{calls.push(sql);assert.deepEqual(v,['pilot']);return {rows:calls.length===1?[]:[{tenant_id:'pilot',updated_at:'2026-10-02'}]};}} as unknown as Pick<Pool,'query'>;
 const before=process.env.QWEN_UNIFIED_ENABLED;try{process.env.QWEN_UNIFIED_ENABLED='true';const s=await getTenantAiSettings('pilot',db);assert.equal(s.embedding_provider,'qwen');assert.equal(s.llm_model,'qwen3.8-flash');assert.ok(calls.every(s=>s.startsWith('SELECT')));assert.match(calls[1],/status IN \('active','test'\)/);assert.equal('automatic_sending_enabled' in s,false);}finally{if(before===undefined)delete process.env.QWEN_UNIFIED_ENABLED;else process.env.QWEN_UNIFIED_ENABLED=before;}
});
test('missing or disabled tenant never gets defaults',async()=>{
 await assert.rejects(getTenantAiSettings('absent',{query:async()=>({rows:[]})} as unknown as Pick<Pool,'query'>),/ai_settings_unavailable/);
});
test('existing settings are preserved when unified provider is disabled',async()=>{
 const row={tenant_id:'t',llm_provider:'deterministic',embedding_provider:'none'};const before=process.env.QWEN_UNIFIED_ENABLED;
 try{process.env.QWEN_UNIFIED_ENABLED='false';assert.equal(await getTenantAiSettings('t',{query:async()=>({rows:[row]})} as unknown as Pick<Pool,'query'>),row);}finally{if(before===undefined)delete process.env.QWEN_UNIFIED_ENABLED;else process.env.QWEN_UNIFIED_ENABLED=before;}
});
function retryClient(document:unknown,pending=false){const calls:{sql:string;values?:unknown[]}[]=[];return {calls,client:{query:async(sql:string,values?:unknown[])=>{calls.push({sql,values});if(sql.startsWith('SELECT status'))return {rows:document?[document]:[]};if(sql.startsWith('SELECT 1'))return {rows:[],rowCount:pending?1:0};if(sql.includes('INSERT INTO knowledge_jobs'))return {rows:[{job_id:'synthetic',status:'queued'}]};return {rows:[]};}} as unknown as PoolClient};}
const uploaded={status:'draft',scan_status:'clean',parse_status:'parsed',storage_key:'synthetic-clean',content_format:'text'};
test('safe upload draft retries the full scanning path without deleting ready vectors',async()=>{
 const f=retryClient(uploaded);assert.ok(await queueKnowledgeReprocessing(f.client,'t','d'));
 assert.ok(f.calls.some(c=>c.values?.[2]==='parse_and_index'));assert.ok(!f.calls.some(c=>c.sql.includes('knowledge_chunks')));assert.ok(f.calls.every(c=>c.values?.[0]==='t'));
});
for(const [name,document] of Object.entries({missing:null,market:{...uploaded,scan_status:'not_required',parse_status:'ready',storage_key:null},unscanned:{...uploaded,scan_status:'pending'},blocked:{...uploaded,parse_status:'blocked'},inactive:{...uploaded,status:'inactive'}}))test('retry rejects '+name,async()=>{
 const f=retryClient(document);assert.equal(await queueKnowledgeReprocessing(f.client,'t','d'),undefined);assert.equal(f.calls.length,1);
});
test('pending processing prevents duplicate retry and charge',async()=>{
 const f=retryClient(uploaded,true);await assert.rejects(queueKnowledgeReprocessing(f.client,'t','d'),KnowledgeProcessingBusy);assert.equal(f.calls.length,2);
});
test('active document uses ordinary re-index job',async()=>{
 const f=retryClient({...uploaded,status:'active'});await queueKnowledgeReprocessing(f.client,'t','d');assert.ok(f.calls.some(c=>c.values?.[2]==='embed_document'));assert.ok(f.calls.some(c=>c.sql.includes("embedding_status='stale'")));
});
