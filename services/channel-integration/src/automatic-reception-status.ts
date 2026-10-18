import type {Pool} from 'pg';
import {authenticateAutomaticAdministrator} from './automatic-reception-auth.js';
import {AutomaticManagementError,automaticUuid} from './automatic-reception-management.js';
import {automaticBillingReview} from './automatic-billing-review.js';
function cursor(v:string|null):{at:string;id:string}|null{
 if(v===null)return null;
 try{
  if(v.length>200||!/^[A-Za-z0-9_-]+$/.test(v))throw Error();
  const c=JSON.parse(Buffer.from(v,'base64url').toString('utf8'));
  if(!c||Object.keys(c).sort().join(',')!=='at,id'||!automaticUuid(c.id)||typeof c.at!=='string'||
   !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(c.at)||!Number.isFinite(Date.parse(c.at))||
   new Date(c.at).toISOString()!==c.at.slice(0,23)+'Z')throw Error();
  return c;
 }catch{throw new AutomaticManagementError('invalid_payload');}
}
export function automaticStatusQuery(limit:number,after:string|null){
 if(!Number.isInteger(limit)||limit<1||limit>25)throw new AutomaticManagementError('invalid_payload');
 return {limit,cursor:cursor(after)};
}
/** Metadata only, bounded descending keyset, no transcript, prompt, credentials or global totals. */
export async function readAutomaticReceptionStatus(db:Pick<Pool,'connect'>,token:string,limit:number,after:string|null,expectedTenant?:string,
 options:{wechatOutcomes?:boolean;semanticOutcomes?:boolean}={}){
 const q=automaticStatusQuery(limit,after),c=await db.connect();
 const semantic=options.semanticOutcomes??process.env.AI_RECEPTION_SEMANTIC_ANSWERS_ENABLED==='true';
 try{
  await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='500ms'");
  const auth=await authenticateAutomaticAdministrator(c,token);
  if(!auth)throw new AutomaticManagementError('administrator_session_required',403);
  if(expectedTenant!==undefined&&expectedTenant!==auth.tenant_id)throw new AutomaticManagementError('workspace_changed',409);
  const rows=(await c.query(`SELECT j.job_id,j.channel,j.state,j.reason,
   to_char(j.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at,
   g.state generation_state,g.reason generation_reason,(g.attempted_at IS NOT NULL) generation_attempted,b.status billing_state,b.error_code billing_error,
   b.charged_micros::text charged_micros,CASE WHEN b.status='reserved' THEN b.reserved_micros::text ELSE '0' END held_micros
   ${semantic?`,r.state retrieval_state,r.reason retrieval_reason,(r.attempted_at IS NOT NULL) retrieval_attempted,
    rb.status retrieval_billing_state,rb.error_code retrieval_billing_error,rb.charged_micros::text retrieval_charged_micros,
    CASE WHEN rb.status='reserved' THEN rb.reserved_micros::text ELSE '0' END retrieval_held_micros,
    v.state verification_state,v.reason verification_reason,(v.attempted_at IS NOT NULL) verification_attempted,
    vb.status verification_billing_state,vb.error_code verification_billing_error,vb.charged_micros::text verification_charged_micros,
    CASE WHEN vb.status='reserved' THEN vb.reserved_micros::text ELSE '0' END verification_held_micros`:''}
   ${options.wechatOutcomes?`,o.outcome wechat_outcome,o.reason wechat_reason,o.provider_code wechat_provider_code,
    h.state wechat_history_state,h.reason wechat_history_reason,h.attempts wechat_history_attempts`:''}
   FROM automatic_reception_jobs j LEFT JOIN automatic_reception_generations g ON g.job_id=j.job_id AND g.tenant_id=j.tenant_id
   LEFT JOIN ai_usage_calls b ON b.tenant_id=j.tenant_id AND b.request_key=g.request_key
    AND b.request_key='automatic-reply:'||j.job_id::text AND b.feature='copilot'
    AND (g.call_id IS NULL OR b.call_id=g.call_id)
   ${semantic?`LEFT JOIN automatic_reception_retrievals r ON r.job_id=j.job_id AND r.tenant_id=j.tenant_id
    LEFT JOIN ai_usage_calls rb ON rb.tenant_id=j.tenant_id AND rb.request_key='automatic-knowledge-query:'||j.job_id::text
     AND rb.feature='embedding_query' AND (r.call_id IS NULL OR r.call_id=rb.call_id)
    LEFT JOIN automatic_reception_verifications v ON v.job_id=j.job_id AND v.tenant_id=j.tenant_id
    LEFT JOIN ai_usage_calls vb ON vb.tenant_id=j.tenant_id AND vb.request_key='automatic-verify:'||j.job_id::text
     AND vb.feature='copilot' AND (v.call_id IS NULL OR v.call_id=vb.call_id)`:''}
   ${options.wechatOutcomes?`LEFT JOIN automatic_reception_wechat_outcomes o ON o.job_id=j.job_id AND o.tenant_id=j.tenant_id
    AND o.worker_token=j.worker_token AND j.channel IN('wechat_official_account','shared_wechat')
    LEFT JOIN automatic_reception_wechat_history h ON h.job_id=o.job_id AND h.tenant_id=j.tenant_id
     AND h.send_worker_token=j.worker_token AND o.outcome='accepted'`:''}
   WHERE j.tenant_id=$1 AND ($2::timestamptz IS NULL OR (j.created_at,j.job_id)<($2::timestamptz,$3::uuid))
   ORDER BY j.created_at DESC,j.job_id DESC LIMIT $4`,[auth.tenant_id,q.cursor?.at??null,q.cursor?.id??null,q.limit+1])).rows;
  // A reservation COMMIT can succeed while its acknowledgement is lost, leaving
  // g.call_id unset. The tenant-scoped unique request key still identifies that
  // ledger row. Never infer absence/zero cost from the missing acknowledgement.
  const jobs=rows.slice(0,q.limit).map(row=>{
   const {generation_attempted,billing_error,...metadata}=row;
   if(semantic){
    const modelCosts=['retrieval','generation','verification'].map(stage=>{
     const cost={stage,state:row[`${stage}_state`]??null,reason:row[`${stage}_reason`]??null,
      billing_state:row[stage==='generation'?'billing_state':`${stage}_billing_state`]??null,
      charged_micros:row[stage==='generation'?'charged_micros':`${stage}_charged_micros`]??null,
      held_micros:row[stage==='generation'?'held_micros':`${stage}_held_micros`]??null};
     return {...cost,billing_review:automaticBillingReview({generation_state:cost.state,generation_attempted:row[`${stage}_attempted`]===true,
      billing_state:cost.billing_state,billing_error:row[stage==='generation'?'billing_error':`${stage}_billing_error`]??null,
      charged_micros:cost.charged_micros,held_micros:cost.held_micros})};
    });
    for(const prefix of ['retrieval','verification'])for(const suffix of ['state','reason','attempted','billing_state','billing_error','charged_micros','held_micros'])delete metadata[`${prefix}_${suffix}`];
    return {...metadata,billing_review:automaticBillingReview({...metadata,generation_attempted,billing_error}),model_costs:modelCosts};
   }
   return {...metadata,billing_review:automaticBillingReview({...metadata,generation_attempted,billing_error})};
  }),last=jobs[jobs.length-1];
  await c.query('COMMIT');
  return {jobs,next_cursor:rows.length>q.limit?Buffer.from(JSON.stringify({at:last.created_at,id:last.job_id})).toString('base64url'):null};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});if(e instanceof AutomaticManagementError)throw e;throw new AutomaticManagementError('management_result_uncertain',503);}
 finally{c.release();}
}
export async function readAutomaticReceptionSources(db:Pick<Pool,'connect'>,token:string,limit:number,after:string|null,expectedTenant?:string){
 if(!Number.isInteger(limit)||limit<1||limit>25||after!==null&&!automaticUuid(after))throw new AutomaticManagementError('invalid_payload');
 const c=await db.connect();
 try{
  await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='500ms'");
  const auth=await authenticateAutomaticAdministrator(c,token);
  if(!auth)throw new AutomaticManagementError('administrator_session_required',403);
  if(expectedTenant!==undefined&&auth.tenant_id!==expectedTenant)throw new AutomaticManagementError('workspace_changed',409);
  const rows=(await c.query(`SELECT document_id,left(title,160) title,version FROM knowledge_documents
   WHERE tenant_id=$1 AND status='active' AND ingestion_status='ready' AND parse_status IN('ready','parsed') AND scan_status IN('clean','not_required')
    AND (valid_from IS NULL OR valid_from<=NOW()) AND (valid_until IS NULL OR valid_until>NOW()) AND ($2::uuid IS NULL OR document_id>$2)
   ORDER BY document_id LIMIT $3`,[auth.tenant_id,after,limit+1])).rows;
  await c.query('COMMIT');return {sources:rows.slice(0,limit),next_cursor:rows.length>limit?rows[limit-1].document_id:null};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});if(e instanceof AutomaticManagementError)throw e;throw new AutomaticManagementError('management_result_uncertain',503);}
 finally{c.release();}
}
