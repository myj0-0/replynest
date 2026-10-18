import type {Pool} from 'pg';
import {wechatCustomerName} from './wechat-customer-name.js';
import {safeWechatAvatar} from './shared-wechat-portal.js';
export type PageContact={id:string;display_name:string;channel:string;avatar_url?:string|null};
export type PageAssignment={member_id:string;display_name:string;role:string};
export type ConversationPageContext={ids:Map<string,string>;contacts:Map<string,PageContact>;assignments:Map<string,PageAssignment>};
export function pageAssigneeId(raw:Record<string,any>):string|null{
 const id=raw.meta?.assignee?.id;return (typeof id==='number'||typeof id==='string')&&/^\d+$/.test(String(id))?String(id):null;
}
// Request-local only: no customer/member data survives into another request or tenant.
export async function loadConversationPageContext(db:Pick<Pool,'query'>,tenant:string,account:string,
 rows:Record<string,any>[],syncMissing:(raw:Record<string,any>)=>Promise<void>,sharedWechat=false,authorizedWechatProfiles=false):Promise<ConversationPageContext>{
 if(rows.length>100)throw Error('upstream_page_too_large');
 const valid=rows.filter(r=>typeof r.id==='number'?Number.isSafeInteger(r.id)&&r.id>0:typeof r.id==='string'&&/^\d+$/.test(r.id));
 // Complete validation before any write/sync callback.
 if(rows.some(r=>String(r.account_id)!==account))throw Error('conversation_account_mismatch');
 const keys=[...new Set(valid.map(r=>String(r.id)))];
 const context:ConversationPageContext={ids:new Map(),contacts:new Map(),assignments:new Map()};
 if(!keys.length)return context;
 const readMappings=async()=>{
  const found=(await db.query(`SELECT chatwoot_resource_id,replynest_resource_id::text FROM conversation_resource_mappings
   WHERE tenant_id=$1 AND resource_type='conversation' AND chatwoot_account_id=$2 AND chatwoot_resource_id=ANY($3::text[])`,[tenant,account,keys])).rows;
  for(const r of found)context.ids.set(r.chatwoot_resource_id,r.replynest_resource_id);
 };
 await readMappings();const missing=keys.filter(id=>!context.ids.has(id));
 if(missing.length){
  await db.query(`INSERT INTO conversation_resource_mappings(tenant_id,resource_type,chatwoot_account_id,chatwoot_resource_id)
   SELECT $1,'conversation',$2,id FROM unnest($3::text[]) id
   ON CONFLICT(tenant_id,resource_type,chatwoot_account_id,chatwoot_resource_id) DO NOTHING`,[tenant,account,missing]);
  await readMappings();
 }
 const readContacts=async(ids:string[])=>{
  const found=(await db.query(`SELECT DISTINCT ON(i.chatwoot_conversation_id) i.chatwoot_conversation_id::text AS upstream_id,
   c.customer_id::text,c.name,i.channel,${sharedWechat&&authorizedWechatProfiles?'p.nickname':'NULL'} AS nickname,
   ${sharedWechat&&authorizedWechatProfiles?'p.avatar_url':'NULL'} AS avatar_url,
   CASE WHEN i.channel='shared_wechat' THEN ${sharedWechat?'b.open_id':'NULL'} ELSE i.external_user_id END AS wechat_open_id FROM channel_identities i
   JOIN customers c ON c.tenant_id=i.tenant_id AND c.customer_id=i.customer_id
   ${sharedWechat?`LEFT JOIN shared_wechat_threads b ON i.channel='shared_wechat' AND b.tenant_id=i.tenant_id
    AND b.conversation_id=i.chatwoot_conversation_id AND b.contact_id=i.chatwoot_contact_id
    AND b.account_id=(SELECT chatwoot_account_id FROM tenants WHERE tenant_id=i.tenant_id)`:''}
   ${sharedWechat&&authorizedWechatProfiles?`LEFT JOIN shared_wechat_authorized_profiles p ON p.app_id=b.app_id AND p.open_id=b.open_id AND p.expires_at>NOW()`:''}
   WHERE i.tenant_id=$1 AND i.chatwoot_conversation_id=ANY($2::bigint[])
   ORDER BY i.chatwoot_conversation_id,c.customer_id,i.channel`,[tenant,ids])).rows;
  for(const r of found)context.contacts.set(r.upstream_id,{id:r.customer_id,display_name:wechatCustomerName(r.name,r.channel,r.wechat_open_id,r.nickname),channel:r.channel,
   avatar_url:sharedWechat&&authorizedWechatProfiles&&r.channel==='shared_wechat'?(safeWechatAvatar(r.avatar_url)||null):null});
 };
 await readContacts(keys);
 const unresolved=valid.filter((r,i)=>!context.contacts.has(String(r.id))&&valid.findIndex(x=>String(x.id)===String(r.id))===i);
 // Preserve existing verified channel sync for missing identities, bounded to four workers.
 let next=0;
 await Promise.all(Array.from({length:Math.min(4,unresolved.length)},async()=>{
  for(;;){const row=unresolved[next++];if(!row)return;await syncMissing(row);}
 }));
 if(unresolved.length)await readContacts(unresolved.map(r=>String(r.id)));
 const assigned=[...new Set(valid.map(pageAssigneeId).filter((id):id is string=>id!==null))];
 if(assigned.length){
  const found=(await db.query(`SELECT m.chatwoot_user_id::text AS upstream_id,m.platform_user_id::text,u.display_name,m.role
   FROM tenant_memberships m JOIN platform_users u ON u.platform_user_id=m.platform_user_id
   WHERE m.tenant_id=$1 AND m.chatwoot_user_id=ANY($2::bigint[]) AND m.status='active'`,[tenant,assigned])).rows;
  for(const r of found)context.assignments.set(r.upstream_id,{member_id:r.platform_user_id,display_name:r.display_name,role:r.role});
 }
 return context;
}
