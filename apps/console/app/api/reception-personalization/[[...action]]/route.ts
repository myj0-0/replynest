import type {NextRequest} from 'next/server';
import {proxyReceptionPersonalization} from '../../../../lib/reception-personalization-proxy';
export const dynamic='force-dynamic';
export async function GET(req:NextRequest,{params}:{params:Promise<{action?:string[]}>}){return proxyReceptionPersonalization(req,(await params).action);}
export async function POST(req:NextRequest,{params}:{params:Promise<{action?:string[]}>}){return proxyReceptionPersonalization(req,(await params).action);}
