import type {IncomingMessage,ServerResponse} from 'node:http';
import {authenticateChatwootCallback} from './chatwoot-callback-security.js';
import {automaticInbound,type AutomaticInbound,type AutomaticIngressResult} from './automatic-reception-queue.js';
class BodyError extends Error{constructor(readonly status:number){super('automatic_callback_body_rejected');}}
function body(request:IncomingMessage):Promise<Buffer>{
 return new Promise((resolve,reject)=>{
  const chunks:Buffer[]=[];let bytes=0;
  const cleanup=()=>{clearTimeout(timer);request.off('data',data);request.off('end',end);request.off('aborted',aborted);request.off('error',aborted);};
  const fail=(status:number)=>{cleanup();request.pause();reject(new BodyError(status));};
  const data=(chunk:Buffer)=>{const b=Buffer.from(chunk);bytes+=b.length;if(bytes>32768){fail(413);return;}chunks.push(b);};
  const end=()=>{cleanup();resolve(Buffer.concat(chunks));},aborted=()=>fail(400);
  const timer=setTimeout(()=>fail(408),2000);timer.unref();
  request.on('data',data);request.once('end',end);request.once('aborted',aborted);request.once('error',aborted);
 });
}
function reply(res:ServerResponse,status:number,code:string,retry=false){
 if(res.destroyed||res.writableEnded)return;
 res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...(retry?{'retry-after':'5'}:{}),
  ...([400,408,413].includes(status)?{connection:'close'}:{})});res.end(JSON.stringify(status===200?{ok:true,state:code}:{error:code}));
}
/** Shared HTTP boundary for default-off gateway registration and real bridge acceptance.
 * 16 concurrent bodies, each <=32KiB / 2 seconds; no raw provider/database errors in replies.
 */
export function createAutomaticReceptionHttp(options:{enabled?:()=>boolean;closedAck?:boolean;secret:string;
 insightsEnabled?:()=>boolean;insights?:(event:AutomaticInbound)=>Promise<'queued'|'ignored'|'backpressure'>;
 project:(e:AutomaticInbound)=>Promise<'ready'|'ignored'|'unavailable'>;
 draft?:(payload:unknown)=>Promise<void>;
 workflow?:(event:AutomaticInbound)=>Promise<void>;
 ingress:(body:Buffer,timestamp:unknown,signature:unknown)=>Promise<AutomaticIngressResult>}){
 let stopping=false;const active=new Set<Promise<void>>();
 const enabled=options.enabled??(()=>false);
 const handle=async(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>=>{
  if(url.pathname!=='/webhooks/chatwoot/reception')return false;
  if(stopping){reply(res,503,'automatic_reception_stopping',true);return true;}
  const admitted=enabled(),insightsAdmitted=!!options.insights&&!!options.insightsEnabled?.();
  if(!admitted&&!insightsAdmitted&&!options.closedAck){reply(res,404,'not_found');return true;}
  if(req.method!=='POST'||url.search){reply(res,405,'method_not_allowed');return true;}
  if(active.size>=16){reply(res,503,'automatic_callback_busy',true);return true;}
  const run=(async()=>{
   try{
    if((req.headers['content-type']??'').split(';')[0].trim().toLowerCase()!=='application/json'){reply(res,415,'invalid_content_type');return;}
    const length=req.headers['content-length'];if(length&&(!/^\d+$/.test(length)||Number(length)>32768))throw new BodyError(413);
    const raw=await body(req),stamp=req.headers['x-replynest-chatwoot-timestamp'],signature=req.headers['x-replynest-chatwoot-signature'];
    if(!authenticateChatwootCallback(options.secret,stamp,signature,raw)){reply(res,401,'invalid_callback_authentication');return;}
    const event=automaticInbound(raw);if(!event){reply(res,200,'ignored');return;}
    // A signed callback received while intentionally closed is terminally
    // acknowledged, not retried into a later activation. No projection,
    // draft, database, model, point debit or send can run on this branch.
    // Freeze the admission decision BEFORE reading the body, so opening the
    // executor during that read cannot admit an older request retroactively.
    if(stopping){reply(res,503,'automatic_reception_stopping',true);return;}
    if(!admitted&&!insightsAdmitted){reply(res,200,'ignored_closed');return;}
    // Independent purpose, frozen before body I/O. Enabling customer notes
    // never enables drafts/sends/workflows, and their grants do not enable notes.
    let insightState='ignored';
    if(insightsAdmitted){
     if(!options.insightsEnabled?.()){reply(res,503,'automatic_reception_stopping',true);return;}
     insightState=await options.insights!(event);
     if(stopping){reply(res,503,'automatic_reception_stopping',true);return;}
     if(insightState==='backpressure'){reply(res,429,'customer_insights_queue_full',true);return;}
    }
    if(!admitted){reply(res,200,insightState==='queued'?'customer_insights_queued':'ignored');return;}
    if(stopping||!enabled()){reply(res,503,'automatic_reception_stopping',true);return;}
    // One authenticated body serves both modes. The draft store enforces its own
    // current consent; automatic tenants cannot be silently given private drafts.
    if(options.workflow)await options.workflow(event);
    if(options.draft)await options.draft(JSON.parse(raw.toString('utf8')));
    if(stopping||!enabled()){reply(res,503,'automatic_reception_stopping',true);return;}
    const projected=await options.project(event);
    if(projected==='unavailable'){reply(res,503,'automatic_projection_unavailable',true);return;}
    if(projected==='ignored'){reply(res,200,'ignored');return;}
    if(stopping||!enabled()){reply(res,503,'automatic_reception_stopping',true);return;}
    const state=await options.ingress(raw,stamp,signature);
    if(state==='backpressure'){reply(res,429,'automatic_queue_full',true);return;}
    if(state==='unavailable'||state==='disabled'){reply(res,503,'automatic_ingress_unavailable',true);return;}
    reply(res,200,state);
   }catch(e){
    if(e instanceof BodyError){reply(res,e.status,e.status===413?'body_too_large':e.status===408?'body_timeout':'invalid_body');res.once('finish',()=>req.destroy());}
    else if(e instanceof Error&&e.message==='invalid_automatic_callback')reply(res,400,'invalid_callback');
    else reply(res,503,'automatic_callback_unavailable',true);
   }
  })();active.add(run);try{await run;}finally{active.delete(run);}return true;
 };
 return {handle,stop:async()=>{stopping=true;await Promise.allSettled([...active]);}};
}
