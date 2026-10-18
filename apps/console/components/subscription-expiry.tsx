export function SubscriptionExpiry({end,reset,free,en=false}:{end:unknown;reset:string;free:boolean;en?:boolean}) {
 const time=typeof end==='string'||end instanceof Date?new Date(end).getTime():NaN;
 const days=Number.isFinite(time)?Math.max(0,Math.ceil((time-Date.now())/86400000)):null;
 const warning=!free&&days!==null&&days<=3;
 const format=(date:Date)=>date.toLocaleString(en?'en-GB':'zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
 return <div className={`mt-4 grid gap-3 rounded-xl border p-4 sm:grid-cols-2 ${warning?'border-amber-300 bg-amber-50':'border-blue-100 bg-blue-50'}`}>
  <div><p className="text-sm text-slate-600">{en?'Plan expires (UTC+8)':'套餐到期时间（北京时间）'}</p><p className={`mt-1 text-xl font-bold ${warning?'text-amber-800':'text-blue-800'}`}>{free?(en?'Free plan · no renewal required':'免费版 · 无需续费'):days===null?(en?'No expiry':'长期有效'):format(new Date(time))}</p>
   {!free&&days!==null&&<p className="mt-1 text-sm font-medium">{en?`${days} days remaining · no automatic renewal`:`剩余 ${days} 天 · 不自动续费`}</p>}
  </div>
  <div><p className="text-sm text-slate-600">{en?'AI allowance boundary (UTC+8)':'AI 点数下个周期／权益到期（北京时间）'}</p><p className="mt-1 font-semibold">{format(new Date(reset))}</p><p className="mt-1 text-xs leading-5 text-slate-600">{free?(en?'Free points refresh on the first of each month.':'免费版点数每月 1 日更新。'):(en?'Points refresh monthly from plan activation, not on renewal. At expiry, free-plan limits apply; existing data is retained.':'按套餐生效日逐月更新，续费不重复重置；期限不足一个月时以到期为界，不额外补发。到期恢复免费版权益，已有数据保留。')}</p></div>
 </div>;
}
