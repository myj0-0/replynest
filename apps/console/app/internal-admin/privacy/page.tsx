import {AdminListNavigation} from '../../../components/admin-list-navigation';
import {adminListQuery,type AdminListQuery} from '../../../lib/admin-list-query';
import {FileLock2} from 'lucide-react';
import {redirect} from 'next/navigation';
import {PlatformAdminShell} from '../../../components/platform-admin-shell';
import {platformAdminLoad} from '../../../lib/platform-admin-proxy';
import {fetchPlatformAdminSession} from '../../../lib/platform-admin-session';
export const dynamic='force-dynamic';
type Row={privacy_request_id:string;tenant_name:string;request_type:string;status:string;due_at:string;created_at:string;user_email:string;user_name:string;resolution_summary?:string};
type Data={page:number;has_more:boolean;requests:Row[];statuses:{status:string;count:number}[];retention:{total:number;policy:{effective_execution:boolean}}};
const names:Record<string,string>={access:'查阅',copy:'复制',correction:'更正',deletion:'删除',withdraw_consent:'撤回同意',account_closure:'账号注销',submitted:'已提交',identity_verification:'待核验',in_review:'处理中',fulfilled:'已完成',partially_fulfilled:'部分完成',rejected:'未予执行',cancelled:'已取消'};
const time=(v:string)=>new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'});
export default async function PrivacyOperationsPage({searchParams}:{searchParams:Promise<AdminListQuery>}){
 const session=await fetchPlatformAdminSession();if(!session)redirect('/internal-admin/login');const query=await searchParams,filter=adminListQuery(query);
 let data:Data|undefined;try{data=await platformAdminLoad('privacy-requests?'+filter.params)as Data|undefined;}catch{/* Never imply an empty queue when transport fails. */}
 return <PlatformAdminShell session={session} activePath="/internal-admin/privacy"><section><h1 className="flex items-center gap-2 text-2xl font-semibold"><FileLock2/>隐私请求与人工办理</h1><p className="mt-2 text-sm text-slate-500">打开申请详情核对用户说明，完成身份核验与实际办理后登记结果。状态变化和内部办理记录保留时间线。</p></section>{!data?<p role="alert" className="rounded-xl bg-red-50 p-4 text-red-700">无法加载申请，请确认权限或稍后重试。</p>:<>
  <section className="rounded-xl border bg-slate-50 p-4 text-sm">注册验证资料自动清理：{data.retention.policy.effective_execution?'已启用':'未启用'} · 当前候选 {data.retention.total} 条。与隐私申请人工办理分别处理，不会因申请状态更新而自动删除账号。</section>
  <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{data.statuses.map(i=><div key={i.status} className="rounded-xl border bg-white p-4"><p className="text-sm text-slate-500">{names[i.status]}</p><b className="mt-1 block text-2xl">{i.count}</b></div>)}</section>
  <AdminListNavigation path="/internal-admin/privacy" q={filter.q} status={filter.status} page={filter.page} hasMore={data.has_more} states={{submitted:'已提交',identity_verification:'待核验',in_review:'处理中',fulfilled:'已完成',partially_fulfilled:'部分完成',rejected:'未予执行',cancelled:'已取消'}} placeholder="搜索企业、申请编号或申请人邮箱"/>
  <p className="text-xs text-slate-500">按目标处理期限从早到晚排序，详情与办理时间线按需加载。</p><section className="space-y-3">{data.requests.map(r=><article key={r.privacy_request_id} className="rounded-2xl border bg-white p-5"><div className="flex flex-wrap justify-between gap-3"><div><b>{names[r.request_type]} · {names[r.status]}</b><p className="mt-1 text-sm text-slate-600">{r.tenant_name} · {r.user_name} · {r.user_email}</p><p className="mt-1 break-all font-mono text-xs text-slate-400">{r.privacy_request_id}</p></div><div className="text-xs text-slate-500"><p>提交 {time(r.created_at)}</p><p>目标 {time(r.due_at)}</p></div></div><a href={`/internal-admin/privacy/${r.privacy_request_id}`} className="mt-4 inline-flex rounded-xl border px-4 py-2 text-sm text-blue-600">查看完整说明与办理记录</a>{r.resolution_summary&&<p className="mt-3 line-clamp-2 text-sm text-slate-500">{r.resolution_summary}</p>}</article>)}{!data.requests.length&&<p className="rounded-xl border bg-white p-6 text-center text-sm text-slate-500">暂无匹配申请。</p>}</section>
 </>}</PlatformAdminShell>;
}
