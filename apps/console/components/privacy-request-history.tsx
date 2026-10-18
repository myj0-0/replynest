import {PrivacyHistoryFilter} from './privacy-history-filter';
import {privacyProgress} from '../lib/page-list-filter';
import {Clock3} from 'lucide-react';
import {gatewayUrl} from '../lib/console-session';
import {redirect} from 'next/navigation';

export type PrivacyHistoryQuery={history?:string;before?:string;after?:string};
type Row={privacy_request_id:string;request_type:string;status:string;details:string;created_at:string;due_at:string;resolution_summary?:string;legal_hold_reason?:string};
type History={data:Row[];pagination:{page_size:number;next:string|null;previous:string|null}};
const types={zh:{access:'查阅',copy:'复制',correction:'更正或补充',deletion:'删除',withdraw_consent:'撤回同意',account_closure:'账号注销'},en:{access:'Access',copy:'Copy',correction:'Correction',deletion:'Deletion',withdraw_consent:'Withdraw consent',account_closure:'Close account'}};
const statuses={zh:{submitted:'已提交',identity_verification:'待身份核验',in_review:'处理中',fulfilled:'已完成',partially_fulfilled:'部分完成',rejected:'未予执行',cancelled:'已取消'},en:{submitted:'Submitted',identity_verification:'Identity verification',in_review:'In review',fulfilled:'Fulfilled',partially_fulfilled:'Partially fulfilled',rejected:'Rejected',cancelled:'Cancelled'}};
const url=(direction?:'before'|'after',cursor?:string)=>{
  const params=new URLSearchParams({history:'1'});if(direction&&cursor)params.set(direction,cursor);
  return `/settings/privacy?${params}#privacy-history`;
};
const linkClass='rounded-xl border px-4 py-2 text-sm text-blue-600';

/** Server-only history: auth stays on the server; no queries or prefetch before clicking. */
export async function PrivacyRequestHistory({token,en,query}:{token:string;en:boolean;query:PrivacyHistoryQuery}){
  const loaded=query.history==='1';let history:History|undefined,expired=false;
  if(loaded)try{
    const params=new URLSearchParams();for(const key of ['before','after'] as const)if(query[key]!==undefined)params.set(key,query[key]!);
    const response=await fetch(gatewayUrl(`/api/v1/privacy/requests?${params}`),{headers:{authorization:`Bearer ${token}`},cache:'no-store',signal:AbortSignal.timeout(8000)});
    expired=response.status===401;
    if(response.ok){const body=await response.json() as History;if(Array.isArray(body.data)&&body.data.length<=20&&body.pagination?.page_size===20)history=body;}
  }catch{/* Unavailable is not an empty history. */}
  if(expired)redirect('/login?error=expired');
  const time=(value:string)=>new Date(value).toLocaleString(en?'en-US':'zh-CN',{timeZone:'Asia/Shanghai'});
  const typeNames:Record<string,string>=types[en?'en':'zh'],statusNames:Record<string,string>=statuses[en?'en':'zh'];
  return <section id="privacy-history" className="mt-6 scroll-mt-24 rounded-2xl border bg-white p-5 shadow-sm">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="flex items-center gap-2 font-semibold"><Clock3 size={18}/>{en?'My privacy requests':'我的隐私申请'}</h2>
      {/* Native links intentionally do not prefetch on viewport/hover. */}
      <a href={loaded?'/settings/privacy#privacy-history':url()} className={linkClass}>{loaded?(en?'Hide history':'收起记录'):(en?'View request history':'查看申请记录')}</a>
    </div>
    {!loaded?<p className="mt-3 text-sm text-slate-500">{en?'Load history when needed, 20 requests per page.':'历史记录按需加载，每页 20 条。点击后查看申请进度及处理结果。'}</p>:!history?<div role="alert" className="mt-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-900"><p>{en?'Requests could not be loaded or the page link is invalid. Retry or return to the latest records.':'申请记录暂时无法加载或分页链接无效；这不代表暂无申请。请重试或返回最新记录。'}</p><div className="mt-3 flex gap-4"><a className="text-blue-600" href={url(query.after!==undefined?'after':query.before!==undefined?'before':undefined,query.after??query.before)}>{en?'Retry':'重试'}</a><a className="text-blue-600" href={url()}>{en?'Latest records':'最新记录'}</a></div></div>:<>
      <p className="mt-3 text-xs text-slate-500">{en?'Newest first · 20 per page. Expand a request for its explanation and result.':'按提交时间倒序 · 每页 20 条。展开单条申请查看具体说明与处理结果。'}</p>
      <PrivacyHistoryFilter en={en} items={history.data.map(row=>({id:row.privacy_request_id,status:row.status,content:<details className="py-3">
        <summary className="cursor-pointer text-sm"><span className="font-semibold">{typeNames[row.request_type]??row.request_type}</span><span className="ml-3 rounded-full bg-slate-100 px-2.5 py-1 text-xs">{statusNames[row.status]??row.status}</span><time className="ml-3 text-xs text-slate-500">{time(row.created_at)}</time></summary>
        {privacyProgress(row.status)!==null&&<ol aria-label={en?'Request processing stages':'申请办理阶段'} className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">{(en?['Submitted','Identity check','Review','Result']:['已提交','身份核验','审核办理','处理结果']).map((stage,index)=><li key={stage} aria-current={privacyProgress(row.status)===index?'step':undefined} className={`rounded-lg p-2 text-xs ${privacyProgress(row.status)===index?'bg-blue-50 font-semibold text-blue-700':'bg-slate-50 text-slate-500'}`}>{stage}</li>)}</ol>}
        <p className="mt-3 whitespace-pre-wrap break-words text-sm text-slate-600">{row.details}</p><p className="mt-2 text-xs text-slate-500">{en?'Target date':'目标处理日期'} {time(row.due_at)}</p>
        {row.resolution_summary&&<p className="mt-3 whitespace-pre-wrap break-words rounded-xl bg-slate-50 p-3 text-sm">{en?'Resolution':'处理说明'}：{row.resolution_summary}</p>}
        {row.legal_hold_reason&&<p className="mt-2 whitespace-pre-wrap break-words rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{en?'Cannot fully execute yet':'暂不能全部执行'}：{row.legal_hold_reason}</p>}
      </details>}))}/>{!history.data.length&&<p className="py-8 text-center text-sm text-slate-500">{query.before||query.after?(en?'No requests on this page. Return to the latest records.':'本页暂无申请，请返回最新记录。'):en?'No requests yet.':'暂无申请。'}</p>}
      <nav aria-label={en?'Request history pagination':'隐私申请分页'} className="mt-4 flex flex-wrap gap-3"><a href={url()} className={linkClass}>{en?'Latest records / refresh':'最新记录 / 刷新'}</a>
        {history.pagination.previous&&<a href={url('after',history.pagination.previous)} className={linkClass}>{en?'Previous page':'上一页'}</a>}
        {history.pagination.next&&<a href={url('before',history.pagination.next)} className={linkClass}>{en?'Next page':'下一页'}</a>}
      </nav>
    </>}
  </section>;
}
