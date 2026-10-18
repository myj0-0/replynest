import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {secretValue} from './secret-value.js';
import {marketText,TemplateMarketError} from './template-market-core.js';
export type MarketPayee={subject_type:'business'|'individual';name:string;account:string};
export type PayeeEnvelope={version:1;iv:string;tag:string;ciphertext:string};
function key(){const raw=secretValue('MARKET_PAYEE_MASTER_KEY');if(!raw||!/^[a-f0-9]{64}$/i.test(raw))throw new TemplateMarketError('market_payee_key_unavailable');return Buffer.from(raw,'hex');}
export function parseMarketPayee(raw:Record<string,unknown>):MarketPayee{
 if(!['business','individual'].includes(String(raw.subject_type)))throw new TemplateMarketError('invalid_payee_subject');
 const name=marketText(raw.name,2,120),account=marketText(raw.account,5,160);
 if(!/^(?:1[3-9]\d{9}|[^\s@]+@[^\s@]+\.[^\s@]+)$/.test(account))throw new TemplateMarketError('invalid_payee_account');
 return {subject_type:raw.subject_type as MarketPayee['subject_type'],name,account};
}
export function sealMarketPayee(value:MarketPayee,tenant:string,id:string):PayeeEnvelope{
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(),iv);
 cipher.setAAD(Buffer.from(`replynest:market-payee:v1:${tenant}:${id}`));
 return {version:1,iv:iv.toString('base64url'),ciphertext:Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]).toString('base64url'),tag:cipher.getAuthTag().toString('base64url')};
}
export function openMarketPayee(value:PayeeEnvelope,tenant:string,id:string):MarketPayee{
 if(value.version!==1)throw new TemplateMarketError('market_payee_invalid_envelope');
 const iv=Buffer.from(value.iv,'base64url'),tag=Buffer.from(value.tag,'base64url'),body=Buffer.from(value.ciphertext,'base64url');
 if(iv.length!==12||tag.length!==16||body.length>4096)throw new TemplateMarketError('market_payee_invalid_envelope');
 const cipher=createDecipheriv('aes-256-gcm',key(),iv);cipher.setAAD(Buffer.from(`replynest:market-payee:v1:${tenant}:${id}`));cipher.setAuthTag(tag);
 return parseMarketPayee(JSON.parse(Buffer.concat([cipher.update(body),cipher.final()]).toString('utf8')));
}
