// Compatibility for filenames previously decoded by Busboy's Latin-1 default.
// Only repair strings with C1 controls and a lossless valid UTF-8 round trip.
// Never rewrite stored keys or infer a different storage location.
export function readableUploadFilename(value:string):string{
 if(!/[\u0080-\u009f]/.test(value)||[...value].some(c=>c.charCodeAt(0)>255))return value;
 const bytes=Buffer.from(value,'latin1');
 try{
  const decoded=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  return Buffer.from(decoded,'utf8').equals(bytes)&&!/[\u0000-\u001f\u007f-\u009f]/.test(decoded)?decoded:value;
 }catch{return value;}
}
