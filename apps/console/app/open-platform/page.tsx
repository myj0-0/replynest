import { redirect } from 'next/navigation';
import { fetchConsoleSession } from '../../lib/console-session';
import { ConsoleShell } from '../../components/console-shell';
import { OpenAppManager } from '../../components/open-app-manager';
export const dynamic='force-dynamic';
export default async function OpenPlatformPage(){
  const session=await fetchConsoleSession();if(!session)redirect('/login?error=expired');
  const workspace=session.workspaces.find(w=>w.tenant_id===session.selected_tenant_id);if(!workspace)redirect('/workspaces');
  return <ConsoleShell session={session} workspace={workspace} activePath="/extensions" statusPageUrl={process.env.STATUS_PUBLIC_URL??'https://status.replynest.cn'}>{workspace.role==='tenant_admin'&&!session.impersonation?<OpenAppManager key={workspace.tenant_id}/>:<p className="p-8">仅企业管理员本人可以授权外部应用。</p>}</ConsoleShell>;
}
