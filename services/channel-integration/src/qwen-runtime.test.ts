import test from 'node:test';import assert from 'node:assert/strict';
import {qwenText,qwenEmbedding,qwenRuntimeConfig} from './qwen-runtime.js';
test('strict output format is sent once, retains max token bound and never silently falls back',async()=>{
 const before={key:process.env.QWEN_API_KEY,base:process.env.QWEN_BASE_URL};process.env.QWEN_API_KEY='synthetic-test-only';process.env.QWEN_BASE_URL='https://dashscope.aliyuncs.com/compatible-mode/v1';
 const format={type:'json_schema' as const,json_schema:{name:'synthetic_schema',strict:true as const,schema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}}};
 let calls=0,body:any;
 const fetcher=(async(_url:any,options:any)=>{calls++;body=JSON.parse(options.body);return new Response(JSON.stringify({usage:{prompt_tokens:12,completion_tokens:4},choices:[{finish_reason:'stop',message:{content:'{"value":"ok"}'}}]}));}) as typeof fetch;
 try{
  await qwenText([{role:'user',content:'JSON'}],1200,fetcher,true,format);
  assert.equal(calls,1);assert.deepEqual(body.response_format,format);assert.equal(body.max_tokens,1200);assert.equal(body.enable_thinking,false);
  await assert.rejects(()=>qwenText([{role:'user',content:'JSON'}],1200,(async()=>{calls++;return new Response('{}',{status:400});}) as typeof fetch,true,format),/qwen_request_failed/);
  assert.equal(calls,2,'no fallback call after schema refusal');
  await assert.rejects(()=>qwenText([{role:'user',content:'JSON'}],1200,fetcher,false,format),/qwen_schema_invalid/);
  assert.equal(calls,2);
 }finally{for(const [key,value] of [['QWEN_API_KEY',before.key],['QWEN_BASE_URL',before.base]])if(value===undefined)delete process.env[key!];else process.env[key!]=value;}
});
test('Qwen runtime validates usage, bounds, rate limit and vector dimensions without real calls',async()=>{
 const saved={key:process.env.QWEN_API_KEY,base:process.env.QWEN_BASE_URL};process.env.QWEN_API_KEY='synthetic-test-only';process.env.QWEN_BASE_URL='https://dashscope.aliyuncs.com/compatible-mode/v1';
 const mock=(value:unknown,status=200)=>(async()=>new Response(JSON.stringify(value),{status})) as typeof fetch;
 try{
  const success=await qwenText([{role:'user',content:'test'}],4,mock({usage:{prompt_tokens:10,completion_tokens:1,total_tokens:11},choices:[{finish_reason:'stop',message:{content:'OK'}}]}));assert.equal(success.usage.input_tokens,10);
  await assert.rejects(()=>qwenText([{role:'user',content:'test'}],4,mock({},429)),/qwen_rate_limited/);
  await assert.rejects(()=>qwenText([{role:'user',content:'test'}],4,mock({choices:[{finish_reason:'stop',message:{content:'OK'}}]})),/qwen_usage_missing/);
  await assert.rejects(()=>qwenEmbedding('test',mock({usage:{prompt_tokens:1,total_tokens:1},data:[{embedding:[1]}]})),/qwen_invalid/);
  const vector=await qwenEmbedding('test',mock({usage:{prompt_tokens:1,total_tokens:1},data:[{embedding:Array(768).fill(.01)}]}));assert.equal(vector.dimensions,768);
  process.env.QWEN_BASE_URL='https://example.com';assert.throws(qwenRuntimeConfig,/configuration_invalid/);
 }finally{if(saved.key===undefined)delete process.env.QWEN_API_KEY;else process.env.QWEN_API_KEY=saved.key;if(saved.base===undefined)delete process.env.QWEN_BASE_URL;else process.env.QWEN_BASE_URL=saved.base;}
});
