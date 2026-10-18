export const billingHistoryViews = [
 ['reception','自动接待扣费'], ['points','点数包购买／退款'],
 ['insights','客户 AI 备注与画像扣费'],
 ['purchases','套餐购买／申请退款'], ['refunds','退款申请进度'],
 ['orders','充值与支付宝订单'], ['ledger','账户流水'],
 ['commissions','邀请返佣'], ['withdrawals','邀请奖励提现'],
 ['template-payouts','模板收益与提现'],
] as const;

export function BillingHistoryLinks({en=false,reception=false,insights=false}:{en?:boolean;reception?:boolean;insights?:boolean}) {
 return <section id="automatic-reception-costs" className="mt-6 rounded-2xl border border-[var(--border-subtle)] bg-white p-5 shadow-[var(--shadow-card)] md:p-6">
  <h2 className="text-lg font-semibold">{en?'Billing history':'账务明细'}</h2>
  <p className="mt-2 text-sm text-slate-500">{en?'Choose a category when you need to review charges or request progress. Records load only after you open a category.':'需要核对扣款或审批进度时，选择下方类别查看。仅在打开对应类别后加载记录。'}</p>
  <div className="mt-4 flex flex-wrap gap-3">{billingHistoryViews.filter(([key])=>key==='insights'?insights&&reception:!['reception','template-payouts'].includes(key)||reception).map(([key,label])=><a key={key} href={'/billing/history?view='+key} className="rounded-xl border px-3 py-2 text-sm text-blue-700 hover:bg-blue-50">{label}</a>)}</div>
 </section>;
}
