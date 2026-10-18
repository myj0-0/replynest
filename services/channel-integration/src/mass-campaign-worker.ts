/** Separate send and receipt switches: stopping sends must not prevent receipt reconciliation. */
export function createMassPollers(deps:{send:()=>Promise<unknown>;receipt:()=>Promise<unknown>},env:NodeJS.ProcessEnv=process.env){
 let sending=false,querying=false;
 return {
  async send(){
   if(sending||env.MASS_CAMPAIGN_WORKER_ENABLED!=='true'||env.MESSAGE_CAMPAIGN_EXECUTION_ENABLED!=='true'||env.MESSAGE_CAMPAIGN_PROVIDER!=='wechat_mass')return;
   sending=true;try{await deps.send();}finally{sending=false;}
  },
  async receipt(){
   if(querying||env.MASS_CAMPAIGN_RECEIPT_WORKER_ENABLED!=='true')return;
   querying=true;try{await deps.receipt();}finally{querying=false;}
  }
 };
}
