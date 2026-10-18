/** Startup-only configuration; errors never include secret values, paths or URLs. */
export type AutomaticReceptionConfig=Readonly<{
 management:boolean;senderManagement?:boolean;web:boolean;wechatManagement:boolean;wechat:boolean;wechatHistory:boolean;draftCallback:boolean;callback:boolean;timing?:boolean;closedCallbackAck?:boolean;
 bridgeSecret:string;nativeSecret:string;origin:string;token:string;
}>;
const flag=(env:NodeJS.ProcessEnv,name:string)=>{
 const v=env[name];if(v===undefined||v===''||v==='false')return false;
 if(v==='true')return true;throw Error('automatic_reception_flag_invalid');
};
const validKey=(v:string|undefined)=>!!v&&Buffer.byteLength(v)>=32&&Buffer.byteLength(v)<=65536&&!/[\0\r\n]/.test(v);
export function automaticManagementEnabled(){return process.env.AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED==='true';}
export function automaticWebEnabled(){return automaticManagementEnabled()&&process.env.AI_RECEPTION_AUTOMATIC_WEB_ENABLED==='true'&&process.env.AI_RECEPTION_EVENT_CALLBACK_ENABLED==='true'&&process.env.AI_POINTS_ENABLED==='true';}
export function validateAutomaticReceptionStartup(env:NodeJS.ProcessEnv,secret:(name:string)=>string|undefined,modelConfigured:()=>void):AutomaticReceptionConfig{
 const management=flag(env,'AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED'),web=flag(env,'AI_RECEPTION_AUTOMATIC_WEB_ENABLED');
 const senderManagement=flag(env,'AI_RECEPTION_SENDER_MANAGEMENT_ENABLED');
 const wechatManagement=flag(env,'AI_RECEPTION_AUTOMATIC_WECHAT_MANAGEMENT_ENABLED'),wechat=flag(env,'AI_RECEPTION_AUTOMATIC_WECHAT_ENABLED');
 const wechatHistory=flag(env,'AI_RECEPTION_WECHAT_HISTORY_ENABLED');
 const timing=flag(env,'AI_RECEPTION_REPLY_TIMING_ENABLED');
 const eventCallback=flag(env,'AI_RECEPTION_EVENT_CALLBACK_ENABLED');
 // Transport acknowledgement is NOT execution permission. Explicitly opt in
 // to authenticated discard while closed; never resolve secrets by default.
 const closedCallbackAck=flag(env,'AI_RECEPTION_CLOSED_CALLBACK_ACK_ENABLED');
 const draftCallback=flag(env,'AI_RECEPTION_DRAFT_WORKER_ENABLED')&&eventCallback;
 const points=flag(env,'AI_POINTS_ENABLED'),verifiedIngress=flag(env,'WECHAT_VERIFIED_INGRESS_ENABLED');
 if((senderManagement&&(!management||env.DATABASE_STARTUP_MODE!=='verify'))||
  (web&&(!management||!eventCallback||!points))||
  (wechatManagement&&(!management||env.DATABASE_STARTUP_MODE!=='verify'))||
  (wechat&&(!wechatManagement||!points||!verifiedIngress))||
  (wechatHistory&&!wechatManagement))throw Error('automatic_reception_dependencies_required');
 if(timing&&(!(web||wechat)||!points||env.AI_RECEPTION_AUTOMATIC_PRESENTATION_ENABLED!=='true'||
  env.AI_RECEPTION_PERSONALIZATION_MANAGEMENT_ENABLED!=='true'||env.AI_RECEPTION_SEMANTIC_ANSWERS_ENABLED!=='true'||env.DATABASE_STARTUP_MODE!=='verify'))
  throw Error('automatic_reply_timing_dependencies_required');
 const studioEvents=flag(env,'STUDIO_MESSAGE_EVENTS_ENABLED');
 if(studioEvents&&(!eventCallback||env.EXTENSION_BUILDER_ENABLED!=='true'||env.AUTOMATION_PLANNING_ENABLED!=='true'||env.AUTOMATION_ASSIGNMENT_ENABLED!=='true'))throw Error('studio_message_dependencies_required');
 const callback=web||draftCallback||studioEvents;
 const base={management,senderManagement,web,wechatManagement,wechat,wechatHistory,draftCallback,callback,timing,closedCallbackAck};
 if(!callback&&!closedCallbackAck&&!wechat&&!wechatHistory&&!senderManagement)return Object.freeze({...base,bridgeSecret:'',nativeSecret:'',origin:'',token:''});
 try{
  const bridgeSecret=callback||closedCallbackAck?secret('CHATWOOT_CALLBACK_SECRET'):'';if((callback||closedCallbackAck)&&!validKey(bridgeSecret))throw Error();
  if(!web&&!wechat&&!wechatHistory&&!senderManagement)return Object.freeze({...base,bridgeSecret:bridgeSecret!,nativeSecret:'',origin:'',token:''});
  const nativeSecret=secret('REPLYNEST_AUTOMATIC_REPLY_SECRET'),token=web?secret('CHATWOOT_API_ACCESS_TOKEN'):'';
  if(!validKey(nativeSecret)||nativeSecret===bridgeSecret||(web&&(!token||token.length>65536||/[\0\r\n]/.test(token))))throw Error();
  const origin=new URL(env.CHATWOOT_BASE_URL??'');
  if(!['https:','http:'].includes(origin.protocol)||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)throw Error();
  if(web||wechat)modelConfigured();
  return Object.freeze({...base,bridgeSecret:bridgeSecret!,nativeSecret:nativeSecret!,origin:origin.origin,token:token!});
 }catch{throw Error('automatic_reception_configuration_invalid');}
}
