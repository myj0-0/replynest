'use client';
import {useState} from 'react';

export function customerInitial(name?:string|null){
 const value=name?.trim();if(!value)return '?';
 // A UTF-16 slice breaks emoji names. Keep the whole first grapheme, including ZWJ/flags.
 return (typeof Intl.Segmenter==='function'?new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(value)[Symbol.iterator]().next().value?.segment:Array.from(value)[0])?.toLocaleUpperCase()??'?';
}
export function authorizedAvatarUrl(value?:string|null){
 if(!value||value.length>2048)return undefined;
 try{const u=new URL(value);return u.protocol==='https:'&&/(^|\.)qlogo\.cn$/.test(u.hostname)&&!u.username&&!u.password?u.href:undefined;}catch{return undefined;}
}
export function CustomerAvatar({name,url,en=false}:{name?:string|null;url?:string|null;en?:boolean}){
 const src=authorizedAvatarUrl(url),[failed,setFailed]=useState<string>();
 return <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-xl bg-slate-100 font-semibold text-[var(--brand-700)]">
  {src&&failed!==src?<img src={src} alt={en?'Authorized customer avatar':'客户授权头像'} referrerPolicy="no-referrer" loading="lazy" className="size-full object-cover" onError={()=>setFailed(src)}/>:<span aria-hidden="true">{customerInitial(name)}</span>}
 </span>;
}
