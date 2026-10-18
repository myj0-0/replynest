import {redirect,notFound} from 'next/navigation';
import {ConsoleShell} from '../../../../components/console-shell';
import {KnowledgeDocumentEditor,type ManagedDocument} from '../../../../components/knowledge-document-editor';
import {fetchConsoleSession,sessionToken,gatewayUrl} from '../../../../lib/console-session';
import {getConsoleLocale} from '../../../../lib/console-locale-server';
export const dynamic='force-dynamic';
export default async function Page({params}:{params:Promise<{id:string}>}){
 const session=await fetchConsoleSession(),token=await sessionToken();if(!session||!token)redirect('/login');const workspace=session.workspaces.find(w=>w.tenant_id===session.selected_tenant_id);if(!workspace)redirect('/workspaces');
 const en=(await getConsoleLocale())==='en',{id}=await params;if(!/^[0-9a-f-]{36}$/i.test(id))notFound();
 const r=await fetch(gatewayUrl(`/api/v1/ai/knowledge/documents/${id}/manage`),{headers:{authorization:`Bearer ${token}`},cache:'no-store',signal:AbortSignal.timeout(8000)});const b=await r.json();
 return <ConsoleShell session={session} workspace={workspace} activePath="/knowledge" statusPageUrl={process.env.STATUS_PUBLIC_URL??'https://status.replynest.cn/'}><main className="mx-auto max-w-6xl p-4 md:p-8"><a href="/knowledge" className="text-sm text-[var(--brand-700)]">{en?'Back to knowledge':'返回知识库'}</a><h1 className="mt-5 text-2xl font-semibold">{en?'Document maintenance and versions':'文档维护与版本'}</h1>{r.ok?<KnowledgeDocumentEditor key={id} document={b.data as ManagedDocument} canEdit={workspace.role==='tenant_admin'} en={en}/>:<p role="alert" className="mt-5 rounded-xl bg-amber-50 p-4 text-amber-900">{en?'This version is unavailable, too large for online editing or still processing.':'此版本暂不可维护、正文超出在线编辑上限，或仍在安全处理中。'} ({b.error?.code??r.status})</p>}</main></ConsoleShell>;
}
