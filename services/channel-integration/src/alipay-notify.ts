import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AlipayConfig,AlipayVerifiedPayment} from './alipay-provider.js';
import {verifyAlipayPayment} from './alipay-provider.js';

export async function handleAlipayNotify(req:IncomingMessage,res:ServerResponse,url:URL,deps:{enabled:boolean;config:()=>AlipayConfig;record:(payment:AlipayVerifiedPayment)=>Promise<void>}) {
  if(url.pathname!=='/webhooks/alipay')return false;
  const finish=(status:number,text:string)=>{res.writeHead(status,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});res.end(text);return true;};
  if(!deps.enabled)return finish(404,'failure');
  if(req.method!=='POST')return finish(405,'failure');
  if(!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(req.headers['content-type']??''))return finish(415,'failure');
  try {
    const chunks:Buffer[]=[];let size=0;
    for await(const value of req){const chunk=Buffer.from(value);size+=chunk.length;if(size>65536)return finish(413,'failure');chunks.push(chunk);}
    const payment=verifyAlipayPayment(deps.config(),Buffer.concat(chunks));
    if(payment)await deps.record(payment);
    // Acknowledge only after the payment event transaction has committed.
    return finish(200,'success');
  }catch{return finish(400,'failure');}
}
