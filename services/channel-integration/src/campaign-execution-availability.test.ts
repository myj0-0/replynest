import test from 'node:test';
import assert from 'node:assert/strict';
import {campaignExecutionAvailability} from './campaign-access-core.js';

test('campaign controls fail closed and distinguish scheduling, send and query-only reconciliation',()=>{
 const off={execution_enabled:false,send_enabled:false,receipt_enabled:false};
 assert.deepEqual(campaignExecutionAvailability(true,{}),off);
 const env={MESSAGE_CAMPAIGN_EXECUTION_ENABLED:'true',MESSAGE_CAMPAIGN_PROVIDER:'wechat_mass',
  MASS_CAMPAIGN_SCHEDULING_ENABLED:'true',MASS_CAMPAIGN_WORKER_ENABLED:'true',MASS_CAMPAIGN_RECEIPT_WORKER_ENABLED:'true'};
 assert.deepEqual(campaignExecutionAvailability(false,env),off);
 assert.deepEqual(campaignExecutionAvailability(true,env),{execution_enabled:true,send_enabled:true,receipt_enabled:true});
 assert.deepEqual(campaignExecutionAvailability(true,{...env,MASS_CAMPAIGN_SCHEDULING_ENABLED:'false'}),
  {execution_enabled:false,send_enabled:true,receipt_enabled:true});
 for(const change of [{MESSAGE_CAMPAIGN_EXECUTION_ENABLED:'false'},{MESSAGE_CAMPAIGN_PROVIDER:'synthetic'}]){
  assert.deepEqual(campaignExecutionAvailability(true,{...env,...change}),{...off,receipt_enabled:true});
 }
 assert.deepEqual(campaignExecutionAvailability(true,{...env,MASS_CAMPAIGN_WORKER_ENABLED:'false'}),
  {execution_enabled:true,send_enabled:false,receipt_enabled:true});
});
