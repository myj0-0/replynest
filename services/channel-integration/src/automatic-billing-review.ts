/** Read-only interpretation of immutable generation and point-ledger facts.
 * No release, settlement, retry or inferred provider usage is performed here.
 */
export type AutomaticBillingReview='not_requested'|'charged'|'held'|'released'|'not_charged'|'provider_cost_unknown'|'billing_unconfirmed';
export function automaticBillingReview(facts:{generation_state:string|null;generation_attempted:boolean;
 billing_state:string|null;billing_error:string|null;charged_micros:string|null;held_micros:string|null}):AutomaticBillingReview{
 const {generation_state:g,billing_state:b,billing_error:error,charged_micros:charged,held_micros:held}=facts;
 const amount=(value:string|null)=>typeof value==='string'&&/^\d{1,19}$/.test(value)&&BigInt(value)<=9223372036854775807n;
 if(b===null)return g===null?'not_requested':'billing_unconfirmed';
 if(!amount(charged)||!amount(held))return 'billing_unconfirmed';
 if(b==='succeeded')return held==='0'?'charged':'billing_unconfirmed';
 if(charged!=='0')return 'billing_unconfirmed';
 if(b==='reserved')return 'held';
 if(held!=='0')return 'billing_unconfirmed';
 if(b==='failed')return ['automatic_provider_cost_unknown','automatic_embedding_cost_unknown','automatic_verifier_cost_unknown'].includes(error??'')?'provider_cost_unknown':'not_charged';
 if(b==='abandoned')return facts.generation_attempted?'provider_cost_unknown':'released';
 return 'billing_unconfirmed';
}
