import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { PublicWebhookDependencies } from './public-webhook-transport.js';

/** Synthetic transport: never opens a socket. */
export function fakeWebhookResponse(status=200,body='{}',check?:(options:any)=>void,headers:Record<string,string>={}):PublicWebhookDependencies{
  return {resolve4:async()=>['8.8.8.8'],request:((_url:any,options:any,callback:any)=>{
    check?.(options);
    const req=new EventEmitter() as any;
    req.destroy=()=>req.emit('close');
    req.end=()=>queueMicrotask(()=>{
      const response=new PassThrough() as any;response.statusCode=status;response.headers=headers;
      callback(response);response.end(body);
    });
    return req;
  }) as never};
}
