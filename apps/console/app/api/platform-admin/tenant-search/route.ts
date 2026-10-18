import {NextRequest,NextResponse} from 'next/server';
import {fetchPlatformAdminSession} from '../../../../lib/platform-admin-session';
import {platformAdminLoad} from '../../../../lib/platform-admin-proxy';
export async function GET(request:NextRequest){
 const session=await fetchPlatformAdminSession();
 if(!session)return NextResponse.json({error:'unauthorized'},{status:401});
 if(!['owner','admin'].includes(session.user.role))return NextResponse.json({error:'forbidden'},{status:403});
 const query=new URLSearchParams({q:request.nextUrl.searchParams.get('q')??'',page:request.nextUrl.searchParams.get('page')??'1'});
 try{const data=await platformAdminLoad('tenant-search?'+query);if(!data)throw Error();return NextResponse.json(data,{headers:{'Cache-Control':'no-store'}});}catch{return NextResponse.json({error:'search_unavailable'},{status:503});}
}
