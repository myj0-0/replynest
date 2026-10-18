import test from 'node:test';import assert from 'node:assert/strict';
import {parseAiUsage,priceAiUsage,initialAiPrices,quoteAiPack} from './ai-points-core.js';
test('weighted inputs, outputs and cache use integer precision without per-request rounding',()=>{
 assert.equal(priceAiUsage({input_tokens:1250,output_tokens:0,cached_input_tokens:0},initialAiPrices.text).points,1);
 const one=priceAiUsage({input_tokens:1,output_tokens:1,cached_input_tokens:0},initialAiPrices.text);
 assert.equal(one.point_micros,3500);assert.equal(one.points,.0035);
 assert.equal(one.point_micros*1000,priceAiUsage({input_tokens:1000,output_tokens:1000,cached_input_tokens:0},initialAiPrices.text).point_micros);
 assert.equal(priceAiUsage({input_tokens:1000,output_tokens:100,cached_input_tokens:500},initialAiPrices.text).cost_nano_cny,720000);
 assert.equal(priceAiUsage({input_tokens:8000,output_tokens:0,cached_input_tokens:0},initialAiPrices.embedding).points,1);
});
test('missing, inconsistent, negative or unsafe usage is not silently free',()=>{
 for(const raw of [{},{prompt_tokens:-1,completion_tokens:0},{prompt_tokens:1,completion_tokens:0,total_tokens:2},{prompt_tokens:1,completion_tokens:0,prompt_tokens_details:{cached_tokens:2}}])assert.throws(()=>parseAiUsage(raw));
 assert.throws(()=>priceAiUsage({input_tokens:Number.MAX_SAFE_INTEGER,output_tokens:0,cached_input_tokens:0},initialAiPrices.text));
});
test('initial 10000-point pack targets one-third model gross margin, not markup',()=>{
 const pack=quoteAiPack(10000,1500);assert.equal(pack.model_budget_nano_cny,10_000_000_000);assert.ok(Math.abs(pack.model_margin_percent-100/3)<1e-10);
});
