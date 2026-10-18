import {randomUUID} from 'node:crypto';
import {aiPointsEnabled,reserveAiPoints,settleAiPoints} from './ai-points.js';
import type {AiUsage} from './ai-points-core.js';
export async function meteredAi<T extends {usage:AiUsage}>(tenant:string,feature:'copilot'|'studio'|'embedding_query'|'embedding_document',input:string,maxOutput:number,run:()=>Promise<T>):Promise<T>{
 if(!aiPointsEnabled())return run();
 // UTF-8 bytes plus a fixed message/format overhead is a deliberately conservative bound.
 const call=await reserveAiPoints(tenant,randomUUID(),feature,Buffer.byteLength(input)+4096,maxOutput);
 try{const result=await run();await settleAiPoints(tenant,call,result.usage,true);return result;}
 catch(e){await settleAiPoints(tenant,call,(e as {usage?:AiUsage})?.usage,false,e instanceof Error&&/^[a-z_]{1,80}$/.test(e.message)?e.message:'ai_operation_failed');throw e;}
}
