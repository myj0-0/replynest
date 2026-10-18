import { redirect } from "next/navigation";
import { gatewayUrl } from "../../../lib/console-session";

export const dynamic = "force-dynamic";
export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const token = (await searchParams).token ?? "";
  let verified = false;
  try {
    const response = await fetch(gatewayUrl("/api/v1/auth/registration/verify-email"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }), cache: "no-store", signal: AbortSignal.timeout(8_000) });
    verified = response.ok;
  } catch { redirect("/register?error=unavailable"); }
  redirect(verified ? "/register?email=verified" : "/register?error=email_token_expired");
}
