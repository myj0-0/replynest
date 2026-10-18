import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Pool} from 'pg';
import type {AuthContext} from './business-api.js';
import {createCustomerInsightsStore,type InsightsActor,type VerifiedInsightEvent} from './customer-insights-store.js';
import {parseUniqueReceptionJson} from './reception-history-native-client.js';
const base='/api/v1/customer-insights';
const statuses:Record<string,number>={insights_disabled:404,method_not_allowed:405,insights_identity_required:403,
 insights_admin_required:403,workspace_changed:409,insights_revision_conflict:409,insights_consent_required:400,
 insights_budget_invalid:400,invalid_payload:400,body_too_large:413,body_timeout:408,
 insights_customer_unavailable:404,insights_edit_forbidden:403,insights_permission_unavailable:503,
 insights_assignment_verification_required:403,insights_correction_invalid:400,insights_summary_missing:409,
 insights_cursor_invalid:400,insights_points_not_settled:409,insights_settlement_conflict:409};
export const insightsApiMessages:Record<string,string>={insights_disabled:'客户 AI 备注尚未开放。',method_not_allowed:'不支持此操作。',
 insights_identity_required:'请使用当前企业的有效登录账号操作。',insights_admin_required:'请使用本企业管理员账号授权或调整预算。',
 workspace_changed:'当前企业已切换，请重新打开页面。',insights_revision_conflict:'配置已变化，请刷新核实后再操作。',
 insights_consent_required:'请阅读并单独确认客户 AI 备注用途。',insights_budget_invalid:'每日预算须为 0.001 至 10,000 AI 点数，最多六位小数。',
 invalid_payload:'请求参数不正确。',body_too_large:'请求内容过长。',body_timeout:'请求读取超时。',
 insights_result_uncertain:'操作结果暂时无法确认，请刷新核实，不要重复提交。',
 insights_customer_unavailable:'当前客户或会话不可用，请刷新工作台。',insights_edit_forbidden:'仅当前负责客服、主管或管理员可修改。',
 insights_permission_unavailable:'暂时无法核对当前会话权限，请稍后重试。',insights_assignment_verification_required:'请先核对当前会话分配。',
 insights_correction_invalid:'备注内容格式不正确或过长。',insights_summary_missing:'当前会话尚无总结，暂时不能纠正。',
 insights_cursor_invalid:'账务分页位置无效，请重新加载第一页。',insights_points_not_settled:'费用尚未取得已结算账本凭证；预占继续保留，请联系客服核对，不要重试模型。',
 insights_settlement_conflict:'费用记录不一致，请联系客服核对。'};
