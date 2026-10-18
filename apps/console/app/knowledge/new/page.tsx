import {redirect} from 'next/navigation';
import {ConsoleShell} from '../../../components/console-shell';
import {ConsoleAccessDenied} from '../../../components/console-access-denied';
import {KnowledgeDocumentEditor} from '../../../components/knowledge-document-editor';
import {fetchConsoleSession} from '../../../lib/console-session';
import {getConsoleLocale} from '../../../lib/console-locale-server';
export const dynamic='force-dynamic';
export default async function Page({searchParams}:{searchParams:Promise<{example?:string}>}){
 const session=await fetchConsoleSession();if(!session)redirect('/login');const workspace=session.workspaces.find(w=>w.tenant_id===session.selected_tenant_id);if(!workspace)redirect('/workspaces');
 const en=(await getConsoleLocale())==='en',query=await searchParams;
 if(workspace.role!=='tenant_admin')return <ConsoleAccessDenied session={session} workspace={workspace} activePath="/knowledge"/>;
 return <ConsoleShell session={session} workspace={workspace} activePath="/knowledge" statusPageUrl={process.env.STATUS_PUBLIC_URL??'https://status.replynest.cn/'}><main className="mx-auto max-w-6xl p-4 md:p-8"><a href="/knowledge" className="text-sm text-[var(--brand-700)]">{en?'Back to knowledge':'返回知识库'}</a><h1 className="mt-5 text-2xl font-semibold">{en?'New knowledge document':'新增知识文档'}</h1><KnowledgeDocumentEditor en={en} example={query.example}/></main></ConsoleShell>;
}
