export type QuickImage={asset_id:string;file_name:string;preview_url:string;size_bytes:number};
export type ImageQuickReply={quick_reply_id:string;updated_at:string;image:QuickImage};
type ReplyBody={request_id?:string;data?:{state?:string;delivery_state?:string;transfer_id?:string};error?:{code?:string;message?:string}};
export type CompositionResult={kind:'accepted'|'error'|'uncertain';imageAccepted:boolean;stage:'prepare'|'image'|'text';requestId?:string;message?:string;deliveryState?:string};
// Images go first: independent-account text is queued by the native webhook.
// Waiting for the image's provider acceptance guarantees that queued text
// cannot overtake it. No provider request or uncertain operation is retried.
export async function sendQuickReplyComposition(input:{conversationId:string;item:ImageQuickReply;text:string;key:string;imageAccepted:boolean},
 deps:{fetcher:typeof fetch;imageAccepted:()=>void;failure:(state:string)=>string|undefined}):Promise<CompositionResult>{
 let accepted=input.imageAccepted,stage:CompositionResult['stage']='prepare';
 const headers=(part:string)=>({'content-type':'application/json','idempotency-key':`${input.key}:${part}`});
 // Browser fetch must be called as a function, not as a method of deps.
 const fetcher=deps.fetcher;
 const post=async(url:string,body:unknown,part:string)=>{
  const r=await fetcher(url,{method:'POST',headers:headers(part),body:JSON.stringify(body),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(45000)});
  return {status:r.status,body:await r.json() as ReplyBody};
 };
 const failed=(body:ReplyBody,status:number):CompositionResult=>({kind:['send_outcome_uncertain','request_in_progress'].includes(body.error?.code??'')||stage!=='prepare'&&(status>=500||status>=200&&status<300)?'uncertain':'error',imageAccepted:accepted,stage,requestId:body.request_id,message:body.error?.message});
 try{
  if(!accepted){
   const prepared=await post(`/api/quick-replies/${input.item.quick_reply_id}/prepare-image`,{conversation_id:input.conversationId,image_asset_id:input.item.image.asset_id,updated_at:input.item.updated_at},'prepare');
   const id=prepared.body.data?.transfer_id;
   if(prepared.status!==200||typeof id!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))return failed(prepared.body,prepared.status);
   stage='image';const media=await post(`/api/conversations/${input.conversationId}/media`,{file_transfer_id:id},'image');
   if(media.status!==202||media.body.data?.state!=='accepted'||media.body.data.delivery_state!=='wechat_media_provider_accepted')return failed(media.body,media.status);
   accepted=true;deps.imageAccepted();
  }
  if(!input.text.trim())return {kind:'accepted',imageAccepted:true,stage:'image'};
  stage='text';const text=await post(`/api/conversations/${input.conversationId}/messages`,{content:input.text.trim(),private:false},'text');
  if(text.status!==202||text.body.data?.state!=='accepted')return failed(text.body,text.status);
  const state=text.body.data.delivery_state??'',rejected=deps.failure(state);
  if(rejected)return {kind:'error',imageAccepted:true,stage:'text',message:rejected,requestId:text.body.request_id};
  if(!['pending','shared_pending','shared_provider_accepted'].includes(state))return {kind:'uncertain',imageAccepted:true,stage:'text',requestId:text.body.request_id};
  return {kind:'accepted',imageAccepted:true,stage:'text',deliveryState:state};
 }catch{return {kind:stage==='prepare'?'error':'uncertain',imageAccepted:accepted,stage};}
}
