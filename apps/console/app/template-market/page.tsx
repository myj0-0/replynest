import {redirect} from 'next/navigation';
import {fetchConsoleSession} from '../../lib/console-session';
import {ConsoleShell} from '../../components/console-shell';
import {ConsoleAccessDenied} from '../../components/console-access-denied';
export const dynamic='force-dynamic';
export default async function Page(){
 const session=await fetchConsoleSession();if(!session)redirect('/login');const workspace=session.workspaces.find(w=>w.tenant_id===session.selected_tenant_id);if(!workspace)redirect('/workspaces');
 if(workspace.role!=='tenant_admin'||session.impersonation)return <ConsoleAccessDenied session={session} workspace={workspace} activePath="/template-market"/>;
 return <ConsoleShell session={session} workspace={workspace} activePath="/template-market" statusPageUrl={process.env.STATUS_PUBLIC_URL??'https://status.replynest.cn'}><main className="space-y-6 p-4 md:p-8"><h1 className="text-2xl font-semibold">模板市场</h1><p className="text-sm text-slate-500">选择模板类型，分别浏览、领取和管理。</p><div className="grid gap-5 md:grid-cols-3">{[['quick_replies','快捷回复','坐席可使用的话术模板'],['knowledge','知识库','可核对、修改后发布的知识草稿'],['studio','AI 定制工坊','表单、图表、受限代码、工作台与规则示例']].map(([key,title,description])=><a href={`/template-market/${key}`} key={key} className="space-y-3 rounded-2xl border bg-white p-6 hover:border-blue-500"><h2 className="font-semibold">{title}</h2><p className="text-sm text-slate-500">{description}</p><span className="block text-sm text-blue-700">浏览此类模板 →</span></a>)}</div></main></ConsoleShell>;
}
