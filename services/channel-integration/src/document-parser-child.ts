import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { DOCUMENT_LIMITS,boundedDocumentText,validateDocxArchive } from './document-parser-limits.js';

// Single document per isolated process; no provider, database or storage imports.
try{
  const chunks:Buffer[]=[];let size=0;
  for await(const part of process.stdin){size+=part.length;if(size>DOCUMENT_LIMITS.inputBytes)throw new Error();chunks.push(part);}
  const data=Buffer.concat(chunks),format=process.argv[2];
  let result;
  if(format==='docx'){
    validateDocxArchive(data);
    const parsed=await mammoth.extractRawText({buffer:data});
    const text=boundedDocumentText(parsed.value.trim());
    result={text,ocrRequired:!text,metadata:{format,warnings:parsed.messages.length}};
  }else if(format==='pdf'){
    const parser=new PDFParse({data:new Uint8Array(data)});
    try{
      const info=await parser.getInfo();
      if(info.total>DOCUMENT_LIMITS.pages)throw new Error();
      const parsed=await parser.getText();
      const text=boundedDocumentText(parsed.text.trim());
      result={text,ocrRequired:text.length<20,metadata:{format,pages:parsed.total}};
    }finally{await parser.destroy();}
  }else throw new Error();
  const output=JSON.stringify(result);
  if(Buffer.byteLength(output)>DOCUMENT_LIMITS.outputBytes)throw new Error();
  process.stdout.write(output);
}catch{process.exitCode=2;}
