import assert from "node:assert/strict";
import test from "node:test";
import { parseDocument } from "./document-parser.js";
import { DOCUMENT_LIMITS,validateDocxArchive } from './document-parser-limits.js';
import { crc32 } from 'node:zlib';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

test("parses UTF-8 text and strips BOM", async () => {
  const parsed = await parseDocument("text", Buffer.from("\uFEFF合成退款规则\n仅用于测试"));
  assert.equal(parsed.text, "合成退款规则\n仅用于测试");
  assert.equal(parsed.ocrRequired, false);
  assert.deepEqual(parsed.metadata, { format: "text" });
});

function docx(){
  const files=[['[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>安全解析测试</w:t></w:r></w:p></w:body></w:document>']];
  const locals:Buffer[]=[],centrals:Buffer[]=[];let offset=0;
  for(const [name,text] of files){
    const n=Buffer.from(name),b=Buffer.from(text),l=Buffer.alloc(30),c=Buffer.alloc(46);
    l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt32LE(crc32(b),14);l.writeUInt32LE(b.length,18);l.writeUInt32LE(b.length,22);l.writeUInt16LE(n.length,26);
    c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt32LE(crc32(b),16);c.writeUInt32LE(b.length,20);c.writeUInt32LE(b.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);
    locals.push(l,n,b);centrals.push(c,n);offset+=l.length+n.length+b.length;
  }
  const central=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,central,end]);
}
test('text/input caps are enforced before expensive processing',async()=>{
  await assert.rejects(parseDocument('text',Buffer.alloc(DOCUMENT_LIMITS.textBytes+1,65)),/text_limit/);
  await assert.rejects(parseDocument('pdf',Buffer.alloc(DOCUMENT_LIMITS.inputBytes+1)),/input_limit/);
});
test('valid DOCX parses in a child; malformed archive and forged expanded size fail',async()=>{
  const valid=docx();validateDocxArchive(valid);
  assert.match((await parseDocument('docx',valid)).text,/安全解析测试/);
  const forged=Buffer.from(valid),central=forged.readUInt32LE(forged.length-6);
  forged.writeUInt32LE(DOCUMENT_LIMITS.entryBytes+1,central+24);
  assert.throws(()=>validateDocxArchive(forged),/zip_limit/);
  forged.writeUInt32LE(1,central+24);
  assert.throws(()=>validateDocxArchive(forged),/zip_size_mismatch/);
  assert.throws(()=>validateDocxArchive(Buffer.from('not zip')),/zip_invalid/);
  await assert.rejects(parseDocument('docx',Buffer.from('not zip')),/parse_rejected/);
});
test('parser deadline kills the child and never forwards parent credentials',async context=>{
  context.mock.timers.enable({apis:['setTimeout']});
  let killed=false;
  const child=new EventEmitter() as any;child.stdout=new PassThrough();child.stdin=new PassThrough();
  child.kill=(signal:string)=>{assert.equal(signal,'SIGKILL');killed=true;child.emit('close',null);};
  const result=parseDocument('pdf',Buffer.from('synthetic'),((_exe:any,args:any,options:any)=>{
    assert.ok(args.includes('--max-old-space-size=192'));assert.equal(options.windowsHide,true);
    assert.ok(Object.keys(options.env).every(key=>key==='SystemRoot'));return child;
  }) as never);
  const assertion=assert.rejects(result,/parse_timeout/);
  context.mock.timers.tick(DOCUMENT_LIMITS.timeoutMs+1);await assertion;assert.equal(killed,true);
});

function pdf(pages:number){
  const fontId=3+pages*2;
  const objects=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Count ${pages} /Kids [${Array.from({length:pages},(_,i)=>`${3+i*2} 0 R`).join(' ')}] >>`];
  const text='BT /F1 12 Tf 30 100 Td (Synthetic parser boundary test document) Tj ET';
  for(let i=0;i<pages;i++)objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4+i*2} 0 R >>`,`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let output='%PDF-1.4\n';const offsets=[0];
  objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(output));output+=`${i+1} 0 obj\n${object}\nendobj\n`;});
  const start=Buffer.byteLength(output);
  output+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n`+offsets.slice(1).map(x=>`${String(x).padStart(10,'0')} 00000 n \n`).join('');
  output+=`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(output);
}
test('valid PDF parses in child and document page limit rejects oversized page count',async()=>{
  const result=await parseDocument('pdf',pdf(1));
  assert.match(result.text,/Synthetic parser boundary/);assert.equal(result.metadata.pages,1);
  await assert.rejects(parseDocument('pdf',pdf(DOCUMENT_LIMITS.pages+1)),/parse_rejected/);
});
