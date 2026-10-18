import type {PoolClient} from 'pg';
import type {DatabaseComponent} from './database-runtime.js';

export type PublicAiLabelView={revision:string;override:boolean|null;platformDefault:boolean;effective:boolean};
/** Presentation only: never changes bot identity, provenance, consent or send guards. */
export function publicAiLabelDefault(env:NodeJS.ProcessEnv=process.env):boolean {
 const value=env.AI_PUBLIC_LABEL_DEFAULT;
 if(value===undefined||value===''||value==='false')return false;
 if(value==='true')return true;
 throw Error('invalid_ai_public_label_default');
}
export function parsePublicAiLabel(row:any,platformDefault:boolean):PublicAiLabelView {
 if(!row)return {revision:'0',override:null,platformDefault,effective:platformDefault};
 if(typeof row.revision!=='string'||! /^[1-9]\d{0,18}$/.test(row.revision)||BigInt(row.revision)>=9223372036854775807n||
  row.enabled!==null&&typeof row.enabled!=='boolean')throw Error('ai_public_label_state_uncertain');
 return {revision:row.revision,override:row.enabled,platformDefault,effective:row.enabled??platformDefault};
}
export async function readPublicAiLabel(db:Pick<PoolClient,'query'>,tenant:string,env:NodeJS.ProcessEnv=process.env):Promise<PublicAiLabelView>{
 if(!tenant||tenant.length>200)throw Error('invalid_ai_public_label_tenant');
 const platformDefault=publicAiLabelDefault(env);
 if(env.AI_PUBLIC_LABEL_SETTINGS_ENABLED!=='true')return parsePublicAiLabel(null,platformDefault);
 const result=await db.query('SELECT revision::text,enabled FROM ai_public_label_settings WHERE tenant_id=$1',[tenant]);
 return parsePublicAiLabel(result.rows[0],platformDefault);
}
export const publicAiLabelSchema=`
 CREATE TABLE ai_public_label_settings(
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(tenant_id),
  revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),enabled BOOLEAN,
  actor_id UUID NOT NULL REFERENCES platform_users(platform_user_id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
 );
 CREATE FUNCTION guard_ai_public_label_revision() RETURNS trigger AS $$
 BEGIN
  IF TG_OP='INSERT' THEN
   IF NEW.revision<>1 THEN RAISE EXCEPTION 'initial revision must be one'; END IF;
  ELSE
   IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.revision IS DISTINCT FROM OLD.revision THEN
    RAISE EXCEPTION 'identity and revision are server controlled'; END IF;
   NEW.revision:=OLD.revision+1;
  END IF;
  RETURN NEW;
 END; $$ LANGUAGE plpgsql;
 CREATE TRIGGER ai_public_label_revision BEFORE INSERT OR UPDATE ON ai_public_label_settings
  FOR EACH ROW EXECUTE FUNCTION guard_ai_public_label_revision();
`;
export function publicAiLabelDatabaseComponent():DatabaseComponent {
 return {name:'ai_public_label',sql:publicAiLabelSchema,migrate:async()=>{throw Error('ai_public_label_owner_migration_required');}};
}
export function publicAiLabelRuntimeAcl(runtime:string):string {
 if(!/^[a-z][a-z0-9_]{0,62}$/.test(runtime))throw Error('invalid_ai_public_label_runtime');
 return `REVOKE ALL ON TABLE public.ai_public_label_settings FROM PUBLIC,"${runtime}";
 GRANT SELECT,INSERT,UPDATE ON TABLE public.ai_public_label_settings TO "${runtime}";
 REVOKE ALL ON FUNCTION public.guard_ai_public_label_revision() FROM PUBLIC,"${runtime}";
 GRANT EXECUTE ON FUNCTION public.guard_ai_public_label_revision() TO "${runtime}";`;
}
