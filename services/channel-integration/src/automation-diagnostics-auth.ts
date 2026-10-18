import {timingSafeEqual} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {sendJson} from './shared.js';
import type {createRuntimeMonitor} from './automation-runtime-health.js';

// Same pre-existing monitor control credential, never tenant/admin credentials.
export function automationDiagnosticsAuthorized(header:unknown,secret:string|undefined):boolean{
 if(!secret||secret.length<32||secret.length>512||typeof header!=='string'||header.length>520)return false;
 const expected=Buffer.from(`Bearer ${secret}`),actual=Buffer.from(header);
 return expected.length===actual.length&&timingSafeEqual(expected,actual);
}

export function handleAutomationHealth(request:IncomingMessage,response:ServerResponse,url:URL,monitor:ReturnType<typeof createRuntimeMonitor>,secret:string|undefined):boolean{
 if(url.pathname==='/health/automation'&&url.searchParams.get('diagnostics')==='1'){
  response.setHeader('Cache-Control','no-store');
  if(request.method!=='GET'||!automationDiagnosticsAuthorized(request.headers.authorization,secret)){sendJson(response,404,{error:'not_found'});return true;}
  sendJson(response,200,monitor.privateHealth());return true;
 }
 if(request.method==='GET'&&url.pathname==='/health/automation'){
  const health=monitor.publicHealth();response.setHeader('Cache-Control','no-store');sendJson(response,health.status==='operational'?200:503,health);return true;
 }
 return false;
}
