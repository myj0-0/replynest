// Fixed keys only; never cache sessions, permissions, tenant identities or mutation decisions.
const entries=new Map<string,{expires:number;value:Promise<unknown>}>();
export async function adminSummary<T>(key:'overview'|'finance'|'queues'|'campaigns',load:()=>Promise<T>):Promise<T>{
 const found=entries.get(key);if(found&&found.expires>Date.now())return found.value as Promise<T>;
 const value=load();const entry={expires:Date.now()+30000,value};entries.set(key,entry);
 try{return await value;}catch(error){if(entries.get(key)===entry)entries.delete(key);throw error;}
}
