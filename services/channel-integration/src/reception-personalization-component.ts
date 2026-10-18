import type {DatabaseComponent} from './database-runtime.js';
import {receptionPersonalizationSchema} from './reception-personalization.js';
export const RECEPTION_PERSONALIZATION_COMPONENT='reception_personalization';
export function receptionPersonalizationDatabaseComponent():DatabaseComponent {
 return {name:RECEPTION_PERSONALIZATION_COMPONENT,sql:receptionPersonalizationSchema,migrate:async()=>{throw Error('personalization_owner_migration_required');}};
}
/** Install only in a dedicated, reviewed owner migration; runtime never does DDL. */
export function receptionPersonalizationRuntimeAcl(runtime:string){
 if(!/^[a-z][a-z0-9_]{0,62}$/.test(runtime))throw Error('invalid_personalization_runtime_role');
 return ['reception_personalization_settings','reception_history_grants','reception_personalization_rate','reception_learned_styles'].map(table=>
  `REVOKE ALL ON TABLE public.${table} FROM PUBLIC, "${runtime}"; GRANT SELECT,INSERT,UPDATE ON TABLE public.${table} TO "${runtime}";`).join('\n')+
  `\nREVOKE ALL ON TABLE public.reception_personalization_audit FROM PUBLIC, "${runtime}";
   GRANT SELECT,INSERT ON TABLE public.reception_personalization_audit TO "${runtime}";\n`+
  ['guard_reception_personalization_revision','guard_reception_personalization_audit'].map(fn=>
   `REVOKE ALL ON FUNCTION public.${fn}() FROM PUBLIC, "${runtime}"; GRANT EXECUTE ON FUNCTION public.${fn}() TO "${runtime}";`).join('\n');
}
