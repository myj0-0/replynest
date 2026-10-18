import test from 'node:test';
import assert from 'node:assert/strict';
import { allocatePayment,feeQuote,parseYuan,splitRefund,giftLots,takeGifts } from './wallet-core.js';
test('gift first, full gift redemption; no referral or AI wallet input',()=>{
 assert.deepEqual(allocatePayment(2900,3000,0),{gift_minor:2900,cash_minor:0});
 assert.deepEqual(allocatePayment(9900,3000,10000),{gift_minor:3000,cash_minor:6900});
 assert.throws(()=>allocatePayment(9900,3000,6800),/insufficient/);
});
test('fee is rounded once in fen, currency input rejects float formats',()=>{
 assert.deepEqual(feeQuote(10000),{amount_minor:10000,fee_minor:100,net_minor:9900,policy_version:2});
 assert.equal(feeQuote(50).fee_minor,1);assert.equal(feeQuote(49).fee_minor,0);assert.equal(parseYuan('29.01'),2901);
 for(const x of ['-1','1.001','1e2',1,NaN,'0'])assert.throws(()=>parseYuan(x));
});
test('refund never converts gifts to cash and sums exactly',()=>{
 for(let gift=0;gift<=101;gift++)for(let refund=0;refund<=101;refund++){const q=splitRefund(refund,gift,101-gift);assert.equal(q.cash_minor+q.gift_minor,refund);assert.ok(q.cash_minor<=101-gift);assert.ok(q.gift_minor<=gift);}
 assert.deepEqual(splitRefund(2871,2900,0),{cash_minor:0,gift_minor:2871});
});
test('gift lots preserve expiry and explicit purchase allocations',()=>{
 const base={posted_at:'2026-09-01',transaction_type:'gift_grant',metadata:{}};
 const entries=[{...base,entry_id:'a',direction:'credit',amount_minor:'100',expires_at:'2026-09-10'},{...base,entry_id:'b',direction:'credit',amount_minor:'300',expires_at:null},{...base,entry_id:'c',direction:'debit',amount_minor:'50',expires_at:null,metadata:{gift_allocations:[{entry_id:'a',amount_minor:50}]}}];
 const lots=giftLots(entries,new Date('2026-09-26'));assert.deepEqual(takeGifts(lots,100),[{entry_id:'b',amount_minor:100,expires_at:null}]);assert.throws(()=>takeGifts(lots,301));
});
test('legacy debits cannot consume expired lots and resurrect active credit',()=>{
 const base={posted_at:'2026-09-01',transaction_type:'opening',metadata:{},expires_at:null};
 const entries=[{...base,entry_id:'old',direction:'credit',amount_minor:'100',expires_at:'2026-09-10'},{...base,entry_id:'active',direction:'credit',amount_minor:'300'},{...base,entry_id:'debit',direction:'debit',amount_minor:'50',posted_at:'2026-09-20'}];
 assert.equal(giftLots(entries,new Date('2026-09-26')).reduce((n,l)=>n+l.amount_minor,0),250);
});
test('expired trial reversal removes only its original grant, not later gifts',()=>{
 const base={posted_at:'2026-09-01',transaction_type:'gift_grant',metadata:{},expires_at:null};
 const entries=[{...base,transaction_id:'t1',entry_id:'old',direction:'credit',amount_minor:'100',expires_at:'2026-09-10'},{...base,transaction_id:'t2',entry_id:'new',direction:'credit',amount_minor:'300'},{...base,transaction_id:'t3',reversal_of:'t1',entry_id:'reversed',direction:'debit',amount_minor:'100',posted_at:'2026-09-20'}];
 assert.deepEqual(giftLots(entries,new Date('2026-09-26')),[{entry_id:'new',amount_minor:300,expires_at:null}]);
});

test('referral reversal debt is recovered before any further withdrawal',()=>{
 const base={posted_at:'2026-09-01',transaction_type:'adjustment',expires_at:null};
 const entries=[{...base,entry_id:'grant',direction:'credit',amount_minor:'100'},
 {...base,entry_id:'withdraw',direction:'debit',amount_minor:'100'},
 {...base,entry_id:'reverse',direction:'debit',amount_minor:'100'},
 {...base,entry_id:'next',direction:'credit',amount_minor:'40'}];
 const now=new Date('2026-09-27');
 assert.deepEqual(giftLots(entries,now,true),[]);
 assert.throws(()=>giftLots(entries,now),/requires_review/);
 assert.deepEqual(giftLots([...entries,{...base,entry_id:'later',direction:'credit',amount_minor:'80'}],now,true),[{entry_id:'later',amount_minor:20,expires_at:null}]);
});
