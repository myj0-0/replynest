import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { UploadedFormat } from './file-security.js';
import { DOCUMENT_LIMITS, boundedDocumentText } from './document-parser-limits.js';

export type ParsedDocument = {text:string;ocrRequired:boolean;metadata:Record<string,unknown>};
let active=false;
export async function parseDocument(format: UploadedFormat, data: Buffer, spawnChild:typeof spawn=spawn): Promise<ParsedDocument> {
  if(!['text','markdown','docx','pdf'].includes(format))throw new Error('document_format_invalid');
  if(data.length>DOCUMENT_LIMITS.inputBytes)throw new Error('document_input_limit');
  if(format==='text'||format==='markdown')return {text:boundedDocumentText(data.toString('utf8').replace(/^\uFEFF/, '').trim()),ocrRequired:false,metadata:{format}};
  if(active)throw new Error('document_parser_busy');
  active=true;
  try{
    return await new Promise<ParsedDocument>((resolve,reject)=>{
      // No inherited DB/cloud credentials, NODE_OPTIONS, or shell. V8 heap is capped;
      // native allocations additionally need the worker container memory limit.
      const child=spawnChild(process.execPath,[`--max-old-space-size=${DOCUMENT_LIMITS.heapMb}`,
        fileURLToPath(new URL('./document-parser-child.js',import.meta.url)),format],
        {stdio:['pipe','pipe','ignore'],windowsHide:true,env:process.platform==='win32'?{SystemRoot:process.env.SystemRoot}: {}});
      let size=0,failure:Error|undefined;const chunks:Buffer[]=[];
      const stop=(reason:string)=>{failure??=new Error(reason);child.kill('SIGKILL');};
      const timer=setTimeout(()=>stop('document_parse_timeout'),DOCUMENT_LIMITS.timeoutMs);
      child.stdout.on('data',(chunk:Buffer)=>{
        size+=chunk.length;
        if(size>DOCUMENT_LIMITS.outputBytes)stop('document_output_limit');else if(!failure)chunks.push(chunk);
      });
      child.stdin.on('error',()=>stop('document_input_failed'));
      child.on('error',()=>{failure??=new Error('document_parser_start_failed');});
      child.on('close',code=>{
        clearTimeout(timer);
        if(failure||code!==0){reject(failure??new Error('document_parse_rejected'));return;}
        try{
          const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if(typeof result.text!=='string'||typeof result.ocrRequired!=='boolean'||!result.metadata)throw new Error();
          boundedDocumentText(result.text);resolve(result);
        }catch{reject(new Error('document_parse_invalid_result'));}
      });
      child.stdin.end(data);
    });
  }finally{active=false;}
}
