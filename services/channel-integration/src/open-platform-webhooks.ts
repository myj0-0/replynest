import { postPublicWebhook } from './public-webhook-transport.js';
import { pool } from './database.js';
import { decryptWebhookSecret } from './notification-webhook-crypto.js';
import { validateWebhookEndpoint } from './notification-webhook-adapter.js';
import { webhookSignature } from './open-platform-core.js';
import {claimExternalWebhook,externalWebhookClaimActive,finishExternalWebhook} from './external-webhook-store.js';
import type {Pool} from 'pg';

export async function deliverAppWebhook(endpoint:string,secret:string,body:string,eventId:string){
  const url=validateWebhookEndpoint('custom',endpoint);
  const timestamp=String(Math.floor(Date.now()/1000));
  await postPublicWebhook(url,body,{'content-type':'application/json','x-replynest-event-id':eventId,
    'x-replynest-timestamp':timestamp,'x-replynest-signature':webhookSignature(secret,timestamp,body)},false);
}
export function createExternalWebhookProcessor(db:Pick<Pool,'connect'|'query'>=pool,deliver=deliverAppWebhook){
 let running=false;
 return async function process(){
  if(running)return;
  running=true;
  try{
    for(let i=0;i<5;i++){
      const claim=await claimExternalWebhook(db);
      if(!claim)break;
      if(claim==='terminal')continue;
      // Both the claim transaction and the preflight pool query have released
      // their connection before any decryption or external network operation.
      let succeeded=false;
      if(await externalWebhookClaimActive(db,claim)){
       try{await deliver(decryptWebhookSecret(claim.urlCipher),decryptWebhookSecret(claim.secretCipher),
        JSON.stringify(claim.payload),claim.event);succeeded=true;}
       catch{/* Never log URLs, signatures, plaintext credentials or payload. */}
      }
      await finishExternalWebhook(db,claim,succeeded);
    }
  }finally{running=false;}
 };
}
const defaultProcessor=createExternalWebhookProcessor();
export async function processExternalWebhooks(){
 if(process.env.OPEN_PLATFORM_ENABLED==='true')await defaultProcessor();
}
