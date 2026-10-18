import type {DatabaseComponent} from './database-runtime.js';
export const tenantSecuritySchema=`
CREATE TABLE IF NOT EXISTS public.tenant_security_events (
 event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT NOT NULL REFERENCES public.tenants(tenant_id),
 actor_type TEXT NOT NULL CHECK(actor_type IN('platform_user','tenant_api_key')),actor_id TEXT NOT NULL,
 category TEXT NOT NULL CHECK(category IN('login','operation')),action TEXT NOT NULL CHECK(length(action)<=120),
 route TEXT NOT NULL CHECK(length(route)<=320),method TEXT NOT NULL CHECK(method IN('GET','POST','PATCH','PUT','DELETE')),
 http_status SMALLINT NOT NULL CHECK(http_status BETWEEN 100 AND 599),client_ip INET,
 user_agent TEXT CHECK(length(user_agent)<=512),ip_source TEXT NOT NULL CHECK(ip_source IN('verified_proxy','unavailable')),
 impersonated BOOLEAN NOT NULL DEFAULT false,request_id UUID NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(tenant_id,request_id,action)
);
CREATE INDEX IF NOT EXISTS tenant_security_timeline ON public.tenant_security_events(tenant_id,created_at DESC,event_id DESC);
CREATE INDEX IF NOT EXISTS tenant_security_personal ON public.tenant_security_events(tenant_id,actor_id,created_at DESC,event_id DESC);
CREATE INDEX IF NOT EXISTS tenant_security_expiry ON public.tenant_security_events(created_at,event_id);
CREATE OR REPLACE FUNCTION public.prevent_tenant_security_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.tenant_security_events'::regclass)
    AND OLD.created_at < NOW()-INTERVAL '6 months' THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'tenant security events are append-only until expiry';
END;$$;
DROP TRIGGER IF EXISTS tenant_security_append_only ON public.tenant_security_events;
CREATE TRIGGER tenant_security_append_only BEFORE UPDATE OR DELETE ON public.tenant_security_events FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_security_mutation();
CREATE OR REPLACE FUNCTION public.purge_expired_tenant_security_events() RETURNS INTEGER
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE affected INTEGER;
BEGIN
 IF NOT pg_try_advisory_xact_lock(709221684315::bigint) THEN RETURN 0; END IF;
 DELETE FROM public.tenant_security_events WHERE event_id IN(
   SELECT event_id FROM public.tenant_security_events WHERE created_at<NOW()-INTERVAL '6 months'
   ORDER BY created_at,event_id LIMIT 500 FOR UPDATE SKIP LOCKED);
 GET DIAGNOSTICS affected=ROW_COUNT;RETURN affected;
END;$$;
REVOKE ALL ON FUNCTION public.purge_expired_tenant_security_events() FROM PUBLIC;
`;
export function tenantSecurityComponent():DatabaseComponent{return{name:'tenant_security_events',sql:tenantSecuritySchema,migrate:async()=>{throw Error('tenant_security_owner_migration_required')}};}
