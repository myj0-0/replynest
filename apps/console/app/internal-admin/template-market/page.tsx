import {redirect} from 'next/navigation';
import {fetchPlatformAdminSession} from '../../../lib/platform-admin-session';
import {PlatformAdminShell} from '../../../components/platform-admin-shell';
import {TemplateMarket} from '../../../components/template-market';
export const dynamic='force-dynamic';
export default async function Page(){const session=await fetchPlatformAdminSession();if(!session)redirect('/internal-admin/login');if(!['owner','admin'].includes(session.user.role))redirect('/internal-admin');return <PlatformAdminShell session={session} activePath="/internal-admin/template-market"><TemplateMarket admin/></PlatformAdminShell>;}
