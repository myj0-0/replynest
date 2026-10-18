import {WalletError,splitRefund,takeGifts,type GiftLot} from './wallet-core.js';
export type PlanValue={purchase_id:string;paid_at:string;original_minor:number;value_minor:number;cash_minor:number;gift_minor:number;gift_allocations:GiftLot[];starts:string;ends:string};
const instant=(s:string)=>{const n=+new Date(s);if(!Number.isSafeInteger(n))throw new WalletError('plan_value_requires_review');return n;};
const valid=(n:number)=>{if(!Number.isSafeInteger(n)||n<0)throw new WalletError('plan_value_requires_review');return n;};
function ratio(n:number,part:number,total:number,ceil=false){valid(n);valid(part);valid(total);if(!total)throw new WalletError('plan_value_requires_review');const raw=BigInt(n)*BigInt(part);const r=Number((raw+(ceil?BigInt(total)-1n:0n))/BigInt(total));return valid(r);}
export function remainingPlanValue(value:PlanValue,at:string):PlanValue{
 const start=instant(value.starts),end=instant(value.ends),now=instant(at);
 if(end<=start||valid(value.value_minor)<1||value.value_minor!==valid(value.cash_minor)+valid(value.gift_minor)||value.value_minor>valid(value.original_minor))throw new WalletError('plan_value_requires_review');
 const remaining=ratio(value.value_minor,Math.max(0,end-Math.max(start,now)),end-start);
 const sources=splitRefund(remaining,value.gift_minor,value.cash_minor);
 return {...value,value_minor:remaining,...sources,gift_allocations:takeGifts(value.gift_allocations,sources.gift_minor),starts:new Date(Math.max(start,now)).toISOString()};
}
export function quotePlanChange(values:PlanValue[],at:string,oldEnd:string,termEnd:string,targetPrice:number,direction:'upgrade'|'downgrade'){
 if(!values.length||values.length>96||new Set(values.map(v=>v.purchase_id)).size!==values.length||targetPrice<1)throw new WalletError('plan_value_requires_review');
 const slices=values.map(v=>remainingPlanValue(v,at)).filter(v=>v.value_minor>0);
 const carry=slices.reduce((n,v)=>valid(n+v.value_minor),0),now=instant(at),duration=instant(termEnd)-now,remaining=instant(oldEnd)-now;
 if(carry<1||duration<1||remaining<1)throw new WalletError('plan_value_requires_review');
 const target=ratio(targetPrice,remaining,duration,true),due=direction==='upgrade'?Math.max(0,target-carry):0;
 // Floor conversion to whole seconds: fractional currency/time never creates value.
 const converted=Number(BigInt(carry)*BigInt(duration)/BigInt(targetPrice)/1000n)*1000;
 if(!Number.isSafeInteger(converted)||converted<1000||converted>3660*86400000)throw new WalletError('plan_conversion_requires_review');
 const end=direction==='upgrade'?oldEnd:new Date(now+converted).toISOString();
 return {version:1 as const,direction,valuation_at:at,carry_minor:carry,due_minor:due,target_term_minor:targetPrice,target_term_end:termEnd,period_end:end,
  values:slices.map(v=>({...v,starts:at,ends:end}))};
}
export function quoteChangedPlanRefund(values:PlanValue[],at:string){
 const now=instant(at);let fee=0,net=0,cash=0,gift=0;const allocations:GiftLot[]=[],origins=[];
 const original=values.reduce((n,v)=>valid(n+v.value_minor),0);
 for(const v of values){
  const elapsed=now-instant(v.paid_at);if(elapsed<0)throw new WalletError('plan_value_requires_review');
  // Mixed old/new purchases require review rather than silently forfeiting old value.
  if(elapsed>168*3600000)throw new WalletError('refund_window_expired');
  const current=remainingPlanValue(v,at),days=Math.ceil(Math.max(0,now-instant(v.starts))/86400000),total=(instant(v.ends)-instant(v.starts))/86400000;
  const gross=elapsed<=24*3600000?v.value_minor:Math.min(current.value_minor,Math.max(0,v.value_minor-Math.round(v.value_minor*Math.min(days,total)/total)));
  const deduction=Math.min(gross,Math.round(v.original_minor/100)),amount=gross-deduction;
  const sources=splitRefund(amount,v.gift_minor,v.cash_minor);
  allocations.push(...takeGifts(v.gift_allocations,sources.gift_minor));cash=valid(cash+sources.cash_minor);gift=valid(gift+sources.gift_minor);net=valid(net+amount);fee=valid(fee+deduction);
  origins.push({purchase_id:v.purchase_id,original_minor:v.original_minor,retained_service_minor:v.original_minor-gross});
 }
 if(net<1)throw new WalletError('no_refundable_amount');
 if(allocations.length>16)throw new WalletError('gift_ledger_requires_review');
 return {policy_version:3,original_minor:original,amount_minor:net,net_minor:net,cash_minor:cash,gift_minor:gift,gift_allocations:allocations,fee_minor:fee,usage_minor:original-net-fee,refund_origins:origins,requested_at:at};
}
