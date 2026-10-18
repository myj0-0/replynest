import { inflateRawSync } from 'node:zlib';

export const DOCUMENT_LIMITS = Object.freeze({inputBytes:10*1024*1024,textBytes:1024*1024,
  outputBytes:2*1024*1024,pages:200,chunks:1500,entries:2048,expandedBytes:32*1024*1024,
  entryBytes:8*1024*1024,timeoutMs:20_000,heapMb:192});

export function boundedDocumentText(text: string) {
  if (Buffer.byteLength(text,'utf8') > DOCUMENT_LIMITS.textBytes) throw new Error('document_text_limit');
  return text;
}

/** Preflight actual inflated sizes, not just attacker-controlled ZIP metadata. Runs in child. */
export function validateDocxArchive(data: Buffer) {
  let end = -1;
  for(let i=data.length-22;i>=Math.max(0,data.length-65557);i--){
    if(data.readUInt32LE(i)===0x06054b50 && i+22+data.readUInt16LE(i+20)===data.length){end=i;break;}
  }
  if(end<0)throw new Error('document_zip_invalid');
  const count=data.readUInt16LE(end+10), size=data.readUInt32LE(end+12),start=data.readUInt32LE(end+16);
  if(data.readUInt16LE(end+4)!==0||data.readUInt16LE(end+6)!==0||data.readUInt16LE(end+8)!==count||
    !count||count>DOCUMENT_LIMITS.entries||start+size!==end)throw new Error('document_zip_limit');
  let cursor=start,total=0;
  const names=new Set<string>();
  for(let i=0;i<count;i++){
    if(cursor+46>end||data.readUInt32LE(cursor)!==0x02014b50)throw new Error('document_zip_invalid');
    const flags=data.readUInt16LE(cursor+8),method=data.readUInt16LE(cursor+10),compressed=data.readUInt32LE(cursor+20),
      expanded=data.readUInt32LE(cursor+24),nameLength=data.readUInt16LE(cursor+28),extra=data.readUInt16LE(cursor+30),
      comment=data.readUInt16LE(cursor+32),local=data.readUInt32LE(cursor+42);
    if(cursor+46+nameLength+extra+comment>end||!nameLength)throw new Error('document_zip_invalid');
    const name=data.subarray(cursor+46,cursor+46+nameLength).toString('utf8');
    if(names.has(name)||name.includes('\\')||name.startsWith('/')||name.split('/').includes('..')||name.includes('\0'))throw new Error('document_zip_invalid');
    names.add(name);
    if((flags&1)!==0||![0,8].includes(method)||data.readUInt16LE(cursor+34)!==0||expanded>DOCUMENT_LIMITS.entryBytes||
      expanded>Math.max(1024*1024,compressed*200)||total+expanded>DOCUMENT_LIMITS.expandedBytes)
      throw new Error('document_zip_limit');
    if(local+30>start||data.readUInt32LE(local)!==0x04034b50||data.readUInt16LE(local+8)!==method||data.readUInt16LE(local+6)!==flags)
      throw new Error('document_zip_invalid');
    const localName=data.readUInt16LE(local+26),localExtra=data.readUInt16LE(local+28),offset=local+30+localName+localExtra;
    if(offset+compressed>start||!data.subarray(local+30,local+30+localName).equals(data.subarray(cursor+46,cursor+46+nameLength)))throw new Error('document_zip_invalid');
    const part=data.subarray(offset,offset+compressed);
    const actual=method===0?part:inflateRawSync(part,{maxOutputLength:DOCUMENT_LIMITS.entryBytes});
    if(actual.length!==expanded)throw new Error('document_zip_size_mismatch');
    total+=actual.length;
    cursor+=46+nameLength+extra+comment;
  }
  if(cursor!==end||!names.has('[Content_Types].xml')||!names.has('word/document.xml'))throw new Error('document_zip_invalid');
}
