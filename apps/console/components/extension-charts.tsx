'use client';
export type ChartDefinition={key:string;title:string;type:'bar'|'line';group_by:string;metric:'count'|'sum'|'average';value_field?:string};
export type ChartSummary={key:string;record_count:number;included_count:number;omitted_groups:number;points:{label:string;value:number;count:number}[]};
const number=(n:number)=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(n);
export function ExtensionCharts({charts,summaries=[]}:{charts:ChartDefinition[];summaries?:ChartSummary[]}){
 return <section aria-label="应用统计图表" className="space-y-4">{charts.map(chart=>{
  const summary=summaries.find(s=>s.key===chart.key),points=summary?.points??[];
  const min=Math.min(0,...points.map(p=>p.value)),max=Math.max(0,...points.map(p=>p.value)),span=max-min||1,zero=(0-min)/span*100;
  const start=Date.parse(points[0]?.label??'')||0,end=Date.parse(points.at(-1)?.label??'')||start;
  const coords=points.map(p=>({x:24+(end===start?0.5:(Date.parse(p.label)-start)/(end-start))*552,y:156-(p.value-min)/span*132}));
  return <article key={chart.key} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5">
   <h3 className="break-words font-semibold">{chart.title}</h3>
   <p className="mt-1 text-xs leading-5 text-slate-500">本应用当前所选版本 · {{count:'记录数量',sum:'数值合计',average:'数值平均'}[chart.metric]} · 共 {summary?.record_count??0} 条记录，纳入 {summary?.included_count??0} 条。缺少分组或指标值的记录不计入。数值显示最多两位小数。</p>
   {!points.length?<p className="mt-4 rounded-xl bg-slate-50 p-4 text-sm text-slate-500">暂无可统计数据。发布后提交记录即可查看；模拟不会保存记录。</p>:<>
    {chart.type==='bar'?<div className="mt-4 space-y-3" role="img" aria-label={`${chart.title}，各分组数值见下方数据表`}>{points.map(p=><div key={p.label} className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] items-center gap-2 text-xs"><span className="truncate" title={p.label}>{p.label}</span><div className="relative h-5 rounded bg-slate-50"><span className="absolute top-0 h-5 border-l border-slate-300" style={{left:`${zero}%`}}/><span className="absolute top-1 h-3 rounded bg-blue-500" style={{left:`${Math.min(zero,(p.value-min)/span*100)}%`,width:`${Math.abs(p.value)/span*100}%`}}/></div><span className="tabular-nums">{number(p.value)}</span></div>)}</div>:
    <div className="mt-4"><svg role="img" aria-label={`${chart.title}，横轴为日期，纵轴为数值，详细数据见下方表格`} viewBox="0 0 600 180" className="max-h-56 w-full"><title>{chart.title}</title><line x1="24" x2="576" y1={156-(0-min)/span*132} y2={156-(0-min)/span*132} stroke="#cbd5e1"/><polyline points={coords.map(p=>`${p.x},${p.y}`).join(' ')} fill="none" stroke="#2563eb" strokeWidth="2"/>{coords.map((p,i)=><circle key={points[i].label} cx={p.x} cy={p.y} r="3" fill="#2563eb"><title>{points[i].label}: {number(points[i].value)}</title></circle>)}<text x="24" y="175" fontSize="10" fill="#64748b">{points[0].label}</text><text x="576" y="175" textAnchor="end" fontSize="10" fill="#64748b">{points.at(-1)?.label}</text><text x="24" y="15" fontSize="10" fill="#64748b">最大 {number(max)} / 最小 {number(min)}</text></svg></div>}
    <details className="mt-3 text-xs"><summary className="cursor-pointer text-blue-700">查看图表数据</summary><div className="mt-2 overflow-x-auto"><table className="w-full text-left"><caption className="sr-only">{chart.title}</caption><thead><tr><th className="p-2">分组</th><th className="p-2">数值</th><th className="p-2">纳入记录</th></tr></thead><tbody>{points.map(p=><tr key={p.label}><td className="max-w-64 break-words p-2">{p.label}</td><td className="p-2">{number(p.value)}</td><td className="p-2">{p.count}</td></tr>)}</tbody></table></div></details>
   </>}
   {!!summary?.omitted_groups&&<p className="mt-3 text-xs text-amber-700">仅展示{chart.type==='line'?'最近 30 个日期':'数值最高的 30 个分组'}；另有 {summary.omitted_groups} 个分组未显示，未合并为“其他”。</p>}
  </article>;
 })}</section>;
}
