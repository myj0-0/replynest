import test from 'node:test';
import assert from 'node:assert/strict';
import {campaignAccessDecision, type CampaignAccessFacts} from './campaign-access-core.js';
const allowed: CampaignAccessFacts = {planCode:'professional',tenantStatus:'active',channelType:'wechat_official_account',
  channelStatus:'ready',connectionTenantId:'a',tenantId:'a',appId:'wx1234567890abcdef',sharedApp:false};
test('professional independent account is eligible',()=>assert.equal(campaignAccessDecision(allowed),null));
test('other plans do not inherit broadcast permission',()=>{
  for(const planCode of ['free','starter','enterprise','unknown']) assert.equal(campaignAccessDecision({...allowed,planCode}),'campaign_professional_required');
});
test('shared account cannot masquerade as an independent connection',()=>{
  assert.equal(campaignAccessDecision({...allowed,sharedApp:true}),'campaign_shared_channel_forbidden');
  assert.equal(campaignAccessDecision({...allowed,channelType:'shared_wechat'}),'campaign_shared_channel_forbidden');
});
test('ownership, tenant and channel status fail closed',()=>{
  assert.equal(campaignAccessDecision({...allowed,connectionTenantId:'b'}),'campaign_channel_not_owned');
  assert.equal(campaignAccessDecision({...allowed,tenantStatus:'suspended'}),'campaign_tenant_inactive');
  for(const channelStatus of ['pending','disabled','failed']) assert.equal(campaignAccessDecision({...allowed,channelStatus}),'campaign_independent_channel_required');
  assert.equal(campaignAccessDecision({...allowed,appId:''}),'campaign_independent_channel_required');
});
