import type {DatabaseComponent} from './database-runtime.js';

/** A separate, owner-installed purpose. Never put these notes in customers.attributes:
 * the public business API exposes that JSON to integrations without this consent. */
export const customerInsightsSchema=`
CREATE INDEX customer_insight_contact_binding ON public.channel_identities(tenant_id,chatwoot_contact_id,customer_id);
CREATE TABLE public.customer_insight_settings (
 tenant_id TEXT PRIMARY KEY REFERENCES public.tenants(tenant_id),account_id BIGINT NOT NULL CHECK(account_id>0),
 enabled BOOLEAN NOT NULL DEFAULT false,daily_budget_micros BIGINT NOT NULL CHECK(daily_budget_micros BETWEEN 1000 AND 10000000000),
 consent_version TEXT NOT NULL CHECK(consent_version='customer-insights-v1'),grant_id UUID NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>0),revision INTEGER NOT NULL CHECK(revision>0),
 authorized_by UUID NOT NULL REFERENCES public.platform_users(platform_user_id),updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.customer_insight_profiles (
 tenant_id TEXT NOT NULL REFERENCES public.tenants(tenant_id),customer_id UUID NOT NULL REFERENCES public.customers(customer_id),
 account_id BIGINT NOT NULL CHECK(account_id>0),revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 ai_facts JSONB NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(ai_facts)='array' AND jsonb_array_length(ai_facts)<=12),
 manual_facts JSONB CHECK(manual_facts IS NULL OR (jsonb_typeof(manual_facts)='array' AND jsonb_array_length(manual_facts)<=12)),
 suppressed BOOLEAN NOT NULL DEFAULT false,last_scan_at TIMESTAMPTZ,last_scan_id BIGINT CHECK(last_scan_id>0),updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 search_text TEXT GENERATED ALWAYS AS (CASE WHEN suppressed THEN '' ELSE jsonb_path_query_array(COALESCE(manual_facts,ai_facts),'$[*].text')::text END) STORED,
 PRIMARY KEY(tenant_id,customer_id)
);
CREATE TABLE public.customer_insight_summaries (
 tenant_id TEXT NOT NULL,customer_id UUID NOT NULL,conversation_id BIGINT NOT NULL CHECK(conversation_id>0),
 ai_issue JSONB NOT NULL CHECK(jsonb_typeof(ai_issue)='object'),manual_issue TEXT CHECK(length(manual_issue)<=600),
 topic TEXT NOT NULL CHECK(topic IN('consultation','onboarding','usage','shipping','refund','billing','complaint','integration','other')),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 search_text TEXT GENERATED ALWAYS AS (COALESCE(manual_issue,ai_issue->>'text','')) STORED,
 PRIMARY KEY(tenant_id,customer_id,conversation_id),
 FOREIGN KEY(tenant_id,customer_id) REFERENCES public.customer_insight_profiles(tenant_id,customer_id)
);
CREATE INDEX customer_insight_recent_topics ON public.customer_insight_summaries(tenant_id,updated_at DESC,customer_id);
CREATE INDEX customer_insight_profile_search ON public.customer_insight_profiles USING gin(search_text gin_trgm_ops) WHERE NOT suppressed;
CREATE INDEX customer_insight_summary_search ON public.customer_insight_summaries USING gin(search_text gin_trgm_ops);
CREATE TABLE public.customer_insight_jobs (
 job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT NOT NULL,customer_id UUID NOT NULL,
 account_id BIGINT NOT NULL CHECK(account_id>0),conversation_id BIGINT NOT NULL CHECK(conversation_id>0),
 grant_id UUID NOT NULL,generation INTEGER NOT NULL CHECK(generation>0),revision INTEGER NOT NULL CHECK(revision>=0),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','leased','calling','saved','skipped','revoked','budget_exhausted','rejected','uncertain')),
 lease UUID,lease_until TIMESTAMPTZ,event_count INTEGER NOT NULL DEFAULT 1 CHECK(event_count BETWEEN 1 AND 10000),
 source_as_of TIMESTAMPTZ,source_cursor_at TIMESTAMPTZ,source_cursor_id BIGINT CHECK(source_cursor_id>0),source_has_more BOOLEAN,source_row_count INTEGER CHECK(source_row_count BETWEEN 0 AND 40),
 source_event_ids JSONB CHECK(source_event_ids IS NULL OR (jsonb_typeof(source_event_ids)='array' AND jsonb_array_length(source_event_ids)<=100)),
 evidence_ids JSONB CHECK(evidence_ids IS NULL OR (jsonb_typeof(evidence_ids)='array' AND jsonb_array_length(evidence_ids)<=88)),
 current_evidence_ids JSONB CHECK(current_evidence_ids IS NULL OR (jsonb_typeof(current_evidence_ids)='array' AND jsonb_array_length(current_evidence_ids)<=40)),
 due_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),completed_at TIMESTAMPTZ,
 FOREIGN KEY(tenant_id,customer_id) REFERENCES public.customer_insight_profiles(tenant_id,customer_id),
 CHECK((state IN('leased','calling') AND lease IS NOT NULL AND lease_until IS NOT NULL) OR state NOT IN('leased','calling'))
);
CREATE UNIQUE INDEX customer_insight_pending ON public.customer_insight_jobs(tenant_id,customer_id) WHERE state='pending';
CREATE UNIQUE INDEX customer_insight_active ON public.customer_insight_jobs(tenant_id,customer_id) WHERE state IN('leased','calling');
CREATE INDEX customer_insight_due ON public.customer_insight_jobs(due_at,job_id) WHERE state='pending';
CREATE INDEX customer_insight_stale ON public.customer_insight_jobs(tenant_id,lease_until) WHERE state IN('leased','calling');
CREATE INDEX customer_insight_stale_due ON public.customer_insight_jobs(lease_until,tenant_id) WHERE state IN('leased','calling');
CREATE INDEX customer_insight_saved_recent ON public.customer_insight_jobs(tenant_id,completed_at DESC,customer_id) WHERE state='saved';
CREATE INDEX customer_insight_billing_page ON public.customer_insight_jobs(tenant_id,created_at DESC,job_id DESC);
CREATE TABLE public.customer_insight_events (
 tenant_id TEXT NOT NULL,account_id BIGINT NOT NULL CHECK(account_id>0),message_id BIGINT NOT NULL CHECK(message_id>0),
 customer_id UUID NOT NULL,job_id UUID NOT NULL REFERENCES public.customer_insight_jobs(job_id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,account_id,message_id),
 FOREIGN KEY(tenant_id,customer_id) REFERENCES public.customer_insight_profiles(tenant_id,customer_id)
);
CREATE INDEX customer_insight_event_backlog ON public.customer_insight_events(tenant_id,customer_id,account_id,message_id);
CREATE TABLE public.customer_insight_processed_events (
 tenant_id TEXT NOT NULL,account_id BIGINT NOT NULL,message_id BIGINT NOT NULL,
 job_id UUID NOT NULL REFERENCES public.customer_insight_jobs(job_id),created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,account_id,message_id),
 FOREIGN KEY(tenant_id,account_id,message_id) REFERENCES public.customer_insight_events(tenant_id,account_id,message_id)
);
CREATE TABLE public.customer_insight_budget (
 ticket UUID PRIMARY KEY DEFAULT gen_random_uuid(),job_id UUID NOT NULL UNIQUE REFERENCES public.customer_insight_jobs(job_id),
 tenant_id TEXT NOT NULL REFERENCES public.tenants(tenant_id),budget_day DATE NOT NULL,
 estimated_micros BIGINT NOT NULL CHECK(estimated_micros>0 AND estimated_micros<=10000000000),
 charged_micros BIGINT NOT NULL DEFAULT 0 CHECK(charged_micros>=0 AND charged_micros<=estimated_micros),
 state TEXT NOT NULL DEFAULT 'held' CHECK(state IN('held','calling','known','not_called','unknown')),
 ai_call_id UUID UNIQUE REFERENCES public.ai_usage_calls(call_id),created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CHECK(state NOT IN('calling','known','unknown') OR ai_call_id IS NOT NULL)
);
CREATE INDEX customer_insight_daily_budget ON public.customer_insight_budget(tenant_id,budget_day);
CREATE TABLE public.customer_insight_intake (
 intake_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT NOT NULL REFERENCES public.tenants(tenant_id),
 account_id BIGINT NOT NULL CHECK(account_id>0),inbox_id BIGINT NOT NULL CHECK(inbox_id>0),conversation_id BIGINT NOT NULL CHECK(conversation_id>0),
 message_id BIGINT NOT NULL CHECK(message_id>0),grant_id UUID NOT NULL,generation INTEGER NOT NULL CHECK(generation>0),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','processing','done','ignored','failed')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),lease UUID,locked_at TIMESTAMPTZ,
 due_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),reason TEXT,
 UNIQUE(tenant_id,account_id,message_id),CHECK(state!='processing' OR (lease IS NOT NULL AND locked_at IS NOT NULL))
);
CREATE INDEX customer_insight_intake_due ON public.customer_insight_intake(due_at,intake_id) WHERE state='pending';
CREATE INDEX customer_insight_intake_stale ON public.customer_insight_intake(locked_at,intake_id) WHERE state='processing';
CREATE INDEX customer_insight_intake_tenant ON public.customer_insight_intake(tenant_id,state) WHERE state IN('pending','processing');
-- Recorded in the verified inbound receipt transaction, not a history scan or
-- an after-commit best-effort callback. Contains metadata only, no transcript.
CREATE TABLE public.customer_insight_sources (
 source_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT NOT NULL REFERENCES public.tenants(tenant_id),
 account_id BIGINT NOT NULL CHECK(account_id>0),inbox_id BIGINT NOT NULL CHECK(inbox_id>0),conversation_id BIGINT NOT NULL CHECK(conversation_id>0),
 message_id BIGINT NOT NULL CHECK(message_id>0),grant_id UUID NOT NULL,generation INTEGER NOT NULL CHECK(generation>0),
 source_kind TEXT NOT NULL CHECK(source_kind IN('independent','shared')),source_key TEXT NOT NULL CHECK(source_key~'^[a-f0-9]{64}$'),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','processing','done','ignored')),
 lease UUID,locked_at TIMESTAMPTZ,due_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,account_id,message_id),UNIQUE(source_kind,source_key),
 CHECK(state!='processing' OR (lease IS NOT NULL AND locked_at IS NOT NULL))
);
CREATE INDEX customer_insight_sources_due ON public.customer_insight_sources(due_at,source_id) WHERE state='pending';
CREATE INDEX customer_insight_sources_stale ON public.customer_insight_sources(locked_at,source_id) WHERE state='processing';
CREATE TABLE public.customer_insight_audit (
 audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT NOT NULL REFERENCES public.tenants(tenant_id),
 actor_id UUID NOT NULL REFERENCES public.platform_users(platform_user_id),customer_id UUID,
 action TEXT NOT NULL CHECK(action IN('authorize','revoke','correct','delete','resume','cost_reconcile')),
 revision INTEGER NOT NULL CHECK(revision>0),created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE OR REPLACE FUNCTION public.guard_customer_insight_records() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='customer_insight_profiles' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'customer insight profile requires a deletion tombstone'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.customers c JOIN public.tenants t USING(tenant_id)
   WHERE c.customer_id=NEW.customer_id AND c.tenant_id=NEW.tenant_id AND t.chatwoot_account_id=NEW.account_id) THEN
   RAISE EXCEPTION 'customer insight profile binding mismatch';
  END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.tenant_id,NEW.customer_id,NEW.account_id)
   IS DISTINCT FROM ROW(OLD.tenant_id,OLD.customer_id,OLD.account_id) THEN
   RAISE EXCEPTION 'customer insight profile identity is immutable';
  END IF;
 END IF;
 IF TG_TABLE_NAME IN('customer_insight_events','customer_insight_processed_events','customer_insight_audit') THEN
  RAISE EXCEPTION 'customer insight evidence and audit are append only';
 END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'customer insight records cannot be silently deleted'; END IF;
 IF TG_TABLE_NAME='customer_insight_jobs' THEN
  IF ROW(NEW.job_id,NEW.tenant_id,NEW.customer_id,NEW.account_id,NEW.grant_id,NEW.generation,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.job_id,OLD.tenant_id,OLD.customer_id,OLD.account_id,OLD.grant_id,OLD.generation,OLD.created_at)
   OR (OLD.evidence_ids IS NOT NULL AND ROW(NEW.evidence_ids,NEW.current_evidence_ids,NEW.source_as_of,NEW.source_cursor_at,NEW.source_cursor_id,NEW.source_has_more,NEW.source_event_ids,NEW.source_row_count) IS DISTINCT FROM ROW(OLD.evidence_ids,OLD.current_evidence_ids,OLD.source_as_of,OLD.source_cursor_at,OLD.source_cursor_id,OLD.source_has_more,OLD.source_event_ids,OLD.source_row_count))
   OR (OLD.state NOT IN('pending','leased','calling') AND NEW IS DISTINCT FROM OLD) THEN
   RAISE EXCEPTION 'customer insight job identity, evidence or terminal state is immutable';
  END IF;
 END IF;
 IF TG_TABLE_NAME='customer_insight_intake' THEN
  IF ROW(NEW.intake_id,NEW.tenant_id,NEW.account_id,NEW.inbox_id,NEW.conversation_id,NEW.message_id,NEW.grant_id,NEW.generation,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.intake_id,OLD.tenant_id,OLD.account_id,OLD.inbox_id,OLD.conversation_id,OLD.message_id,OLD.grant_id,OLD.generation,OLD.created_at)
   OR (OLD.state IN('done','ignored','failed') AND NEW IS DISTINCT FROM OLD) THEN
   RAISE EXCEPTION 'customer insight intake identity and terminal state are immutable';
  END IF;
 END IF;
 IF TG_TABLE_NAME='customer_insight_sources' THEN
  IF ROW(NEW.source_id,NEW.tenant_id,NEW.account_id,NEW.inbox_id,NEW.conversation_id,NEW.message_id,NEW.grant_id,NEW.generation,NEW.source_kind,NEW.source_key,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.source_id,OLD.tenant_id,OLD.account_id,OLD.inbox_id,OLD.conversation_id,OLD.message_id,OLD.grant_id,OLD.generation,OLD.source_kind,OLD.source_key,OLD.created_at)
   OR (OLD.state IN('done','ignored') AND NEW IS DISTINCT FROM OLD) THEN
   RAISE EXCEPTION 'customer insight source identity and terminal state are immutable';
  END IF;
 END IF;
 IF TG_TABLE_NAME='customer_insight_budget' THEN
  IF ROW(NEW.ticket,NEW.job_id,NEW.tenant_id,NEW.budget_day,NEW.estimated_micros,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.ticket,OLD.job_id,OLD.tenant_id,OLD.budget_day,OLD.estimated_micros,OLD.created_at)
   OR (OLD.ai_call_id IS NOT NULL AND NEW.ai_call_id IS DISTINCT FROM OLD.ai_call_id)
   OR (OLD.state IN('known','not_called') AND NEW IS DISTINCT FROM OLD) THEN
   RAISE EXCEPTION 'customer insight budget identity or settlement is immutable';
  END IF;
 END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER customer_insight_budget_guard BEFORE UPDATE OR DELETE ON public.customer_insight_budget
 FOR EACH ROW EXECUTE FUNCTION public.guard_customer_insight_records();
CREATE TRIGGER customer_insight_profiles_guard BEFORE INSERT OR UPDATE OR DELETE ON public.customer_insight_profiles
 FOR EACH ROW EXECUTE FUNCTION public.guard_customer_insight_records();
CREATE TRIGGER customer_insight_jobs_guard BEFORE UPDATE OR DELETE ON public.customer_insight_jobs
 FOR EACH ROW EXECUTE FUNCTION public.guard_customer_insight_records();
CREATE TRIGGER customer_insight_events_guard BEFORE UPDATE OR DELETE ON public.customer_insight_events
 FOR EACH ROW EXECUTE FUNCTION public.guard_customer_insight_records();
CREATE TRIGGER customer_insight_processed_events_guard BEFORE UPDATE OR DELETE ON public.customer_insight_processed_events
 FOR EACH ROW EXECUTE FUNCTION public.guard_customer_insight_records();
CREATE TRIGGER customer_insight_audit_guard BEFORE UPDATE OR DELETE ON public.customer_insight_audit
 FOR EACH ROW EXECUTE FUNCTION public.guard_customer_insight_records();
CREATE TRIGGER customer_insight_intake_guard BEFORE UPDATE OR DELETE ON public.customer_insight_intake
 FOR EACH ROW EXECUTE FUNCTION public.guard_customer_insight_records();
CREATE TRIGGER customer_insight_sources_guard BEFORE UPDATE OR DELETE ON public.customer_insight_sources
 FOR EACH ROW EXECUTE FUNCTION public.guard_customer_insight_records();
REVOKE ALL ON FUNCTION public.guard_customer_insight_records() FROM PUBLIC;
`;
export function customerInsightsComponent():DatabaseComponent{
 return {name:'customer_insights',sql:customerInsightsSchema,migrate:async()=>{throw Error('customer_insights_owner_migration_required')}};
}
export function customerInsightsRuntimeAcl(role:string){
 if(!/^[a-z][a-z0-9_]{0,62}$/.test(role))throw Error('customer_insights_runtime_role_invalid');
 const mutable=['settings','profiles','summaries','jobs','budget','intake','sources'],immutable=['events','processed_events','audit'];
 return [...mutable,...immutable].map(name=>`REVOKE ALL ON public.customer_insight_${name} FROM PUBLIC,"${role}";
 GRANT ${mutable.includes(name)?'SELECT,INSERT,UPDATE':'SELECT,INSERT'} ON public.customer_insight_${name} TO "${role}";`).join('\n')+
 `\nREVOKE ALL ON FUNCTION public.guard_customer_insight_records() FROM "${role}";
 GRANT EXECUTE ON FUNCTION public.guard_customer_insight_records() TO "${role}";`;
}
