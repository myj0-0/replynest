import {pool} from './database.js';
import {claimReception,finishReception,type StoredReceptionJob} from './reception-store.js';
import {getChatwootConversation,listChatwootMessages,createChatwootOutgoingMessage} from './conversation-headless-chatwoot.js';
import {evaluatePolicies} from './policy-engine.js';
import {retrieveEvidence} from './rag-service.js';
import {getTenantAiSettings} from './tenant-ai-settings.js';
import {generateReplyDraft} from './llm-provider.js';
import {aiPointsEnabled} from './ai-points.js';
import {mediaOnlyMessage} from './wechat-media-core.js';
import {reserveUsage} from './subscriptions.js';
import type {PreparedReceptionDraft,ReceptionDraftPreparation} from './reception-draft-preparation.js';

async function questionIfCurrent(j:StoredReceptionJob):Promise<string|null> {
  if(process.env.AI_RECEPTION_DRAFT_WORKER_ENABLED!=='true')return null;
  const allowed=await pool.query(`SELECT 1 FROM tenant_ai_settings s JOIN tenants t USING(tenant_id)
    JOIN reception_jobs j ON j.tenant_id=s.tenant_id AND j.job_id=$2 AND j.worker_token=$4 AND j.state='processing'
    WHERE s.tenant_id=$1 AND s.automation_updated_at=j.authorization_at AND s.automation_consent_version='automatic-reply-v1'
     AND s.ai_auto_reply_enabled=TRUE AND s.automatic_sending_enabled=FALSE
     AND t.status IN('active','test') AND t.chatwoot_account_id::text=$3`,[j.tenant_id,j.job_id,j.account_id,j.worker_token]);
  if(!allowed.rowCount)return null;
  const conversation=await getChatwootConversation(j.account_id,j.conversation_id);
  if(String(conversation.account_id)!==j.account_id||String(conversation.id)!==j.conversation_id||conversation.status==='resolved')return null;
  if(j.channel==='shared_wechat'){
    const binding=await pool.query(`SELECT 1 FROM shared_wechat_threads b
      JOIN shared_wechat_accounts a ON a.app_id=b.app_id AND a.enabled
      JOIN shared_wechat_enrollments e ON e.app_id=b.app_id AND e.tenant_id=b.tenant_id AND e.enabled
      JOIN shared_wechat_inboxes i ON i.app_id=b.app_id AND i.tenant_id=b.tenant_id AND i.account_id=b.account_id AND i.inbox_id=b.inbox_id AND i.enabled
      WHERE b.tenant_id=$1 AND b.account_id::text=$2 AND b.conversation_id::text=$3 AND b.inbox_id::text=$4`,
      [j.tenant_id,j.account_id,j.conversation_id,String(conversation.inbox_id)]);
    if(!binding.rowCount)return null;
  }else if(j.channel==='web_chat'){
    const binding=await pool.query(`SELECT 1 FROM channel_connections c JOIN channel_identities i ON i.channel_connection_id=c.connection_id AND i.tenant_id=c.tenant_id
      WHERE c.tenant_id=$1 AND c.channel_type='web_chat' AND c.status='ready'
      AND c.configuration->>'chatwoot_account_id'=$2 AND c.configuration->>'chatwoot_inbox_id'=$4
      AND i.channel='web_chat' AND i.chatwoot_conversation_id::text=$3 AND i.customer_id=$5`,
      [j.tenant_id,j.account_id,j.conversation_id,String(conversation.inbox_id),j.customer_id]);
    if(!binding.rowCount)return null;
  }
  const messages=await listChatwootMessages(j.account_id,j.conversation_id);
  const publicMessages=messages.filter(m=>m.private===false&&[0,1,'incoming','outgoing'].includes(m.message_type as string|number));
  if(publicMessages.some(m=>!/^\d+$/.test(String(m.id))))return null;
  publicMessages.sort((a,b)=>BigInt(String(a.id))>BigInt(String(b.id))?-1:1);
  const latest=publicMessages[0];
  if(!latest||String(latest.id)!==j.message_id||![0,'incoming'].includes(latest.message_type as string|number)||String(latest.conversation_id)!==j.conversation_id)return null;
  if(latest.account_id!=null&&String(latest.account_id)!==j.account_id)return null;
  if(mediaOnlyMessage(latest))return null;
  const created=typeof latest.created_at==='number'?latest.created_at*1000:Date.parse(String(latest.created_at));
  if(!Number.isFinite(created)||created<new Date(j.authorization_at).getTime()||Date.now()-created>10*60_000)return null;
  return typeof latest.content==='string'&&latest.content.trim()&&latest.content.length<=4000?latest.content.trim():null;
}

