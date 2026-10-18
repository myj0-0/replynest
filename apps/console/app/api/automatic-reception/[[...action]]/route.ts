import type {NextRequest} from 'next/server';
import {proxyAutomaticReception} from '../../../../lib/automatic-reception-proxy';
export const dynamic='force-dynamic';
export async function GET(request:NextRequest,{params}:{params:Promise<{action?:string[]}>}){return proxyAutomaticReception(request,(await params).action);}
export async function POST(request:NextRequest,{params}:{params:Promise<{action?:string[]}>}){return proxyAutomaticReception(request,(await params).action);}
