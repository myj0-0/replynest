/** Trusted server dependency. No tenant request may select an account or URL. */
export type AutomaticSenderState='ready'|'missing'|'disabled'|'invalid'|'unavailable'|'platform_disabled';
export type AutomaticSenderPort={
 inspect:(accountId:string)=>Promise<AutomaticSenderState>;
 prepare:(accountId:string)=>Promise<AutomaticSenderState>;
};
export async function inspectAutomaticSender(sender:AutomaticSenderPort|undefined,accountId:string|null):Promise<AutomaticSenderState>{
 if(!sender||!accountId)return 'unavailable';
 try{return await sender.inspect(accountId);}catch{return 'unavailable';}
}
export function automaticSenderError(state:AutomaticSenderState){
 return state==='platform_disabled'?'automatic_execution_disabled':state==='disabled'?'automatic_sender_disabled':
  state==='invalid'?'automatic_sender_invalid':'automatic_sender_unavailable';
}
