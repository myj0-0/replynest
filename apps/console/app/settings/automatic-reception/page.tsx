import {redirect} from 'next/navigation';
import {ConsoleAccessDenied} from '../../../components/console-access-denied';
import {fetchConsoleSession} from '../../../lib/console-session';
import {ConsoleShell} from '../../../components/console-shell';
import {ConsolePageHeading} from '../../../components/console-page-heading';
import {AutomaticReceptionLayout} from '../../../components/automatic-reception-layout';
export const dynamic='force-dynamic';
export default async function AutomaticReceptionPage(){
 const session=await fetchConsoleSession();if(!session)redirect('/login?error=expired');
 const workspace=session.workspaces.find(w=>w.tenant_id===session.selected_tenant_id);if(!workspace)redirect('/workspaces');
 if(workspace.role!=='tenant_admin'||session.impersonation)return <ConsoleAccessDenied session={session} workspace={workspace} activePath="/settings/automatic-reception"/>;
 return <ConsoleShell session={session} workspace={workspace} activePath="/settings/automatic-reception" statusPageUrl={process.env.STATUS_PUBLIC_URL??'http://localhost:3300'}>
  <main className="mx-auto min-h-screen max-w-5xl p-4 md:p-8"><ConsolePageHeading icon="settings">AI 接待设置</ConsolePageHeading>
   <p className="mt-2 text-sm leading-6 text-[var(--ink-500)]">管理自动接待授权、知识库及回复偏好。执行记录与 AI 点数扣费请在套餐与账务中核对。</p>
   <AutomaticReceptionLayout key={workspace.tenant_id} workspaceId={workspace.tenant_id} personalization={process.env.CONSOLE_RECEPTION_PERSONALIZATION_ENABLED==='true'} insights={process.env.CONSOLE_CUSTOMER_INSIGHTS_ENABLED==='true'}/>
  </main>
 </ConsoleShell>;
}