export function publicInsightProjection(value:Awaited<ReturnType<ReturnType<typeof createCustomerInsightsStore>['projection']>>,canEdit:boolean){
 if(!value)return {profile:null,can_edit:canEdit};
 const facts=value.long_term as Array<{text:string}>;
 if(!Array.isArray(facts)||facts.length>12||facts.some(f=>!f||typeof f.text!=='string'||f.text.length>200)||
  value.current_issue&&(typeof value.current_issue.text!=='string'||value.current_issue.text.length>600))throw Error('insights_result_uncertain');
 return {can_edit:canEdit,profile:{revision:value.revision,suppressed:value.suppressed,
  long_term:facts.map(f=>f.text),current_issue:value.current_issue?.text??null}};
}
function body(req:IncomingMessage,max=4096):Promise<unknown>{return new Promise((resolve,reject)=>{
 let size=0;const chunks:Buffer[]=[];
 const clean=()=>{clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',abort);req.off('aborted',abort);};
 const fail=(code:string)=>{clean();req.pause();reject(Error(code));};
 const data=(chunk:Buffer)=>{const b=Buffer.from(chunk);size+=b.length;if(size>max)return fail('body_too_large');chunks.push(b);};
 const end=()=>{clean();try{resolve(parseUniqueReceptionJson(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));}catch{reject(Error('invalid_payload'));}};
 const abort=()=>fail('invalid_payload');const timer=setTimeout(()=>fail('body_timeout'),2000);timer.unref();
 req.on('data',data);req.once('end',end);req.once('error',abort);req.once('aborted',abort);
});}
/** Called only after fresh console authentication by the business dispatcher.
 * Fresh store membership checks apply again at each transaction. No API keys,
 * impersonation, body-selected enterprise, model calls or history reads here. */
export function createCustomerInsightsApi(db:Pick<Pool,'connect'|'query'>,options:{enabled:()=>boolean;
 access?:(a:InsightsActor,e:Omit<VerifiedInsightEvent,'messageId'>)=>Promise<{assigned:boolean}>}){
 const store=createCustomerInsightsStore(db,{authorizeCorrection:async(a,e)=>{
  if(!options.enabled())throw Error('insights_disabled');
  if(!options.access)throw Error('insights_permission_unavailable');
  const permission=await options.access(a,e);return a.role!=='agent'||permission.assigned;
 }});let active=0;
 return async(req:IncomingMessage,res:ServerResponse,url:URL,auth:AuthContext,requestId:string):Promise<boolean>=>{
  if(url.pathname!==base&&!url.pathname.startsWith(base+'/'))return false;
  const send=(status:number,value:unknown)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify({request_id:requestId,...value as object}));};
  if(active>=16){send(503,{error:{code:'insights_result_uncertain',message:insightsApiMessages.insights_result_uncertain}});return true;}
  active++;
  try{
   if(!options.enabled())throw Error('insights_disabled');
   const settings=url.pathname===base+'/settings',topics=url.pathname===base+'/topics',profiles=url.pathname===base+'/profiles';
   const billing=url.pathname===base+'/billing';
   const reconcile=url.pathname.match(/^\/api\/v1\/customer-insights\/billing\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/reconcile$/)?.[1];
   const conversation=url.pathname.match(/^\/api\/v1\/customer-insights\/conversations\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/)?.[1];
   if((url.search&&!(billing&&[...url.searchParams.keys()].every(k=>k==='before')&&url.searchParams.getAll('before').length===1))||
    !((settings||conversation)&&['GET','POST'].includes(req.method??'')||(topics||profiles||billing)&&req.method==='GET'||reconcile&&req.method==='POST'))throw Error('method_not_allowed');
   if(auth.auth_kind!=='console_session'||auth.session_scope!=='console'||!auth.platform_user_id||auth.impersonation_id||auth.impersonated_by_admin_id)throw Error('insights_identity_required');
   if(req.headers['x-replynest-workspace']!==auth.tenant_id)throw Error('workspace_changed');
   if((settings||billing||reconcile)&&auth.role!=='tenant_admin'||(topics||profiles)&&auth.role==='agent')throw Error('insights_admin_required');
   const account=(await db.query(`SELECT chatwoot_account_id::text id FROM tenants WHERE tenant_id=$1 AND status IN('active','test')`,[auth.tenant_id])).rows[0]?.id;
   const actor:InsightsActor={tenantId:auth.tenant_id,accountId:account,userId:auth.platform_user_id,role:auth.role,impersonated:false};
   if(billing){send(200,{data:await store.billingRecords(actor,url.searchParams.get('before')??undefined)});return true;}
   if(reconcile){
    if((req.headers['content-type']??'').split(';')[0].trim().toLowerCase()!=='application/json')throw Error('invalid_payload');
    const raw=await body(req) as any;
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join(',')!=='confirmed'||raw.confirmed!==true)throw Error('invalid_payload');
    if(!options.enabled())throw Error('insights_disabled');
    send(200,{data:await store.reconcileReceipt(actor,reconcile)});return true;
   }
   if(conversation){
    const rows=(await db.query(`SELECT DISTINCT i.customer_id::text customer_id,i.chatwoot_conversation_id::text conversation_id
     FROM conversation_resource_mappings r JOIN channel_identities i ON i.tenant_id=r.tenant_id AND i.chatwoot_conversation_id::text=r.chatwoot_resource_id
     JOIN customers cu ON cu.tenant_id=i.tenant_id AND cu.customer_id=i.customer_id
     WHERE r.tenant_id=$1 AND r.chatwoot_account_id=$2 AND r.resource_type='conversation' AND r.replynest_resource_id=$3
      AND i.sync_status='synced' AND i.chatwoot_contact_id IS NOT NULL LIMIT 2`,[actor.tenantId,actor.accountId,conversation])).rows;
    if(rows.length!==1)throw Error('insights_customer_unavailable');
    const event={tenantId:actor.tenantId,accountId:actor.accountId,customerId:rows[0].customer_id,conversationId:rows[0].conversation_id};
    if(!options.access)throw Error('insights_permission_unavailable');
    if(req.method==='POST'){
     if((req.headers['content-type']??'').split(';')[0].trim().toLowerCase()!=='application/json')throw Error('invalid_payload');
     const raw=await body(req,12288) as any;
     if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join(',')!=='change,revision')throw Error('invalid_payload');
     await store.correct(actor,event,raw.revision,raw.change);
    }
    // Display hints are not authority. Each mutation checks again inside the
    // local membership/revision transaction, using fresh native metadata.
    const access=await options.access(actor,event);
    if(!options.enabled())throw Error('insights_disabled');
    send(200,{data:publicInsightProjection(await store.projection(actor,event),actor.role!=='agent'||access.assigned)});return true;
   }
   if(req.method==='POST'){
    if((req.headers['content-type']??'').split(';')[0].trim().toLowerCase()!=='application/json')throw Error('invalid_payload');
    const raw=await body(req);if(!options.enabled())throw Error('insights_disabled');
    await store.configure(actor,raw);
   }
   if(!options.enabled())throw Error('insights_disabled');
   send(200,{data:settings?await store.settings(actor):profiles?await store.profileCounts(actor,7):await store.topicCounts(actor,7)});
  }catch(e){const raw=e instanceof Error?e.message:'',code=Object.hasOwn(statuses,raw)?raw:'insights_result_uncertain',status=statuses[code]??503;
   send(status,{error:{code,message:insightsApiMessages[code]}});if([408,413].includes(status))res.once('finish',()=>req.destroy());
  }finally{active--;}
  return true;
 };
}
