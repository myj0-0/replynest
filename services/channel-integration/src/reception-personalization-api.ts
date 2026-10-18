import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Pool} from 'pg';
import {ReceptionPersonalizationError,manageReceptionPersonalization,validateReceptionPersonalizationAction} from './reception-personalization.js';
import {listHistoricalKnowledgeJobs,validateHistoryJobsQuery} from './reception-history-knowledge-status.js';
const base='/api/v1/reception-personalization';
const messages:Record<string,string>={not_found:'此功能尚未开放。',method_not_allowed:'不支持此操作。',unauthorized:'请先登录。',
 administrator_session_required:'请使用本企业管理员账号操作；代入和嵌入会话不能授权。',workspace_changed:'当前企业已切换，请重新打开页面。',
 invalid_payload:'请求参数不正确。',history_confirmation_required:'请阅读并确认本项历史用途的授权。',history_style_authorization_required:'请先单独确认人工语气学习授权。',
 history_channel_unavailable:'会话服务尚未就绪，暂不能授权历史读取。',personalization_revision_conflict:'配置或授权已变化，请刷新后再操作。',
 rate_limited:'操作过于频繁，请稍后刷新。',body_timeout:'请求读取超时。',body_too_large:'请求内容过长。',
 personalization_result_uncertain:'操作结果暂时无法确认，请刷新核实，不要重复提交。'};
Object.assign(messages,{history_knowledge_disabled:'历史知识草稿生成尚未开放。',history_query_invalid:'任务查询参数不正确。',
 history_administrator_required:'请使用当前企业管理员账号查看或生成草稿。',history_authorization_required:'请先单独保存历史知识草稿用途授权。',
 history_knowledge_confirmation_required:'请确认整理历史聊天及消耗 AI 点数。',history_knowledge_rate_limited:'已有任务正在处理，或已达到每日5次上限。'});
