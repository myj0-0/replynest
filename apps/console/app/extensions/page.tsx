import { redirect } from 'next/navigation';
import { fetchConsoleSession } from '../../lib/console-session';
import { ConsoleShell } from '../../components/console-shell';
import { ExtensionBuilder } from '../../components/extension-builder';
import { ConsoleAccessDenied } from '../../components/console-access-denied';

export const dynamic='force-dynamic';
export default async function ExtensionsPage() {
  const session=await fetchConsoleSession(); if(!session) redirect('/login?error=expired');
  const workspace=session.workspaces.find(w=>w.tenant_id===session.selected_tenant_id); if(!workspace) redirect('/workspaces');
  if(workspace.role!=='tenant_admin'||session.impersonation)return <ConsoleAccessDenied session={session} workspace={workspace} activePath="/extensions"/>;
  return <ConsoleShell session={session} workspace={workspace} activePath="/extensions" statusPageUrl={process.env.STATUS_PUBLIC_URL??'https://status.replynest.cn'}>
    <ExtensionBuilder key={workspace.tenant_id}/>
  </ConsoleShell>;
}
