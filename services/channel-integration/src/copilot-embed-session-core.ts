export function copilotEmbedRouteAllowed(method: string | undefined, pathname: string): boolean {
  if (method !== "POST") return false;
  return pathname === "/api/v1/copilot/context" ||
    pathname === "/api/v1/ai/recommendations" ||
    /^\/api\/v1\/ai\/recommendations\/[0-9a-f-]{36}\/actions$/i.test(pathname);
}
