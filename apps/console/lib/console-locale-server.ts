import "server-only";
import { cookies, headers } from "next/headers";
import type { ConsoleLocale } from "./console-i18n";

export async function getConsoleLocale(): Promise<ConsoleLocale> {
  const cookieStore = await cookies();
  const saved = cookieStore.get("replynest.console.locale")?.value;
  if (saved === "zh" || saved === "en") return saved;
  const accepted = (await headers()).get("accept-language")?.toLowerCase() ?? "";
  return accepted && !accepted.startsWith("zh") ? "en" : "zh";
}
