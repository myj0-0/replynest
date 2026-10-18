import pg,{type PoolClient,type PoolConfig} from 'pg';

export class DatabaseBusyError extends Error {
 readonly code='database_busy';
 constructor(){super('Database temporarily busy');this.name='DatabaseBusyError';}
}
type Callback=(error:Error|undefined,client:PoolClient|undefined,done:(release?:any)=>void)=>void;
// Keep pg's native timeout/removal logic: no Promise.race that leaks a late client.
export class BoundedPool extends pg.Pool {
 readonly maxWaiting:number;
 readonly pressure={rejected:0,timeouts:0};
 constructor(config:PoolConfig,maxWaiting=40){
  super({...config,connectionTimeoutMillis:config.connectionTimeoutMillis??1500});
  if(!Number.isInteger(maxWaiting)||maxWaiting<1)throw Error('invalid_pool_wait_limit');
  this.maxWaiting=maxWaiting;
 }
 connect():Promise<PoolClient>;
 connect(callback:Callback):void;
 connect(callback?:Callback):Promise<PoolClient>|void{
  if(!callback)return new Promise((resolve,reject)=>this.connect((error,client)=>error?reject(error):resolve(client!)));
  if(this.waitingCount>=this.maxWaiting){
   this.pressure.rejected++;queueMicrotask(()=>callback(new DatabaseBusyError(),undefined,()=>{}));return;
  }
  super.connect((error,client,done)=>{
   if(error&&['timeout exceeded when trying to connect','Connection terminated due to connection timeout'].includes(error.message)){
    this.pressure.timeouts++;callback(new DatabaseBusyError(),undefined,done);return;
   }
   callback(error,client,done);
  });
 }
}
