import 'server-only';
import {headers as incomingHeaders} from 'next/headers';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {isIP} from 'node:net';
/** Only the server builds the context. Never forwards cookies, referrer, a full
 * header map, query strings or bodies into the activity envelope. */
export async function activityGatewayFetch(target:string,init:RequestInit={}){
 if(process.env.TENANT_SECURITY_LOGS_ENABLED!=='true')return fetch(target,init);
 const configured=process.env.GATEWAY_INTERNAL_URL;if(!configured||new URL(target).origin!==new URL(configured).origin)throw Error('activity_gateway_target_mismatch');
 const file=process.env.CONSOLE_ACTIVITY_SIGNING_KEY_FILE;
 const key=file?readFileSync(file,'utf8').trim():process.env.CONSOLE_ACTIVITY_SIGNING_KEY;
 if(!key||key.length<32)throw Error('activity_signing_key_missing');
 const trusted=process.env.CONSOLE_ACTIVITY_CLIENT_IP_HEADER??'';
 const source=await incomingHeaders();
 const candidate=trusted==='x-replynest-client-ip'?source.get('x-replynest-client-ip')?.trim():trusted==='x-real-ip'?source.get('x-real-ip')?.trim():trusted==='x-forwarded-for-last'?source.get('x-forwarded-for')?.split(',').at(-1)?.trim():'';
 const ip=candidate&&isIP(candidate)?candidate:null;
 const ua=(source.get('user-agent')??'').replace(/[\x00-\x1f\x7f]/g,'').slice(0,512);
 const payload=Buffer.from(JSON.stringify({v:1,ts:Date.now(),nonce:randomUUID(),ip,ua})).toString('base64url');
 const headers=new Headers(init.headers),method=(init.method??'GET').toUpperCase();
 const binding=`${method}\n${new URL(target).pathname}\n${createHash('sha256').update(headers.get('authorization')??'').digest('hex')}\n${payload}`;
 headers.set('x-replynest-activity',payload);headers.set('x-replynest-activity-signature',createHmac('sha256',key).update(binding).digest('hex'));
 return fetch(target,{...init,headers});
}
