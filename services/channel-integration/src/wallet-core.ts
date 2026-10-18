/** All amounts are integer fen. Financial policy v2 never converts gifts to cash. */
export class WalletError extends Error { constructor(public code:string, public status=409){super(code);} }
export function minor(value:unknown, positive=false):number {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<(positive?1:0))throw new WalletError('invalid_amount',400);
  return value;
}
export function parseYuan(value:unknown):number {
  if(typeof value!=='string'||!/^\d{1,7}(\.\d{1,2})?$/.test(value))throw new WalletError('invalid_amount',400);
  const [whole,fraction='']=value.split('.');return minor(Number(whole)*100+Number(fraction.padEnd(2,'0')),true);
}
export function feeQuote(amount:number) {
  minor(amount,true);const fee=Number((BigInt(amount)+50n)/100n);
  return {amount_minor:amount,fee_minor:fee,net_minor:amount-fee,policy_version:2};
}
export function allocatePayment(amount:number,gift:number,cash:number) {
  minor(amount,true);minor(gift);minor(cash);
  const gift_minor=Math.min(amount,gift),cash_minor=amount-gift_minor;
  if(cash_minor>cash)throw new WalletError('insufficient_balance');
  return {gift_minor,cash_minor};
}
export function splitRefund(refund:number,gift:number,cash:number) {
  minor(refund);minor(gift);minor(cash);const total=gift+cash;minor(total,true);
  if(refund>total)throw new WalletError('invalid_refund',400);
  // Round the cash share down; the remainder stays non-withdrawable gift.
  const cash_minor=Number(BigInt(refund)*BigInt(cash)/BigInt(total));
  return {cash_minor,gift_minor:refund-cash_minor};
}
export type GiftLot={entry_id:string;amount_minor:number;expires_at:string|null};
export function giftLots(entries:{entry_id:string;transaction_id?:string;reversal_of?:string|null;direction:string;amount_minor:string;expires_at:Date|string|null;posted_at:Date|string;transaction_type:string;metadata?:any}[],now:Date,allowDebt=false):GiftLot[]{
  const lots:GiftLot[]=[];let debt=0;
  for(const e of entries){
    const amount=minor(Number(e.amount_minor),true);
    if(e.reversal_of){
      // Historical trial expiry reverses its original grant, even after expiry.
      // Never apply that reversal to unrelated, newly granted active credits.
      if(e.direction!=='debit')throw new WalletError('gift_ledger_requires_review');
      let remaining=amount;
      for(const original of entries.filter(o=>o.transaction_id===e.reversal_of&&o.direction==='credit')){
        const lot=lots.find(l=>l.entry_id===original.entry_id);if(!lot)throw new WalletError('gift_ledger_requires_review');
        const used=Math.min(remaining,lot.amount_minor);lot.amount_minor-=used;remaining-=used;
      }
      if(remaining){if(!allowDebt)throw new WalletError('gift_ledger_requires_review');debt+=remaining;}
      continue;
    }
    if(e.direction==='credit'){const recovered=Math.min(debt,amount);debt-=recovered;lots.push({entry_id:e.entry_id,amount_minor:amount-recovered,expires_at:e.expires_at?new Date(e.expires_at).toISOString():null});continue;}
    let remaining=amount;
    const explicit=e.metadata?.gift_allocations;
    if(Array.isArray(explicit))for(const part of explicit){const lot=lots.find(l=>l.entry_id===part.entry_id);if(!lot||!Number.isSafeInteger(part.amount_minor)||part.amount_minor<0||part.amount_minor>lot.amount_minor||part.amount_minor>remaining)throw new WalletError('gift_ledger_requires_review');lot.amount_minor-=part.amount_minor;remaining-=part.amount_minor;}
    // Legacy debits have no lot reference. Consume earliest-expiring credits first.
    if(!explicit)for(const lot of [...lots].filter(l=>!l.expires_at||new Date(l.expires_at)>new Date(e.posted_at)).sort((a,b)=>(a.expires_at??'9999').localeCompare(b.expires_at??'9999'))){const used=Math.min(lot.amount_minor,remaining);lot.amount_minor-=used;remaining-=used;if(!remaining)break;}
    if(remaining){if(!allowDebt)throw new WalletError('gift_ledger_requires_review');debt+=remaining;}
  }
  return lots.filter(l=>l.amount_minor>0&&(!l.expires_at||new Date(l.expires_at)>now)).sort((a,b)=>(a.expires_at??'9999').localeCompare(b.expires_at??'9999'));
}
export function takeGifts(lots:GiftLot[],amount:number):GiftLot[]{
  minor(amount);let remaining=amount;const result:GiftLot[]=[];
  for(const lot of lots){const take=Math.min(remaining,lot.amount_minor);if(take)result.push({...lot,amount_minor:take});remaining-=take;if(!remaining)break;}
  if(remaining||result.length>16)throw new WalletError('gift_ledger_requires_review');return result;
}
