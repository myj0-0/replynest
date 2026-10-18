import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';

/** Bounded, fair reconciliation queue. Campaign row locks serialize pause/cancel and staging.
 * Provider batch success is not a claim that every individual user read/received a message. */
export async function processMassProgress(db:Pick<Pool,'connect'>,limit=50){
 if(!Number.isInteger(limit)||limit<1||limit>50)throw Error('invalid_mass_progress_limit');
 let checked=0;
 for(let n=0;n<limit;n++){
  const client=await db.connect();
  try{
   await client.query('BEGIN');
   const due=await client.query(`SELECT q.tenant_id,q.campaign_id,c.status FROM message_campaign_mass_progress q
    JOIN message_campaigns c ON c.tenant_id=q.tenant_id AND c.campaign_id=q.campaign_id
    WHERE q.next_check_at<=NOW() ORDER BY q.next_check_at,q.tenant_id,q.campaign_id
    LIMIT 1 FOR UPDATE OF c,q SKIP LOCKED`);
   const c=due.rows[0];
   if(!c){await client.query('COMMIT');break;}
   checked++;
   if(['cancelled','completed','failed'].includes(c.status)){
    await client.query('DELETE FROM message_campaign_mass_progress WHERE tenant_id=$1 AND campaign_id=$2',[c.tenant_id,c.campaign_id]);
   }else{
    await client.query(`UPDATE message_campaign_mass_progress SET next_check_at=NOW()+INTERVAL '30 seconds'
     WHERE tenant_id=$1 AND campaign_id=$2`,[c.tenant_id,c.campaign_id]);
    if(['scheduled','running'].includes(c.status)){
     const result=await client.query(`SELECT state,COUNT(*)::int n FROM message_campaign_mass_batches
      WHERE tenant_id=$1 AND campaign_id=$2 GROUP BY state`,[c.tenant_id,c.campaign_id]);
     const counts:Record<string,number>=Object.fromEntries(result.rows.map(r=>[r.state,r.n]));
     const total=Object.values(counts).reduce((a,b)=>a+b,0);
     const event=async(kind:string)=>client.query(`INSERT INTO message_campaign_events
      (campaign_id,tenant_id,event_type,actor_type,actor_id,reason,facts,request_id)
      VALUES($1,$2,$3,'system','mass-progress','Provider batch reconciliation',$4,$5)`,
      [c.campaign_id,c.tenant_id,kind,{provider:'wechat_mass',batch_counts:counts},randomUUID()]);
     if(total>(counts.queued??0)){
      if(c.status==='scheduled'){
       await client.query(`UPDATE message_campaigns SET status='running',started_at=COALESCE(started_at,NOW()),updated_at=NOW()
        WHERE tenant_id=$1 AND campaign_id=$2`,[c.tenant_id,c.campaign_id]);
       await event('started');
      }
      // Unknown outcomes must remain visible for review; an acknowledgement alone never completes.
      if(!['queued','preparing','submitting','submitted','uncertain'].some(s=>counts[s])){
       const state=counts.succeeded===total?'completed':'failed';
       await client.query(`UPDATE message_campaigns SET status=$3,completed_at=NOW(),updated_at=NOW()
        WHERE tenant_id=$1 AND campaign_id=$2`,[c.tenant_id,c.campaign_id,state]);
       await event(state);
       await client.query('DELETE FROM message_campaign_mass_progress WHERE tenant_id=$1 AND campaign_id=$2',[c.tenant_id,c.campaign_id]);
      }
     }
    }
   }
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally{client.release();}
 }
 return checked;
}
