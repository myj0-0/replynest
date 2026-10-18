import type { Pool } from 'pg';
export function sharedWechatMerchantSchemaSql(): string {
  return `CREATE TABLE IF NOT EXISTS shared_wechat_merchant_profiles (
    tenant_id TEXT PRIMARY KEY REFERENCES tenants(tenant_id), introduction TEXT NOT NULL DEFAULT '', website TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`;
}
export async function migrateSharedWechatMerchant(db:Pool) {
  await db.query(sharedWechatMerchantSchemaSql());
}
export function merchantProfile(input:Record<string,unknown>) {
  if(typeof input.introduction!=='string'||typeof input.website!=='string'||input.introduction.length>300||input.website.length>400)throw new Error('invalid_input');
  const introduction=input.introduction.trim(),website=input.website.trim();
  if(website){const u=new URL(website);if(u.protocol!=='https:'||u.username||u.password)throw new Error('invalid_input');}
  return {introduction,website};
}
export async function sharedMerchantWelcome(db:Pool,tenantId:string) {
  const r=await db.query(`SELECT t.name,p.introduction,p.website FROM tenants t LEFT JOIN shared_wechat_merchant_profiles p USING(tenant_id) WHERE t.tenant_id=$1`,[tenantId]);
  const p=r.rows[0];if(!p)return '';
  const intro=p.introduction?Array.from(String(p.introduction)).slice(0,150).join('')+(p.introduction.length>150?'…（完整介绍见详情）':''):'欢迎咨询，我们很乐意为您解答问题。';
  return `商家：${String(p.name).replace(/[\r\n]/g,' ').slice(0,80)}\n${intro}${p.website?'\n商家网址：'+p.website:''}\n\n使用说明：发送文字即可咨询当前商家；请勿发送密码或验证码。点击底部“切换商家”可更换咨询对象。\n商家详情与切换：https://replynest.cn/wechat/merchants`;
}
