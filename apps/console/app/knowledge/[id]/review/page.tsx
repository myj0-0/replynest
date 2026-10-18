import {notFound,redirect} from 'next/navigation';
import {ConsoleAccessDenied} from '../../../../components/console-access-denied';
import {ConsoleShell} from '../../../../components/console-shell';
import {ConsolePageHeading} from '../../../../components/console-page-heading';
import {KnowledgeDraftEditor} from '../../../../components/knowledge-draft-editor';
import {fetchConsoleSession,gatewayUrl,sessionToken} from '../../../../lib/console-session';
import {getConsoleLocale} from '../../../../lib/console-locale-server';
export const dynamic='force-dynamic';
export default async function ReviewDraft({params}:{params:Promise<{id:string}>}){
 const session=await fetchConsoleSession(),token=await sessionToken();if(!session||!token)redirect('/login?error=expired');
 const workspace=session.workspaces.find(x=>x.tenant_id===session.selected_tenant_id);if(!workspace)redirect('/workspaces');
 if(workspace.role!=='tenant_admin')return <ConsoleAccessDenied session={session} workspace={workspace} activePath="/knowledge"/>;const {id}=await params;if(!/^[0-9a-f-]{36}$/i.test(id))notFound();
 const r=await fetch(gatewayUrl(`/api/v1/ai/knowledge/documents/${id}/draft`),{headers:{authorization:`Bearer ${token}`},cache:'no-store'});
 if(r.status===401)redirect('/login?error=expired');if(r.status===403)return <ConsoleAccessDenied session={session} workspace={workspace} activePath="/knowledge"/>;if([404,409].includes(r.status))redirect('/knowledge');if(!r.ok)throw Error('Draft preview unavailable');
 const {data}=await r.json(),en=(await getConsoleLocale())==='en';
 return <ConsoleShell session={session} workspace={workspace} activePath="/knowledge" statusPageUrl={process.env.STATUS_PUBLIC_URL??'http://localhost:3300'}><main className="mx-auto max-w-6xl p-4 md:p-8"><a href="/knowledge" className="text-sm text-blue-700">{en?'Back to knowledge base':'返回知识库'}</a><div className="mt-5"><ConsolePageHeading icon="knowledge">{en?'Review knowledge draft':'核对知识库草稿'}</ConsolePageHeading><p className="mt-2 break-words text-slate-500">{data.title}</p></div><KnowledgeDraftEditor draft={data} en={en}/></main></ConsoleShell>;
}
