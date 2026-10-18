/** Platform eligibility is independent of provider delivery capability and marketing consent. */
export type CampaignAccessFacts = {
  planCode: string;
  tenantStatus: string;
  channelType: string;
  channelStatus: string;
  connectionTenantId: string;
  tenantId: string;
  appId: string;
  sharedApp: boolean;
};

export function campaignAccessDecision(f: CampaignAccessFacts): string | null {
  if (!['active', 'test'].includes(f.tenantStatus)) return 'campaign_tenant_inactive';
  if (f.planCode !== 'professional') return 'campaign_professional_required';
  if (f.connectionTenantId !== f.tenantId) return 'campaign_channel_not_owned';
  if (f.sharedApp || f.channelType === 'shared_wechat') return 'campaign_shared_channel_forbidden';
  if (f.channelType !== 'wechat_official_account' || f.channelStatus !== 'ready' || !/^wx[A-Za-z0-9]{16}$/.test(f.appId)) {
    return 'campaign_independent_channel_required';
  }
  return null;
}

/** UI availability is not permission: every mutation and send rechecks access. */
export function campaignExecutionAvailability(eligible:boolean,env:NodeJS.ProcessEnv=process.env){
  const enabled=eligible&&env.MESSAGE_CAMPAIGN_EXECUTION_ENABLED==='true'&&env.MESSAGE_CAMPAIGN_PROVIDER==='wechat_mass';
  return {execution_enabled:enabled&&env.MASS_CAMPAIGN_SCHEDULING_ENABLED==='true',
    send_enabled:enabled&&env.MASS_CAMPAIGN_WORKER_ENABLED==='true',
    receipt_enabled:eligible&&env.MASS_CAMPAIGN_RECEIPT_WORKER_ENABLED==='true'};
}
