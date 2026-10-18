/** One bounded byte range only; no multipart amplification. */
export function mediaByteRange(raw:string|undefined,size:number):{start:number;end:number}|null|undefined{
  if(raw===undefined)return undefined;
  const match=/^bytes=(\d*)-(\d*)$/.exec(raw);
  if(!match||(!match[1]&&!match[2])||!Number.isSafeInteger(size)||size<1)return null;
  const suffix=match[1]==='';
  const first=Number(match[1]||match[2]),last=match[2]?Number(match[2]):size-1;
  if(!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||first<0||last<0)return null;
  if(suffix)return first>0?{start:Math.max(0,size-first),end:size-1}:null;
  if(first>=size||last<first)return null;
  return {start:first,end:Math.min(size-1,last)};
}
