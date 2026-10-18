'use client';
import {useEffect,useState} from 'react';

export type WorkbenchThemePreference='system'|'light'|'dark';
export function parseWorkbenchTheme(value:unknown):WorkbenchThemePreference{return value==='light'||value==='dark'?value:'system';}
export function resolveWorkbenchTheme(preference:WorkbenchThemePreference,systemDark:boolean){return preference==='system'?(systemDark?'dark':'light'):preference;}
export function workbenchThemeKey(preferenceKey:string){return `rn:workbench-color:v1:${preferenceKey}`;}

/** Local appearance preference only; no permission, profile or server writes. */
export function useWorkbenchTheme(preferenceKey:string){
 const key=workbenchThemeKey(preferenceKey);
 const [state,setState]=useState<{key:string;preference:WorkbenchThemePreference;systemDark:boolean}>({key:'',preference:'system',systemDark:false});
 useEffect(()=>{
  let preference:WorkbenchThemePreference='system';try{preference=parseWorkbenchTheme(localStorage.getItem(key));}catch{}
  const media=typeof window.matchMedia==='function'?window.matchMedia('(prefers-color-scheme: dark)'):null;
  setState({key,preference,systemDark:media?.matches??false});
  const changed=()=>setState(old=>old.key===key?{...old,systemDark:media?.matches??false}:old);
  const storage=(event:StorageEvent)=>{if(event.key===key||event.key===null){let value:unknown=null;try{value=localStorage.getItem(key);}catch{}setState(old=>old.key===key?{...old,preference:parseWorkbenchTheme(value)}:old);}};
  media?.addEventListener('change',changed);window.addEventListener('storage',storage);
  return()=>{media?.removeEventListener('change',changed);window.removeEventListener('storage',storage);};
 },[key]);
 const ready=state.key===key,preference=ready?state.preference:'system',scheme=resolveWorkbenchTheme(preference,ready&&state.systemDark);
 useEffect(()=>{
  if(!ready)return;
  const previous=document.body.getAttribute('data-studio-theme');document.body.setAttribute('data-studio-theme',scheme);
  return()=>{if(document.body.getAttribute('data-studio-theme')===scheme){if(previous===null)document.body.removeAttribute('data-studio-theme');else document.body.setAttribute('data-studio-theme',previous);}};
 },[ready,scheme]);
 function choose(value:WorkbenchThemePreference){setState(old=>({key,preference:value,systemDark:old.key===key?old.systemDark:false}));try{localStorage.setItem(key,value);}catch{}}
 return {ready,preference,scheme,choose};
}
