import { cookies } from "next/headers";

export const CONSOLE_SESSION_COOKIE = "crm_console_session";
export const REGISTRATION_COOKIE = "replynest_registration";

export type ConsoleWorkspace = {
  tenant_id: string;
  tenant_name: string;
  tenant_status: string;
  role: "tenant_admin" | "supervisor" | "agent";
};

export type ConsoleSession = {
  user: { id: string; email: string; display_name: string };
  selected_tenant_id: string | null;
  workspaces: ConsoleWorkspace[];
  impersonation: { id: string; admin_name: string | null } | null;
};

export function gatewayUrl(path: string): string {
  const baseUrl = process.env.GATEWAY_INTERNAL_URL;
  if (!baseUrl) throw new Error("GATEWAY_INTERNAL_URL is not configured");
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

export function consoleUrl(path: string): URL {
  const origin = process.env.CONSOLE_PUBLIC_ORIGIN;
  if (!origin) throw new Error("CONSOLE_PUBLIC_ORIGIN is not configured");
  return new URL(path, `${origin.replace(/\/$/, "")}/`);
}

export async function sessionToken(): Promise<string | undefined> {
  return (await cookies()).get(CONSOLE_SESSION_COOKIE)?.value;
}

export async function fetchConsoleSession(): Promise<ConsoleSession | undefined> {
  const token = await sessionToken();
  if (!token) return undefined;
  try {
    const response = await fetch(gatewayUrl("/api/v1/auth/session"), {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) return undefined;
    const body = await response.json() as { data?: ConsoleSession };
    return body.data;
  } catch {
    return undefined;
  }
}

export function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.CONSOLE_COOKIE_SECURE === "true",
    path: "/",
    maxAge
  };
}

export function hasValidOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const configuredOrigins = [
    process.env.CONSOLE_PUBLIC_ORIGIN,
    ...(process.env.CONSOLE_ALLOWED_ORIGINS ?? "").split(",")
  ].filter((value): value is string => Boolean(value?.trim()));
  if (!origin || configuredOrigins.length === 0) return false;
  try {
    const requestOrigin = new URL(origin).origin;
    return configuredOrigins.some(value => new URL(value.trim()).origin === requestOrigin);
  } catch {
    return false;
  }
}
