import {NextRequest} from 'next/server';
import {platformAdminMutation} from '../../../../lib/platform-admin-mutation';
export const POST=(request:NextRequest)=>platformAdminMutation(request,'ai-points','POST','/internal-admin/ai-points');
