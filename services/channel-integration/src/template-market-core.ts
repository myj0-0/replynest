import {validateDefinition} from './extension-core.js';
export class TemplateMarketError extends Error {}
export function marketKind(value:unknown){if(!['quick_replies','knowledge','studio'].includes(String(value)))throw new TemplateMarketError('invalid_market_kind');return String(value);}
export function marketMoney(value: unknown, maximum = 9900) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new TemplateMarketError('invalid_market_amount');
  return value;
}
export function marketQuote(amount: unknown, feeBps: unknown) {
  const price = marketMoney(amount), rate = marketMoney(feeBps,10000);
  const fee = Math.floor((price * rate + 5000) / 10000);
  return {amount_minor:price,fee_bps:rate,fee_minor:fee,seller_minor:price-fee,freeze_days:7};
}
export function marketText(value: unknown, min: number, max: number) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || value.includes('\u0000')) throw new TemplateMarketError('invalid_market_text');
  return value.trim();
}
export function marketKey(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(value)) throw new TemplateMarketError('invalid_market_key');
  return value;
}
export function marketContent(kind: unknown, raw: unknown) {
  marketKind(kind);
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > (kind==='studio'?1:100)) throw new TemplateMarketError('invalid_market_content');
  const items = raw.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(k=>!['title','body'].includes(k))) throw new TemplateMarketError('invalid_market_content');
    const body=marketText(item.body,1,kind==='studio'?24000:kind==='quick_replies'?4000:20000);
    if(kind==='studio'){try{return {title:marketText(item.title,1,120),body:JSON.stringify(validateDefinition(JSON.parse(body))) };}catch{throw new TemplateMarketError('invalid_studio_template');}}
    return {title:marketText(item.title,1,120),body};
  });
  if (Buffer.byteLength(JSON.stringify(items),'utf8') > 256000) throw new TemplateMarketError('market_content_too_large');
  return items;
}
