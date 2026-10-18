const DAY=86_400_000;
/** Version 1: time eligibility starts at payment, deductions are frozen at request. */
export function quoteRefund(amount:number,paidAt:Date,periodStart:Date,periodEnd:Date,requestedAt=new Date()) {
  const elapsed=requestedAt.getTime()-paidAt.getTime();
  const totalDays=Math.round((periodEnd.getTime()-periodStart.getTime())/DAY);
  if(!Number.isSafeInteger(amount)||amount<=0||!Number.isFinite(elapsed)||elapsed<0||!Number.isInteger(totalDays)||totalDays<=0)throw new Error('invalid_refund_facts');
  if(elapsed>168*3_600_000)throw new Error('refund_window_expired');
  const usedDays=Math.min(totalDays,Math.max(0,Math.ceil((requestedAt.getTime()-periodStart.getTime())/DAY)));
  // Round each deduction once to the nearest fen. Never round the daily rate first.
  const fee=Math.round(amount/100);
  const usage=elapsed<=24*3_600_000?0:Math.round(amount*usedDays/totalDays);
  const refund=Math.max(0,amount-fee-usage);
  if(refund<=0)throw new Error('no_refundable_amount');
  return {policy_version:1,original_minor:amount,fee_minor:fee,usage_minor:usage,used_days:usedDays,total_days:totalDays,amount_minor:refund,requested_at:requestedAt.toISOString()};
}
