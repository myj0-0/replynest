import type { Pool } from "pg";

/** Only the designated and explicitly activated account takes over legacy routes. */
export async function isSharedWechatAccountActive(db:Pool,appId:string,configuredId:string|undefined,callbackEnabled:boolean):Promise<boolean> {
  if(!callbackEnabled || !appId || appId!==configuredId)return false;
  const account=await db.query(`SELECT 1 FROM shared_wechat_accounts WHERE app_id=$1 AND enabled=TRUE`,[appId]);
  return !!account.rows[0];
}
