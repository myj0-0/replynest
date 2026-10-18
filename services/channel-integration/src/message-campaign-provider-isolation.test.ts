import test from 'node:test';
import assert from 'node:assert/strict';

test('synthetic polling scopes scheduling, recovery and claims to mock channels',async(t)=>{
  const keys=['POSTGRES_HOST','POSTGRES_DATABASE','POSTGRES_USERNAME','POSTGRES_PASSWORD','MESSAGE_CAMPAIGN_EXECUTION_ENABLED','MESSAGE_CAMPAIGN_PROVIDER'];
  const before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  Object.assign(process.env,{POSTGRES_HOST:'127.0.0.1',POSTGRES_DATABASE:'not-used',POSTGRES_USERNAME:'not-used',POSTGRES_PASSWORD:'not-used',MESSAGE_CAMPAIGN_EXECUTION_ENABLED:'true',MESSAGE_CAMPAIGN_PROVIDER:'synthetic'});
  const {pool}=await import('./database.js');
  const {processMessageCampaignDeliveries}=await import('./message-campaign-delivery.js');
  const statements:string[]=[];
  const query=async(sql:unknown)=>{statements.push(String(sql));return {rows:[],rowCount:0};};
  const originalQuery=pool.query,originalConnect=pool.connect;
  (pool as any).query=query;
  (pool as any).connect=async()=>({query,release(){}});
  t.after(async()=>{
    pool.query=originalQuery;pool.connect=originalConnect;
    await pool.end();
    for(const key of keys){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}
  });
  const result=await processMessageCampaignDeliveries(new Date(),1);
  assert.equal(result.claimed,0);
  const work=statements.filter(sql=>!['BEGIN','COMMIT'].includes(sql));
  assert.equal(work.length,3);
  for(const sql of work)assert.match(sql,/channel='mock-wechat'/);
  assert.match(work[0],/c\.tenant_id=d\.tenant_id/);
  statements.length=0;
  process.env.MESSAGE_CAMPAIGN_PROVIDER='wechat_mass';
  await processMessageCampaignDeliveries(new Date(),1);
  assert.equal(statements.length,0,'synthetic worker must leave real-provider queues untouched');
});
