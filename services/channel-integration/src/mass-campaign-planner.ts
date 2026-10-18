import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {stageMassBatch} from './mass-campaign-store.js';

/** Balance the final batch: never silently drop or duplicate a singleton. */
export function partitionMassRecipients(openIds:string[],rate:number):string[][] {
 if(!Number.isInteger(rate)||rate<2||rate>100)throw Error('mass_rate_requires_at_least_two');
 if(openIds.length<2||openIds.length>10000)throw Error('mass_audience_size_invalid');
 if(new Set(openIds).size!==openIds.length||openIds.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id)))throw Error('mass_recipient_invalid_or_duplicate');
 const count=Math.ceil(openIds.length/rate);
 if(openIds.length<count*2)throw Error('mass_rate_cannot_partition_audience');
 const groups:string[][]=[];let offset=0;
 for(let n=0;n<count;n++){
  const size=Math.ceil((openIds.length-offset)/(count-n));
  groups.push(openIds.slice(offset,offset+size));offset+=size;
 }
 return groups;
}

/** Caller owns a transaction and campaign row lock. Only stages; never authorizes a send.
 * Retry of the schedule endpoint returns the already scheduled campaign before calling here.
 */
export async function stageMassAudience(client:PoolClient,tenantId:string,campaignId:string,connectionId:string,content:string,rate:number,start:Date,expected:number){
 const existing=await client.query('SELECT 1 FROM message_campaign_mass_batches WHERE tenant_id=$1 AND campaign_id=$2 LIMIT 1',[tenantId,campaignId]);
 if(existing.rowCount)throw Error('mass_campaign_already_staged');
 const recipients=await client.query(`SELECT i.external_user_id FROM message_campaign_recipients r
  JOIN channel_identities i ON i.tenant_id=r.tenant_id AND i.identity_id=r.identity_id AND i.customer_id=r.customer_id
  WHERE r.tenant_id=$1 AND r.campaign_id=$2 AND r.eligible AND i.channel_connection_id=$3
   AND i.channel='wechat_official_account' ORDER BY i.identity_id LIMIT 10001 FOR SHARE OF i`,[tenantId,campaignId,connectionId]);
 if(recipients.rows.length!==expected)throw Error('mass_audience_changed');
 const groups=partitionMassRecipients(recipients.rows.map(r=>r.external_user_id),rate);
 for(const [index,openIds] of groups.entries()){
  const batchId=randomUUID();
  await stageMassBatch(client,{tenantId,campaignId,batchId},connectionId,{openIds,content,clientId:randomUUID().replaceAll('-','')});
  // Platform pacing only. Actual execution must recheck shared AppID traffic and quiet hours.
  await client.query('UPDATE message_campaign_mass_batches SET available_at=$4 WHERE tenant_id=$1 AND campaign_id=$2 AND batch_id=$3',
   [tenantId,campaignId,batchId,new Date(start.getTime()+index*61000)]);
 }
 return {batches:groups.length,recipients:recipients.rows.length};
}