async function generate(j:StoredReceptionJob,question:string,prepared?:PreparedReceptionDraft,preparation?:ReceptionDraftPreparation) {
  const context={channel:j.channel,request_time:new Date().toISOString()};
  const policy=await evaluatePolicies(j.tenant_id,context);
  if(policy.conflict)return {text:'企业规则存在冲突，请人工核实后回复。',fallback:true};
  const evidence=await retrieveEvidence(j.tenant_id,question,policy.matched,new Date(),context);
  if(!policy.matched.length&&!evidence.knowledge.length)return {text:'暂未找到充分的企业知识依据，请人工核实客户问题后回复。',fallback:true};
  if(prepared&&(!preparation||!await preparation.current(prepared)))throw Error('draft_preparation_unavailable');
  if(!aiPointsEnabled())await reserveUsage(j.tenant_id,'ai_actions',1,`reception:${j.job_id}`,'automatic_draft',j.job_id);
  const result=await generateReplyDraft(await getTenantAiSettings(j.tenant_id),{
    question,context,policies:policy.matched.map(p=>({name:p.name,decision:p.decision,reply_guidance:p.reply_guidance,requires_human_approval:p.requires_human_approval})),
    knowledge:evidence.knowledge.map(k=>({title:k.title,content:k.content})),history:[],businessData:[],
    deterministicText:'AI 草稿暂不可用，请人工核实后回复。',...(prepared?{presentation:prepared.presentation}:{})});
  return {text:result.text.slice(0,4000),fallback:!!result.fallbackReason||result.provider==='deterministic',
    model:result.model,policy_ids:policy.matched.map(p=>p.policy_id),knowledge_ids:evidence.knowledge.map(k=>k.document_id)};
}

export async function processReceptionDraft(overrides?:{generateDraft?:typeof generate;preparation?:ReceptionDraftPreparation}):Promise<boolean> {
  if(process.env.AI_RECEPTION_DRAFT_WORKER_ENABLED!=='true')return false;
  const j=await claimReception(pool);if(!j)return false;
  let projectionStarted=false;
  try {
    const question=await questionIfCurrent(j);
    if(!question){await finishReception(pool,j,'skipped','conversation_or_authorization_changed');return true;}
    const preparation=overrides?.preparation,prepared=preparation?await preparation.prepare(j):undefined;
    const draft=await (overrides?.generateDraft??generate)(j,question,prepared,preparation);
    // An edited question with the same native message ID is not the question
    // this draft answered. Never persist the historical prompt or grant token.
    if(await questionIfCurrent(j)!==question){await finishReception(pool,j,'skipped','conversation_or_authorization_changed');return true;}
    if(prepared&&(!preparation||!await preparation.current(prepared,{rereadHistory:true}))){
      await finishReception(pool,j,'skipped','presentation_or_history_changed');return true;
    }
    // Commit uncertainty before the private-note API; a crash must not create duplicate notes.
    projectionStarted=true;
    if(prepared){
      if(!preparation||!await preparation.commitProjection(prepared,draft)){
        await finishReception(pool,j,'skipped','presentation_or_history_changed');return true;
      }
    }else{
      const barrier=await pool.query(`UPDATE reception_jobs SET state='uncertain',draft=$4,reason='private_note_projection_pending',updated_at=NOW()
        WHERE tenant_id=$1 AND job_id=$2 AND worker_token=$3 AND state='processing' RETURNING job_id`,[j.tenant_id,j.job_id,j.worker_token,draft]);
      if(!barrier.rowCount)throw new Error('reception_lease_lost');
    }
    const note=await createChatwootOutgoingMessage(j.account_id,j.conversation_id,`AI 自动草稿 · 仅团队可见 · 请核对后人工发送\n${draft.text}`,j.job_id,true);
    if(note.private!==true||String(note.conversation_id)!==j.conversation_id||(note.account_id!=null&&String(note.account_id)!==j.account_id))throw new Error('private_note_boundary_mismatch');
    await pool.query(`UPDATE reception_jobs SET state='draft',reason=$4,updated_at=NOW()
      WHERE tenant_id=$1 AND job_id=$2 AND worker_token=$3 AND state='uncertain'`,[j.tenant_id,j.job_id,j.worker_token,draft.fallback?'human_review_required':'private_draft_created']);
  }catch{
    if(!projectionStarted)await finishReception(pool,j,'failed','draft_generation_failed');
    // A note may already exist. No retry or new model request when projection is uncertain.
  }
  return true;
}
