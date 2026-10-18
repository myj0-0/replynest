export type QuotaMetric="seats"|"channels"|"customers"|"ai_actions_monthly"|"knowledge_bytes";
export type QuotaValue={metric:QuotaMetric;used:number;limit:number|null;periodKey:string};

export function crossedQuotaThresholds(used:number,limit:number|null):Array<80|100>{
  if(limit===null||!Number.isFinite(used)||!Number.isFinite(limit)||used<0||limit<0)return[];
  if(limit===0)return used>0?[100]:[];
  const ratio=used/limit;
  return ratio>=1?[100]:ratio>=.8?[80]:[];
}

export function quotaPercent(used:number,limit:number|null){return limit===null?null:limit===0?(used>0?100:0):Math.floor(used/limit*100)}
