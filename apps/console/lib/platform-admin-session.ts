import { cookies } from "next/headers";
export const PLATFORM_ADMIN_COOKIE = "replynest_platform_admin_session";
export type PlatformAdminSession = { user: { session_id: string; admin_id: string; email: string; display_name: string; role: "owner"|"admin"|"support"|"auditor"; mfa_enabled:boolean } };
export function adminOrigin(): string { const value=process.env.PLATFORM_ADMIN_PUBLIC_ORIGIN;if(!value)throw new Error("PLATFORM_ADMIN_PUBLIC_ORIGIN is not configured");return value.replace(/\/$/,""); }
export function adminUrl(path:string):URL{return new URL(path,`${adminOrigin()}/`)}
export async function adminToken():Promise<string|undefined>{return (await cookies()).get(PLATFORM_ADMIN_COOKIE)?.value}
export function adminCookieOptions(maxAge:number){return{httpOnly:true,sameSite:"strict" as const,secure:process.env.CONSOLE_COOKIE_SECURE==="true",path:"/",maxAge}}
export function validAdminOrigin(request:Request):boolean{const origin=request.headers.get("origin");try{return Boolean(origin)&&new URL(origin!).origin===new URL(adminOrigin()).origin}catch{return false}}
export async function fetchPlatformAdminSession():Promise<PlatformAdminSession|undefined>{const token=await adminToken();if(!token)return;try{const response=await fetch(`${process.env.GATEWAY_INTERNAL_URL}/api/v1/platform-admin/auth/session`,{headers:{authorization:`Bearer ${token}`},cache:"no-store",signal:AbortSignal.timeout(5000)});if(!response.ok)return;return(await response.json()as{data?:PlatformAdminSession}).data}catch{return}}
