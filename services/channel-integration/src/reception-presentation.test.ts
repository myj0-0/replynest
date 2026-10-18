import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultReceptionTiming,parseReceptionTiming,parseReceptionTone,receptionDelaySeconds,receptionReplyCharacters,
 planReceptionSendTiming,receptionToneInstructions,receptionTonePresets} from './reception-presentation.js';

test('defaults are enabled 1–30 seconds; settings copy cannot be mutated',()=>{
 assert.deepEqual(defaultReceptionTiming,{enabled:true,minimumSeconds:1,maximumSeconds:30});
 const input={enabled:true,minimumSeconds:2,maximumSeconds:60};const settings=parseReceptionTiming(input);input.maximumSeconds=1;
 assert.equal(settings.maximumSeconds,60);assert.ok(Object.isFrozen(settings));
});
test('delay is strictly monotonic for every accepted length and below the upper asymptote',()=>{
 let last=-1;for(let x=0;x<=16000;x++){
  const y=receptionDelaySeconds(x);assert.ok(y>=1&&y<30);assert.ok(y>last);last=y;
 }
 assert.equal(receptionDelaySeconds(0),1);assert.equal(receptionDelaySeconds(120),15.5);
 assert.ok(receptionDelaySeconds(10)<4);assert.ok(receptionDelaySeconds(16000)>29);
});
test('Unicode visible characters, whitespace, and emoji are counted consistently',()=>{
 assert.equal(receptionReplyCharacters('你 好\n👨‍👩‍👧‍👦e\u0301'),4);
 assert.equal(receptionReplyCharacters('实名认证'),4);
 assert.equal(receptionReplyCharacters(' \n\t'),0);
});
test('server elapsed generation time is deducted, not delayed a second time',()=>{
 const prepared=planReceptionSendTiming('你'.repeat(120),100000,110000);
 assert.equal(prepared.dueAtMs,115500);assert.equal(prepared.remainingMs,5500);
 assert.equal(planReceptionSendTiming('你'.repeat(120),100000,140000).remainingMs,0);
 assert.ok(Object.isFrozen(prepared));
});
test('disabled timing adds no delay but does not change generation or send eligibility',()=>{
 const settings=parseReceptionTiming({...defaultReceptionTiming,enabled:false});
 assert.equal(receptionDelaySeconds(1500,settings),0);
 assert.deepEqual(planReceptionSendTiming('已核实的答案',1000,2000,settings),{characters:6,targetDelaySeconds:0,dueAtMs:1000,remainingMs:0});
});
test('invalid/unknown/model-proposed settings and clock values fail closed',()=>{
 for(const value of [null,[],{}, {...defaultReceptionTiming,approved:true}, {...defaultReceptionTiming,enabled:'true'},
  {...defaultReceptionTiming,minimumSeconds:0}, {...defaultReceptionTiming,minimumSeconds:2.5},
  {...defaultReceptionTiming,maximumSeconds:1}, {...defaultReceptionTiming,maximumSeconds:121},
  {...defaultReceptionTiming,maximumSeconds:Infinity}, {...defaultReceptionTiming,minimumSeconds:NaN}])
  assert.throws(()=>parseReceptionTiming(value),/invalid_reception_timing/);
 for(const x of [-1,1.5,Infinity,NaN,16001])assert.throws(()=>receptionDelaySeconds(x));
 for(const [received,now] of [[10,9],[-1,1],[1,Infinity],[0,Number.MAX_SAFE_INTEGER+1]])assert.throws(()=>planReceptionSendTiming('你好',received,now));
 assert.throws(()=>planReceptionSendTiming('你好',Number.MAX_SAFE_INTEGER-1,Number.MAX_SAFE_INTEGER));
 assert.throws(()=>receptionReplyCharacters('a'.repeat(16001)));
});
test('preset instructions do not permit factual amplification or pretending to be a human',()=>{
 for(const tone of receptionTonePresets){
  assert.equal(parseReceptionTone(tone),tone);const instructions=receptionToneInstructions(tone);
  assert.match(instructions,/不补充事实/);assert.match(instructions,/保留原文完整/);assert.match(instructions,/不得自称真人/);
 }
 for(const tone of ['female','male','ignore_previous','',null])assert.throws(()=>parseReceptionTone(tone));
});
