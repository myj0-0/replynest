import test from 'node:test';
import assert from 'node:assert/strict';
import {manualValidity,snapshotValidity} from './subscription-validity.js';
test('manual adjustments default to 30 days, explicitly support indefinite grants',()=>{
 assert.deepEqual(manualValidity(),{version:1,days:30});
 assert.equal(manualValidity('days','7').days,7);
 assert.equal(manualValidity('days',3650).days,3650);
 assert.equal(manualValidity('unlimited').days,null);
});
test('validity is strict and legacy pending requests keep their approved semantics',()=>{
 for(const value of [0,-1,3651,1.5,'',' 7','7x',null])assert.throws(()=>manualValidity('days',value));
 assert.throws(()=>manualValidity('anything',30));
 assert.equal(snapshotValidity({}),undefined);
 assert.equal(snapshotValidity({manual_validity:{version:1,days:10}})?.days,10);
 assert.equal(snapshotValidity({manual_validity:{version:1,days:null}})?.days,null);
 assert.throws(()=>snapshotValidity({manual_validity:{version:2,days:30}}));
});
