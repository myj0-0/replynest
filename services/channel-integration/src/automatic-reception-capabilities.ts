import type {PoolClient} from 'pg';
import {automaticWebEnabled} from './automatic-reception-config.js';
import {AUTOMATIC_SEND_CONSENT_VERSION} from './automatic-reply-policy.js';
import {AUTOMATIC_WECHAT_SEND_CONSENT_VERSION} from './automatic-wechat-target.js';
export type AutomaticChannel='web_chat'|'wechat_official_account'|'shared_wechat';
/** Platform gates describe configured executors, not guaranteed provider delivery.
 * No credential/model/native reads and no experimental SQL when all gates are off.
 */
export function automaticRuntimeChannels():AutomaticChannel[]{
 const channels:AutomaticChannel[]=automaticWebEnabled()?['web_chat']:[];
 if(process.env.AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED==='true'&&process.env.AI_RECEPTION_AUTOMATIC_WECHAT_MANAGEMENT_ENABLED==='true'&&
  process.env.AI_RECEPTION_AUTOMATIC_WECHAT_ENABLED==='true'&&process.env.AI_POINTS_ENABLED==='true'&&
  process.env.WECHAT_VERIFIED_INGRESS_ENABLED==='true'&&process.env.DATABASE_STARTUP_MODE==='verify')channels.push('wechat_official_account','shared_wechat');
 return channels;
}
/** Same tenant/native account and current primary grant; WeChat additionally
 * needs its own versioned, explicitly selected scope. Caller may hold management
 * advisory lock for a mode mutation; this helper never grants or changes anything.
 */
export async function readAutomaticAuthorizedChannels(c:Pick<PoolClient,'query'>,tenant:string,available:AutomaticChannel[]):Promise<AutomaticChannel[]>{
 if(!available.length)return [];
 const primary=(await c.query(`SELECT g.authorization_id FROM automatic_reception_grants g JOIN tenants t USING(tenant_id)
  WHERE g.tenant_id=$1 AND g.enabled AND g.consent_version=$2 AND g.account_id=t.chatwoot_account_id::text
   AND t.status IN('active','test')`,[tenant,AUTOMATIC_SEND_CONSENT_VERSION])).rows[0];
 if(!primary)return [];
 const channels:AutomaticChannel[]=available.includes('web_chat')?['web_chat']:[];
 if(available.some(ch=>ch!=='web_chat')){
  const scope=(await c.query(`SELECT channels FROM automatic_reception_wechat_grants
   WHERE tenant_id=$1 AND authorization_id=$2 AND enabled AND consent_version=$3`,
   [tenant,primary.authorization_id,AUTOMATIC_WECHAT_SEND_CONSENT_VERSION])).rows[0];
  if(scope&&Array.isArray(scope.channels))for(const channel of ['wechat_official_account','shared_wechat'] as const)
   if(available.includes(channel)&&scope.channels.includes(channel))channels.push(channel);
 }
 return channels;
}
