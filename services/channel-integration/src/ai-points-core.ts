/** Integer nanoyuan: one AI point = 0.001 CNY = 1,000,000 nanoyuan.
 * Fractional points are retained. Price versions must be snapshotted per request.
 * List prices are estimates until reconciled against the provider's actual bill. */
export const POINT_NANO_CNY=1_000_000;
export type AiUsage={input_tokens:number;output_tokens:number;cached_input_tokens:number};
export type AiPrice={version:string;model:string;input_nano_cny:number;output_nano_cny:number;cached_input_nano_cny:number};
export const initialAiPrices:Record<'text'|'embedding',AiPrice>={
 text:{version:'qwen-beijing-list-20260926-v1',model:'qwen3.8-flash',input_nano_cny:800,output_nano_cny:2700,cached_input_nano_cny:100},
 embedding:{version:'qwen-beijing-list-20260926-v1',model:'qwen3.7-text-embedding-flash',input_nano_cny:125,output_nano_cny:0,cached_input_nano_cny:125},
};
function integer(n:unknown):number{if(typeof n!=='number'||!Number.isSafeInteger(n)||n<0)throw Error('invalid_ai_usage');return n;}
export function parseAiUsage(raw:any,embedding=false):AiUsage{
 const input_tokens=integer(raw?.prompt_tokens),output_tokens=embedding?0:integer(raw?.completion_tokens);
 const cached_input_tokens=integer(raw?.prompt_tokens_details?.cached_tokens??0);
 if(cached_input_tokens>input_tokens)throw Error('invalid_ai_usage');
 if(raw?.total_tokens!==undefined&&integer(raw.total_tokens)!==input_tokens+output_tokens)throw Error('invalid_ai_usage');
 return {input_tokens,output_tokens,cached_input_tokens};
}
export function priceAiUsage(usage:AiUsage,price:AiPrice){
 const {input_tokens:i,output_tokens:o,cached_input_tokens:c}=usage;
 [i,o,c,price.input_nano_cny,price.output_nano_cny,price.cached_input_nano_cny].forEach(integer);
 if(c>i)throw Error('invalid_ai_usage');
 const nano=BigInt(i-c)*BigInt(price.input_nano_cny)+BigInt(c)*BigInt(price.cached_input_nano_cny)+BigInt(o)*BigInt(price.output_nano_cny);
 if(nano>BigInt(Number.MAX_SAFE_INTEGER))throw Error('ai_cost_overflow');
 return {cost_nano_cny:Number(nano),point_micros:Number(nano),points:Number(nano)/POINT_NANO_CNY};
}
export function quoteAiPack(points:number,priceFen:number){
 integer(points);integer(priceFen);if(!points||!priceFen)throw Error('invalid_ai_pack');
 const cost=BigInt(points)*BigInt(POINT_NANO_CNY),revenue=BigInt(priceFen)*10_000_000n;
 if(cost>BigInt(Number.MAX_SAFE_INTEGER))throw Error('ai_cost_overflow');
 return {points,price_minor:priceFen,model_budget_nano_cny:Number(cost),model_margin_percent:Number(revenue-cost)/Number(revenue)*100};
}
