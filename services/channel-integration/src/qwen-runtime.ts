import {secretValue} from './secret-value.js';
import {parseAiUsage,type AiUsage} from './ai-points-core.js';
export const TEXT_MODEL='qwen3.8-flash';
export const EMBEDDING_MODEL='qwen3.7-text-embedding-flash';
export class QwenError extends Error{constructor(public code:string,public usage?:AiUsage){super(code);}}
export function qwenRuntimeConfig(){
 const base=(process.env.QWEN_BASE_URL||process.env.EXTENSION_QWEN_BASE_URL||'https://maas.qianwenaiapi.com/compatible-mode/v1').replace(/\/$/,'');
 if(!['https://maas.qianwenaiapi.com/compatible-mode/v1','https://dashscope.aliyuncs.com/compatible-mode/v1'].includes(base))throw new QwenError('qwen_configuration_invalid');
 const key=secretValue('QWEN_API_KEY')||secretValue('EXTENSION_QWEN_API_KEY');
 if(!key)throw new QwenError('qwen_not_configured');
 return {base,key};
}
async function request(path:string,body:unknown,fetcher:typeof fetch,maxBytes:number){
 const {base,key}=qwenRuntimeConfig();let response:Response;
 try{response=await fetcher(base+path,{method:'POST',redirect:'error',signal:AbortSignal.timeout(45000),headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify(body)});}catch{throw new QwenError('qwen_unavailable');}
 if(!response.ok){await response.body?.cancel();throw new QwenError(response.status===429?'qwen_rate_limited':response.status===401||response.status===403?'qwen_auth_failed':'qwen_request_failed');}
 const reader=response.body?.getReader();if(!reader)throw new QwenError('qwen_invalid_response');
 const chunks:Uint8Array[]=[];let count=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;count+=value.length;if(count>maxBytes){await reader.cancel();throw Error();}chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new QwenError('qwen_invalid_response');}
}
export type QwenStrictResponseFormat={type:'json_schema';json_schema:{name:string;strict:true;schema:Record<string,unknown>}};
export async function qwenText(messages:{role:'system'|'user';content:string}[],maxTokens:number,fetcher:typeof fetch=fetch,json=false,format?:QwenStrictResponseFormat){
 if(!Number.isInteger(maxTokens)||maxTokens<1||maxTokens>5000||!messages.length||messages.some(m=>!['system','user'].includes(m.role)||typeof m.content!=='string')||Buffer.byteLength(JSON.stringify(messages))>64000)throw new QwenError('qwen_input_limit');
 if(format&&(!json||format.type!=='json_schema'||format.json_schema?.strict!==true||!/^[A-Za-z0-9_]{1,64}$/.test(format.json_schema.name)||
  !format.json_schema.schema||typeof format.json_schema.schema!=='object'||Array.isArray(format.json_schema.schema)||Buffer.byteLength(JSON.stringify(format))>24000))throw new QwenError('qwen_schema_invalid');
 const body=await request('/chat/completions',{model:TEXT_MODEL,messages,max_tokens:maxTokens,enable_thinking:false,stream:false,...(format?{response_format:format}:json?{response_format:{type:'json_object'}}:{})},fetcher,96000);
 let usage:AiUsage;try{usage=parseAiUsage(body.usage);}catch{throw new QwenError('qwen_usage_missing');}
 const text=body.choices?.[0]?.message?.content;
 if(typeof text!=='string'||!text.trim()||body.choices?.[0]?.finish_reason!=='stop')throw new QwenError('qwen_invalid_response',usage);
 return {text:text.trim(),model:TEXT_MODEL,usage};
}
export async function qwenEmbedding(text:string,fetcher:typeof fetch=fetch){
 if(typeof text!=='string'||!text.trim()||Buffer.byteLength(text)>64000)throw new QwenError('qwen_input_limit');
 const body=await request('/embeddings',{model:EMBEDDING_MODEL,input:text,dimensions:768,encoding_format:'float'},fetcher,128000);
 let usage:AiUsage;try{usage=parseAiUsage(body.usage,true);}catch{throw new QwenError('qwen_usage_missing');}
 const vector=body.data?.[0]?.embedding;
 if(body.data?.length!==1||!Array.isArray(vector)||vector.length!==768||!vector.every((n:unknown)=>typeof n==='number'&&Number.isFinite(n))||!vector.some((n:number)=>n!==0))throw new QwenError('qwen_invalid_vector',usage);
 return {vector:vector as number[],model:EMBEDDING_MODEL,dimensions:768,usage};
}
