/** Trusted server transport bound. Covers the whole operation, not just fetch.
 * The shorter test deadline is not a tenant/model-selectable setting. */
export async function withHistoryModelDeadline<T>(run:(signal:AbortSignal)=>Promise<T>,milliseconds=25000):Promise<T>{
 if(!Number.isInteger(milliseconds)||milliseconds<1||milliseconds>25000)throw Error('invalid_history_model_deadline');
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('history_provider_deadline'));},milliseconds);});
 try{return await Promise.race([Promise.resolve().then(()=>run(controller.signal)),deadline]);}finally{if(timer)clearTimeout(timer);}
}
