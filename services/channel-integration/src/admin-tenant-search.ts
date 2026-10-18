import {pool} from './database.js';
export async function searchAdminTenants(query:string,pageRaw:string|null,details=false){
 const q=query.trim();const page=Number(pageRaw??'1');
 if(q.length>100||!Number.isInteger(page)||page<1||page>10000)throw new Error('invalid_search');
 const pattern='%'+q.replace(/[\\%_]/g,'\\$&')+'%';
 const phone=/^[+\d\s()-]+$/.test(q)?q.replace(/\D/g,''):'';
 const rows=(await pool.query(`WITH matches AS MATERIALIZED (
 SELECT tenant_id FROM tenants WHERE $1<>'' AND (name ILIKE $2 OR tenant_id ILIKE $2)
 UNION SELECT m.tenant_id FROM platform_users u JOIN tenant_memberships m USING(platform_user_id)
 WHERE $1<>'' AND m.status='active' AND u.status='active'
 AND (u.email ILIKE $2 OR ($4<>'' AND regexp_replace(COALESCE(u.phone_e164,''),'[^0-9]','','g') LIKE '%'||$4||'%'))
 ), selected AS MATERIALIZED (SELECT t.* FROM tenants t
 WHERE ($1='' OR t.tenant_id IN (SELECT tenant_id FROM matches))
 ORDER BY t.name,t.tenant_id LIMIT 21 OFFSET $3)
 SELECT t.tenant_id,t.name,t.status,subscription.plan_code ${details?`,owner.platform_user_id::text AS admin_user_id,owner.email AS admin_email,
 (SELECT COUNT(*)::int FROM tenant_memberships m WHERE m.tenant_id=t.tenant_id) AS members,
 (SELECT COUNT(*)::int FROM customers c WHERE c.tenant_id=t.tenant_id) AS customers,
 (SELECT COUNT(*)::int FROM payment_orders o WHERE o.tenant_id=t.tenant_id) AS orders`:''}
 FROM selected t
 LEFT JOIN LATERAL (SELECT p.plan_code FROM tenant_subscriptions s JOIN plan_catalog_versions p USING(plan_version_id)
 WHERE s.tenant_id=t.tenant_id AND s.status IN ('active','trialing','past_due') ORDER BY s.created_at DESC LIMIT 1) subscription ON TRUE
 ${details?`LEFT JOIN LATERAL (SELECT u.platform_user_id,u.email FROM tenant_memberships m JOIN platform_users u USING(platform_user_id)
 WHERE m.tenant_id=t.tenant_id AND m.role='tenant_admin' AND m.status='active' AND u.status='active'
 ORDER BY m.created_at,u.platform_user_id LIMIT 1) owner ON TRUE`:''}
 ORDER BY t.name,t.tenant_id`,[q,pattern,(page-1)*20,phone])).rows;
 return {items:rows.slice(0,20),page,has_more:rows.length>20};
}
