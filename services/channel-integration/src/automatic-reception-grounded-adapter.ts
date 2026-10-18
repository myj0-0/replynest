import type {Pool,PoolClient} from 'pg';
import type {AutomaticReplyFacts} from './automatic-reply-policy.js';
import type {AutomaticReceptionAdapter} from './automatic-reception-runtime.js';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
import type {ReceptionDraft} from './reception-executor.js';
import {assessStoredAutomaticEvidence,recordAutomaticAssessment} from './automatic-reception-evidence-store.js';
import type {AutomaticEvidenceAssessment} from './automatic-reception-evidence.js';

export type GroundedReceptionPorts=Omit<AutomaticReceptionAdapter,'assess'|'authorize'> & {
 /** Canonical current inbound text from the stored tenant/account/message, never generator metadata.
  * The channel adapter must verify freshness and human takeover independently.
  */
 question(db:PoolClient,l:AutomaticReceptionLease):Promise<string>;
 authorizeFacts(db:PoolClient,l:AutomaticReceptionLease,d:ReceptionDraft):Promise<AutomaticReplyFacts>;
};
/** Fixed server assessment replaces any generator/adapter-proposed score. Registration is external. */
export function withStoredAutomaticAssessment(db:Pick<Pool,'query'|'connect'>,p:GroundedReceptionPorts):AutomaticReceptionAdapter {
 return {
  enabled:()=>p.enabled(),facts:l=>p.facts(l),generate:l=>p.generate(l),submit:(l,d)=>p.submit(l,d),
  ...(p.canonicalQuestion?{canonicalQuestion:(l:AutomaticReceptionLease)=>p.canonicalQuestion!(l)}:{}),
  assess:async(l,d)=>{
   const client=await db.connect();
   try{
    await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='3000ms'");await client.query("SET LOCAL lock_timeout='500ms'");
    const a=await assessStoredAutomaticEvidence(client,l,d,await p.question(client,l),{lock:true});
    await recordAutomaticAssessment(client,l,'post_generation',a);await client.query('COMMIT');return a;
   }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
  },
  authorize:async(client,l,d)=>{
   await client.query("SET LOCAL statement_timeout='3000ms'");await client.query("SET LOCAL lock_timeout='500ms'");
   const facts=await p.authorizeFacts(client,l,d);
   const assessment=await assessStoredAutomaticEvidence(client,l,d,await p.question(client,l),{lock:true});
   await recordAutomaticAssessment(client,l,'before_submit',assessment);
   return {facts,assessment};
  },
  recordAuthorizationDenial:async(client,l,a)=>recordAutomaticAssessment(client,l,'before_submit',a as AutomaticEvidenceAssessment)
 };
}