function json(res:ServerResponse,status:number,value:unknown){if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...(status===429?{'retry-after':'60'}:{})});res.end(JSON.stringify(value));}
function readBody(req:IncomingMessage):Promise<unknown>{return new Promise((resolve,reject)=>{
 const chunks:Buffer[]=[];let size=0;
 const cleanup=()=>{clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',abort);req.off('aborted',abort);};
 const fail=(code:string,status:number)=>{cleanup();req.pause();reject(new ReceptionPersonalizationError(code,status));};
 const data=(chunk:Buffer)=>{const b=Buffer.from(chunk);size+=b.length;if(size>4096){fail('body_too_large',413);return;}chunks.push(b);};
 const end=()=>{cleanup();try{resolve(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));}catch{reject(new ReceptionPersonalizationError('invalid_payload'));}};
 const abort=()=>fail('invalid_payload',400);const timer=setTimeout(()=>fail('body_timeout',408),2000);timer.unref();
 req.on('data',data);req.once('end',end);req.once('error',abort);req.once('aborted',abort);
});}
/** Default-off, no caller-selected tenant. A grant is not an active history worker. */
export function receptionPresentationAvailability(state:{management:boolean;stopping:boolean;draftWorker:boolean;draftPreparation:boolean;
 automaticExecution:boolean;automaticPreparation:boolean;timing:boolean}){
 const active=state.management&&!state.stopping;
 const draftTone=active&&state.draftWorker&&state.draftPreparation;
 const automaticTone=active&&state.automaticExecution&&state.automaticPreparation;
 return {presentation:draftTone||automaticTone,draftTone,automaticTone,replyTiming:automaticTone&&state.timing};
}
export function createReceptionPersonalizationApi(db:Pick<Pool,'connect'>,options:{enabled?:()=>boolean;historyEnabled?:()=>boolean;
 historyReadEnabled?:()=>boolean;
 presentationStatus?:()=>ReturnType<typeof receptionPresentationAvailability>;
 generationEnabled?:()=>boolean;historyService?:{request(token:string,tenant:string,input:unknown):Promise<unknown>}}={}){
 let active=0;
 return async(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>=>{
  if(url.pathname!==base&&!url.pathname.startsWith(base+'/'))return false;
  if(active>=16){json(res,503,{error:{code:'personalization_result_uncertain',message:messages.personalization_result_uncertain}});return true;}
  active++;
  try{
   if(!(options.enabled??(()=>false))())throw new ReceptionPersonalizationError('not_found',404);
   const jobs=url.pathname===base+'/knowledge-jobs';
   if(!jobs&&url.search||!(req.method==='GET'&&(url.pathname===base||jobs)||req.method==='POST'&&[base+'/settings',base+'/history-grant',base+'/public-label',base+'/knowledge-jobs'].includes(url.pathname)))throw new ReceptionPersonalizationError('method_not_allowed',405);
   if(jobs&&!options.historyEnabled?.())throw new ReceptionPersonalizationError('history_knowledge_disabled',404);
   const jobsQuery=jobs?validateHistoryJobsQuery(url.searchParams):undefined;
   const bearer=req.headers.authorization??'',workspace=req.headers['x-replynest-workspace'];
   if(!/^Bearer [a-f0-9]{64}$/.test(bearer))throw new ReceptionPersonalizationError('unauthorized',401);
   if(typeof workspace!=='string'||!workspace.trim()||workspace.length>200)throw new ReceptionPersonalizationError('workspace_changed',409);
   let action;
   if(req.method==='POST'){
    if((req.headers['content-type']??'').split(';')[0].trim().toLowerCase()!=='application/json')throw new ReceptionPersonalizationError('invalid_payload');
    const body=await readBody(req);
    if(jobs){
     if(url.search)throw new ReceptionPersonalizationError('history_query_invalid');
     if(!(options.enabled??(()=>false))())throw new ReceptionPersonalizationError('not_found',404);
     if(!options.historyEnabled?.())throw new ReceptionPersonalizationError('history_knowledge_disabled',404);
     // Read/auth rate gate before the independently authenticated job mutation.
     await manageReceptionPersonalization(db,bearer.slice(7),workspace);
     if(!(options.enabled??(()=>false))())throw new ReceptionPersonalizationError('not_found',404);
     if(!options.historyEnabled?.())throw new ReceptionPersonalizationError('history_knowledge_disabled',404);
     if(!options.generationEnabled?.()||!options.historyService)throw new ReceptionPersonalizationError('history_knowledge_disabled',409);
     await options.historyService.request(bearer.slice(7),workspace,body);
     const query=validateHistoryJobsQuery(new URLSearchParams({requestId:(body as any)?.requestId??''}));
     json(res,200,{data:await listHistoricalKnowledgeJobs(db,bearer.slice(7),workspace,query,true)});return true;
    }
    action=validateReceptionPersonalizationAction(url.pathname.endsWith('/settings')?'settings':url.pathname.endsWith('/public-label')?'public-label':'history-grant',body);
   }
   if(!(options.enabled??(()=>false))())throw new ReceptionPersonalizationError('not_found',404);
   const result=await manageReceptionPersonalization(db,bearer.slice(7),workspace,action);
   const presentation=options.enabled?.()?options.presentationStatus?.():undefined;
   json(res,200,{data:jobs?await listHistoricalKnowledgeJobs(db,bearer.slice(7),workspace,jobsQuery,!!options.generationEnabled?.()&&!!options.historyService):
    {...result,availability:{...result.availability,
     ...(presentation??receptionPresentationAvailability({management:false,stopping:false,draftWorker:false,
      draftPreparation:false,automaticExecution:false,automaticPreparation:false,timing:false})),
     history:!!options.enabled?.()&&!!options.historyReadEnabled?.()}}});
  }catch(error){const code=error instanceof Error?error.message:'';
   const status:Record<string,number>={history_query_invalid:400,history_administrator_required:403,history_knowledge_disabled:409,history_authorization_required:403,history_knowledge_confirmation_required:400,history_knowledge_rate_limited:429};
   const e=error instanceof ReceptionPersonalizationError?error:new ReceptionPersonalizationError(Object.hasOwn(status,code)?code:'personalization_result_uncertain',status[code]??503);
   json(res,e.status,{error:{code:e.code,message:messages[e.code]??messages.personalization_result_uncertain}});
   if([408,413].includes(e.status))res.once('finish',()=>req.destroy());
  }finally{active--;}
  return true;
 };
}
