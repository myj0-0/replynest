import {pool} from './database.js';
import {documentControlsEnabled} from './knowledge-document-core.js';
import type {PolicyCitation} from './policy-engine.js';
import {embedText,vectorLiteral} from './embedding-provider.js';
import {getTenantAiSettings} from './tenant-ai-settings.js';
import {boundedEvidenceQuery,budgetEvidence,keywordEvidenceSql,historyEvidenceSql,semanticEvidenceSql,
 type KnowledgeEvidence,type HistoryEvidence} from './rag-retrieval.js';

export async function retrieveEvidence(tenantId:string,question:string,activePolicies:PolicyCitation[],now=new Date(),context:Record<string,unknown>={}) {
 const query=question.slice(0,8000);
 const scope=documentControlsEnabled()?[JSON.stringify(context)]:[];
 const keyword=await boundedEvidenceQuery<KnowledgeEvidence & Record<string,unknown>>(pool,keywordEvidenceSql,[tenantId,now,query,...scope]);
 let semantic:KnowledgeEvidence[]=[];
 try {
  const settings=await getTenantAiSettings(tenantId);
  const embedding=await embedText(settings,query,'RETRIEVAL_QUERY');
  if(embedding){
   const result=await boundedEvidenceQuery<KnowledgeEvidence & Record<string,unknown>>(pool,semanticEvidenceSql,
    [tenantId,now,vectorLiteral(embedding.vector),embedding.provider,embedding.model,...scope]);
   semantic=result.rows.filter(item=>item.score>0.2);
  }
 }catch{/* Optional semantic retrieval failure leaves keyword evidence available. */}
 const history=await boundedEvidenceQuery<HistoryEvidence & Record<string,unknown>>(pool,historyEvidenceSql,
  [tenantId,query,activePolicies.map(policy=>policy.policy_id)]);
 return budgetEvidence(semantic,keyword.rows,history.rows);
}
