import { pool } from './database.js';

export function parsePrice(value:unknown,optional=false):number|null {
  if(optional&&(value===undefined||value===null||value===''))return null;
  if(typeof value!=='string'||!/^\d{1,6}(\.\d{1,2})?$/.test(value))throw new Error('invalid_price');
  const [whole,fraction='']=value.split('.'),minor=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  if(minor<=0||minor>99999999)throw new Error('invalid_price');return minor;
}
export async function listPlanPricing() {
  return (await pool.query(`SELECT plan_version_id,plan_code,version,status,name,price_minor::text,list_price_minor::text,
    (price_minor*8)::text AS annual_price_minor,(list_price_minor*12)::text AS annual_list_price_minor,effective_from,effective_until
    FROM plan_catalog_versions WHERE plan_code IN ('starter','professional') ORDER BY plan_code,version DESC LIMIT 100`)).rows;
}
export async function publishPlanPricing(raw:Record<string,unknown>,adminId:string) {
  const code=String(raw.plan_code??''),expected=Number(raw.expected_version),reason=String(raw.reason??'').trim();
  const price=parsePrice(raw.price_yuan)!,list=parsePrice(raw.list_price_yuan,true);
  if(!['starter','professional'].includes(code)||!Number.isInteger(expected)||expected<1||reason.length<10||reason.length>500||list!==null&&list<price)throw new Error('invalid_plan_pricing');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`plan-pricing:${code}`]);
    const current=(await client.query(`SELECT * FROM plan_catalog_versions WHERE plan_code=$1 AND status='active' FOR UPDATE`,[code])).rows[0];
    if(!current||current.version!==expected)throw new Error('plan_version_changed');
    const version=Number((await client.query('SELECT MAX(version) AS version FROM plan_catalog_versions WHERE plan_code=$1',[code])).rows[0].version)+1;
    // Clock time, not transaction start, ensures a version published while waiting on a lock is ordered correctly.
    const at=(await client.query(`SELECT GREATEST(clock_timestamp(),$1::timestamptz+INTERVAL '1 millisecond') AS at`,[current.effective_from])).rows[0].at;
    await client.query(`UPDATE plan_catalog_versions SET status='retired',effective_until=$2 WHERE plan_version_id=$1`,[current.plan_version_id,at]);
    const next=(await client.query(`INSERT INTO plan_catalog_versions(plan_code,version,status,name,billing_period,price_minor,list_price_minor,currency,entitlement_rules,effective_from)
      VALUES($1,$2,'active',$3,'monthly',$4,$5,'CNY',$6,$7) RETURNING plan_version_id,plan_code,version,price_minor::text,list_price_minor::text`,[code,version,current.name,price,list,current.entitlement_rules,at])).rows[0];
    await client.query(`INSERT INTO plan_price_publications(plan_version_id,previous_version_id,admin_id,reason) VALUES($1,$2,$3,$4)`,[next.plan_version_id,current.plan_version_id,adminId,reason]);
    await client.query('COMMIT');return next;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
