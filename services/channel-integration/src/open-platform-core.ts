import { createHash, createHmac } from 'node:crypto';
export const openScopes = ['customers.basic.read','customers.contact.read','customers.notes.read','app.records.read','app.records.write'] as const;
export class OpenError extends Error { constructor(public code:string,public status=400){super(code);} }
export function validateOpenScopes(raw:unknown): string[] {
  if(!Array.isArray(raw)||!raw.length||raw.length>openScopes.length||raw.some(s=>!openScopes.includes(s))||new Set(raw).size!==raw.length) throw new OpenError('invalid_scopes');
  return [...raw].sort();
}
export function hashOpenToken(token:string){return createHash('sha256').update(token).digest('hex');}
export function webhookSignature(secret:string,timestamp:string,body:string){return `v1=${createHmac('sha256',secret).update(`${timestamp}.${body}`).digest('hex')}`;}
export function projectOpenCustomer(row:Record<string,unknown>,scopes:string[]) {
  const result:Record<string,unknown>={id:row.customer_id};
  if(scopes.includes('customers.basic.read')) Object.assign(result,{name:row.name,created_at:row.created_at,updated_at:row.updated_at});
  if(scopes.includes('customers.contact.read')) Object.assign(result,{phone:row.phone,email:row.email});
  if(scopes.includes('customers.notes.read')) result.support_note=row.support_note;
  return result;
}
export function validateAppData(raw:unknown): Record<string,string|number|boolean|null> {
  if(!raw||Array.isArray(raw)||typeof raw!=='object'||Object.keys(raw).length>32)throw new OpenError('invalid_record');
  for(const [k,v] of Object.entries(raw)) if(!/^[a-z][a-z0-9_]{0,31}$/.test(k)||['constructor','prototype','__proto__','tenant_id'].includes(k)||!(v===null||typeof v==='boolean'||typeof v==='string'&&v.length<=2000||typeof v==='number'&&Number.isFinite(v)))throw new OpenError('invalid_record');
  if(Buffer.byteLength(JSON.stringify(raw))>16000)throw new OpenError('record_too_large',413);
  return raw as Record<string,string|number|boolean|null>;
}
// Deliberately use public IPv4 only for v1 delivery. DNS is pinned at connection time.
export function publicWebhookIpv4(address:string){
  if(!/^\d+\.\d+\.\d+\.\d+$/.test(address))return false;
  const [a,b,c,d]=address.split('.').map(Number);
  return [a,b,c,d].every(n=>n>=0&&n<=255)&&a>0&&a<224&&![10,127].includes(a)&&!(a===100&&b>=64&&b<=127)&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&(b===168||b===0||b===2))&&!(a===198&&(b===18||b===19||b===51))&&!(a===203&&b===0&&c===113);
}
