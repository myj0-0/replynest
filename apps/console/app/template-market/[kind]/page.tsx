import {notFound,redirect} from 'next/navigation';
import {fetchConsoleSession} from '../../../lib/console-session';
import {ConsoleShell} from '../../../components/console-shell';
import {TemplateMarket} from '../../../components/template-market';
import {ConsoleAccessDenied} from '../../../components/console-access-denied';
export const dynamic='force-dynamic';
export default async function Page({params}:{params:Promise<{kind:string}>}){
 const {kind}=await params;if(kind!=='quick_replies'&&kind!=='knowledge'&&kind!=='studio')notFound();
 const session=await fetchConsoleSession();if(!session)redirect('/login');const workspace=session.workspaces.find(w=>w.tenant_id===session.selected_tenant_id);if(!workspace)redirect('/workspaces');
 if(workspace.role!=='tenant_admin'||session.impersonation)return <ConsoleAccessDenied session={session} workspace={workspace} activePath="/template-market"/>;
 return <ConsoleShell session={session} workspace={workspace} activePath="/template-market" statusPageUrl={process.env.STATUS_PUBLIC_URL??'https://status.replynest.cn'}><TemplateMarket key={`${workspace.tenant_id}:${kind}`} kind={kind} testTenant={workspace.tenant_status==='test'}/></ConsoleShell>;
}
