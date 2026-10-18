import type {Pool} from 'pg';
import {checkMassPolicy} from './mass-campaign-policy.js';
import type {StoredMassAdapter} from './mass-campaign-runtime.js';
import type {MassReceiptLease} from './mass-campaign-store.js';
import {resolveWeChatConnectionById} from './wechat-connection.js';
import {submitOfficialMassText,queryOfficialMassStatus} from './wechat-official.js';

/** Opt-in production adapter. Never resolve a default/shared sender. */
export function officialMassAdapter(db:Pick<Pool,'query'>):StoredMassAdapter{
 return {
  enabled:()=>process.env.MESSAGE_CAMPAIGN_EXECUTION_ENABLED==='true'&&process.env.MESSAGE_CAMPAIGN_PROVIDER==='wechat_mass',
  prepare:lease=>checkMassPolicy(db,lease),
  authorize:(client,lease)=>checkMassPolicy(client,lease,true),
  submit:async(lease,batch)=>{
   const connection=await resolveWeChatConnectionById(lease.connectionId,lease.tenantId);
   if(!connection||connection.tenantId!==lease.tenantId||connection.connectionId!==lease.connectionId||connection.config.appId!==lease.appId)throw Error('mass_sender_changed');
   return submitOfficialMassText(connection.config,batch.openIds,batch.content,batch.clientId);
  },
 };
}

export async function queryStoredOfficialMass(db:Pick<Pool,'query'>,lease:MassReceiptLease){
 if(lease.appId===process.env.SHARED_WECHAT_APP_ID)throw Error('mass_shared_sender_forbidden');
 const shared=(await db.query("SELECT to_regclass('shared_wechat_accounts') IS NOT NULL present")).rows[0].present;
 if(shared&&(await db.query('SELECT 1 FROM shared_wechat_accounts WHERE app_id=$1',[lease.appId])).rowCount)throw Error('mass_shared_sender_forbidden');
 const connection=await resolveWeChatConnectionById(lease.connectionId,lease.tenantId);
 if(!connection||connection.tenantId!==lease.tenantId||connection.connectionId!==lease.connectionId||connection.config.appId!==lease.appId)throw Error('mass_sender_changed');
 const status=await queryOfficialMassStatus(connection.config,lease.receiptId);
 return {msg_id:lease.receiptId,msg_status:{sending:'SENDING',succeeded:'SEND_SUCCESS',failed:'SEND_FAIL',deleted:'DELETE'}[status]};
}
