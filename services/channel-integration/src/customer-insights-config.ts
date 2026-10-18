/** Startup-only configuration for the independently consented purpose. No
 * secrets are read when disabled; errors never disclose secret/path values. */
export type CustomerInsightsConfig=Readonly<{enabled:boolean;shared:boolean;origin:string;secret:string;bridgeSecret:string;token:string}>;
export function validateCustomerInsightsStartup(env:NodeJS.ProcessEnv,secret:(name:string)=>string|undefined,modelConfigured:()=>void):CustomerInsightsConfig{
 const v=env.AI_CUSTOMER_INSIGHTS_ENABLED;
 if(v!==undefined&&v!==''&&v!=='false'&&v!=='true')throw Error('customer_insights_flag_invalid');
 if(v!=='true')return Object.freeze({enabled:false,shared:false,origin:'',secret:'',bridgeSecret:'',token:''});
 if(env.DATABASE_STARTUP_MODE!=='verify'||env.AI_POINTS_ENABLED!=='true'||env.AI_RECEPTION_EVENT_CALLBACK_ENABLED!=='true')throw Error('customer_insights_dependencies_required');
 const shared=env.SHARED_WECHAT_DELIVERY_ENABLED==='true';
 if(shared&&env.WECHAT_VERIFIED_INGRESS_ENABLED!=='true')throw Error('customer_insights_shared_ingress_required');
 try{
  const key=secret('REPLYNEST_AUTOMATIC_REPLY_SECRET'),bridgeSecret=secret('CHATWOOT_CALLBACK_SECRET'),token=secret('CHATWOOT_API_ACCESS_TOKEN'),origin=new URL(env.CHATWOOT_BASE_URL??'');
  const valid=(s:string|undefined)=>!!s&&Buffer.byteLength(s)>=32&&Buffer.byteLength(s)<=65536&&!/[\0\r\n]/.test(s);
  if(!valid(key)||!valid(bridgeSecret)||key===bridgeSecret||!token||token.length>65536||/[\0\r\n]/.test(token)||
   !['http:','https:'].includes(origin.protocol)||origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash)throw Error();
  modelConfigured();return Object.freeze({enabled:true,shared,origin:origin.origin,secret:key!,bridgeSecret:bridgeSecret!,token});
 }catch{throw Error('customer_insights_configuration_invalid');}
}
