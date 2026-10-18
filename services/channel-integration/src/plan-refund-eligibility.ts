import {quoteRefund} from './refund-policy.js';
import {splitRefund} from './wallet-core.js';

// A purchase-specific preview, never a promise that a later approval will succeed.
// Use the same database instant as the listing query; do not trust the browser clock.
export function planRefundEligibility(p:any,now:Date){
 const unavailable=(code:string)=>({can_refund:false,refund_unavailable_reason:code,refund_preview:null});
 if(p.refund_status)return unavailable('refund_already_requested');
 if(p.subscription_status!=='active'||!p.subscription_period_end||
  +new Date(p.subscription_period_end)!==+new Date(p.period_end))return unavailable('refund_term_requires_review');
 try{
  const q=quoteRefund(Number(p.amount_minor),new Date(p.created_at),new Date(p.period_start),new Date(p.period_end),now);
  return {can_refund:true,refund_unavailable_reason:null,refund_preview:{...q,...splitRefund(q.amount_minor,Number(p.gift_minor),Number(p.cash_minor))}};
 }catch(e){return unavailable(e instanceof Error?e.message:'invalid_refund_facts');}
}
