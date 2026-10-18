import {NextRequest} from 'next/server';
import {platformAdminMutation} from '../../../../lib/platform-admin-mutation';
export const POST=(request:NextRequest)=>platformAdminMutation(request,'growth-policy','POST','/internal-admin/growth-policy');
