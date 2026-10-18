import {ExtensionError} from './extension-core.js';

// Public text only. No names, attachments, internal notes or upstream identifiers.
export function intentMessages(raw:Record<string,unknown>[]) {
  let remaining=6000;
  return raw.filter(m=>m.private===false&&[0,1,'incoming','outgoing'].includes(m.message_type as string|number)&&typeof m.content==='string')
    .sort((a,b)=>Number(b.id)-Number(a.id)).slice(0,20).map(m=>{
      const text=String(m.content).replace(/<[^>]*>/g,' ').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[邮箱]').replace(/(?:\+?\d[\d -]{6,}\d)/g,'[号码]').slice(0,Math.min(1000,remaining));remaining-=text.length;
      return {role:[0,'incoming'].includes(m.message_type as number|string)?'customer':'agent',text};
    }).filter(m=>m.text.trim()).reverse();
}
export function validateIntentResult(raw:unknown,labels:string[]) {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new ExtensionError('intent_invalid_result',502);
  const r=raw as Record<string,unknown>;
  if(Object.keys(r).some(k=>!['label','confidence'].includes(k))||typeof r.label!=='string'||![...labels,'无法判断'].includes(r.label)||typeof r.confidence!=='number'||!Number.isFinite(r.confidence)||r.confidence<0||r.confidence>1)throw new ExtensionError('intent_invalid_result',502);
  return {label:r.confidence<0.6?'无法判断':r.label,confidence:r.confidence};
}
