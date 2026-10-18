import test from 'node:test';
import assert from 'node:assert/strict';
import {partitionMassRecipients} from './mass-campaign-planner.js';
test('bounded balanced batches preserve every recipient exactly once',()=>{
 for(const rate of [2,3,10,99,100])for(const length of [2,3,99,100,101,199,200,10000]){
  const ids=Array.from({length},(_,n)=>`synthetic-${n}`);
  if(length<Math.ceil(length/rate)*2){assert.throws(()=>partitionMassRecipients(ids,rate));continue;}
  const groups=partitionMassRecipients(ids,rate);
  assert.deepEqual(groups.flat(),ids);
  assert.ok(groups.every(g=>g.length>=2&&g.length<=rate));
 }
});
test('invalid audience or frequency fails rather than silently truncating/deduplicating',()=>{
 for(const ids of [[],['one'],['one','one'],['one','bad id'],Array.from({length:10001},(_,n)=>String(n))])assert.throws(()=>partitionMassRecipients(ids,100));
 for(const rate of [0,1,101,2.5,NaN])assert.throws(()=>partitionMassRecipients(['one','two'],rate));
});
