import { CopilotClient } from "../copilot-client";

export const dynamic = "force-dynamic";

export default async function EmbeddedCopilotPage() {
  const chatwootOrigin = process.env.CHATWOOT_PUBLIC_URL;
  if (!chatwootOrigin) throw new Error("CHATWOOT_PUBLIC_URL is not configured");
  return <CopilotClient chatwootOrigin={new URL(chatwootOrigin).origin} embedded />;
}
