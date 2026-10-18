import type {DatabaseComponent} from './database-runtime.js';
export const referralPartnerSchema=`
CREATE TABLE public.tenant_referral_partner_access (
 tenant_id TEXT PRIMARY KEY REFERENCES public.tenants(tenant_id),
 enabled BOOLEAN NOT NULL DEFAULT FALSE,
 version INTEGER NOT NULL CHECK(version>0),
 reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 500),
 updated_by UUID NOT NULL REFERENCES public.platform_admin_accounts(admin_id),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
`;
export function referralPartnerComponent():DatabaseComponent{return {name:'referral_partner_access',sql:referralPartnerSchema,migrate:async()=>{throw Error('referral_partner_owner_migration_required');}};}
