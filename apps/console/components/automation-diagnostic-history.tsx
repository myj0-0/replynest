export type AutomationDiagnosticHistory={page:number;page_size:number;has_more:boolean;retention_days:number;max_records:number;
 records:Array<{at:number;kind:string;error:string|null;confirmed:boolean;diagnostic_availability:string;
 snapshot:null|{checked_at:string|null;process_started_at:string|null;metrics_current:boolean;reason:string;
 sampling_error:null|{code:string};metrics:null|{reasons:string[];sample:Record<string,number|boolean|null>;deltas:Record<string,number|null>}}}>};

export const automationDiagnosticNames:Record<string,string>={
 database_pressure:'数据库连接压力',planning_errors:'调度或规划异常',queue_delay:'任务等待超过 120 秒',expired_lease:'运行租约过期',claim_contention:'任务领取锁竞争',
 connection_pool_busy:'采样未取得数据库连接',sampling_lock_timeout:'采样查询锁等待超时',sampling_statement_timeout:'采样查询执行超时',
 sampling_permission_denied:'采样查询缺少权限',sampling_schema_missing:'采样依赖的数据表不存在',database_connections_exhausted:'数据库连接数耗尽',
 database_restarting:'数据库重启中',database_unreachable:'无法连接数据库',database_connection_reset:'数据库连接被重置',database_connection_timeout:'数据库连接超时',sampling_failed:'采样失败，具体类型未识别',
 probe_failed:'本地指标采样失败',probe_stale:'本地指标采样已过期',not_checked:'启动后尚未完成采样',runtime_degraded:'运行指标降级',
 automation_runtime_degraded:'运行指标降级',automation_not_checked:'启动后尚未完成采样',automation_sampling_failed:'本地指标采样失败',
 automation_probe_stale:'指标采样已过期或时间无效',automation_network_or_http_failure:'独立探针网络或 HTTP 请求失败'};
export const automationDiagnosticName=(code:string)=>Object.hasOwn(automationDiagnosticNames,code)?automationDiagnosticNames[code]:'原因未识别';
const time=(value:number|string|null)=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'暂无数据';
const metricNames:Record<string,string>={pending:'待处理任务（样本）',oldest_seconds:'样本最长等待秒数',expired_running:'过期租约（样本）',pool_waiting:'连接等待数',rejected:'连接过载拒绝',timeouts:'连接获取超时',claim_lock_timeouts:'领取锁超时',scheduler_errors:'入队轮询失败',planner_errors:'规划轮询失败',partial:'部分完成',failed:'失败任务'};

export function AutomationDiagnosticHistoryPanel({history}:{history?:AutomationDiagnosticHistory}){
 return <section className="rounded-2xl border bg-white p-5 shadow-sm" id="automation-diagnostics">
  <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">自动化降级诊断记录</h2>
   <a href={history?'/internal-admin/monitoring#automation-diagnostics':'/internal-admin/monitoring?automation_history=1#automation-diagnostics'} className="text-sm text-blue-600">{history?'收起记录':'查看诊断记录'}</a></div>
  <p className="mt-2 text-sm text-slate-500">按需加载，每页 20 条。独立监控节点持久保存异常、确认及恢复快照，最多保留 90 天／2,000 条；更早的旧记录没有具体指标，不能补推故障原因。新增记录不改变健康判定或告警阈值。</p>
  {history?<><div className="mt-4 space-y-3">{history.records.length===0?<p className="text-sm text-slate-500">暂无新诊断记录。历史黄色色块仍保留原统计，不代表已找到当时的具体原因。</p>:history.records.map((row,index)=>{
   const snapshot=row.snapshot,current=snapshot?.metrics_current,recovering=row.kind==='recovering';
   const reasons=snapshot?.sampling_error?[snapshot.sampling_error.code]:current&&snapshot?.metrics?.reasons.length?snapshot.metrics.reasons:[snapshot?.reason||row.error||''];
   return <article key={`${row.at}-${index}`} className="rounded-xl border p-4"><div className="flex flex-wrap justify-between gap-2 text-sm"><b>{row.kind==='recovered'?'已恢复':recovering?'恢复观察中':row.confirmed?'连续失败已确认':'单次异常／原因变化'} · {row.kind==='recovered'?'恢复正常':recovering?'单次检查成功':reasons.map(automationDiagnosticName).join('、')}</b><span className="text-slate-500">{time(row.at)}（北京时间）</span></div>
    <p className="mt-2 text-xs text-slate-500">{row.kind==='recovered'?'独立探针已恢复正常；已确认事故按既有连续恢复阈值解除。':recovering?'本次检查成功，但连续成功次数尚不足，事故仍未解除。':row.diagnostic_availability==='available'?'已取得本次异常的受保护指标快照。':row.diagnostic_availability==='sample_moved'?'读取期间样本已变化，未将新样本冒充当时故障指标。':row.diagnostic_availability==='not_configured'?'受保护诊断接口尚未配置。':'未取得指标快照，不能认定是数据库压力。'}</p>
    {snapshot&&<details className="mt-3 text-sm"><summary className="cursor-pointer text-blue-600">查看指标快照</summary>
     <p className="mt-2 text-xs text-slate-500">最近成功采样：{time(snapshot.checked_at)} · 网关进程开始：{time(snapshot.process_started_at)} · {current?'当前有效样本':'旧样本，仅供参考，不代表异常时状态'}</p>
     {snapshot.metrics&&<div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{Object.entries(metricNames).map(([key,label])=><p key={key} className="rounded-lg bg-slate-50 p-2 text-xs">{label}：{typeof snapshot.metrics!.sample[key]==='number'?snapshot.metrics!.sample[key]:'暂无数据'}{key in snapshot.metrics!.deltas?` · 最近 5 分钟新增 ${snapshot.metrics!.deltas[key]??'暂无数据'}`:''}</p>)}</div>}
    </details>}
   </article>;
  })}</div><nav aria-label="自动化诊断分页" className="mt-4 flex flex-wrap gap-4 text-sm">{history.page>1&&<a className="text-blue-600" href={`/internal-admin/monitoring?automation_history=1&page=${history.page-1}#automation-diagnostics`}>上一页</a>}<span>第 {history.page} 页</span>{history.has_more&&<a className="text-blue-600" href={`/internal-admin/monitoring?automation_history=1&page=${history.page+1}#automation-diagnostics`}>下一页</a>}</nav></>:<p className="mt-3 text-sm text-slate-500">点击“查看诊断记录”才读取历史快照。</p>}
 </section>;
}
