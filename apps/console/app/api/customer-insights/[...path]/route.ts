import type {NextRequest} from 'next/server';
import {proxyCustomerInsights} from '../../../../lib/customer-insights-proxy';
export const dynamic='force-dynamic';
type Context={params:Promise<{path:string[]}>};
export async function GET(req:NextRequest,ctx:Context){return proxyCustomerInsights(req,(await ctx.params).path);}
export async function POST(req:NextRequest,ctx:Context){return proxyCustomerInsights(req,(await ctx.params).path);}
