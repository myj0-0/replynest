import { secretValue } from "./secret-value.js";

const TOKEN_PART_PATTERN = /^[A-Za-z0-9._~-]{1,2048}$/;

export async function verifyCaptchaToken(token: unknown, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (process.env.CAPTCHA_ENABLED !== "true") return true;
  const baseUrl = String(process.env.CAPTCHA_INTERNAL_URL ?? "").replace(/\/$/, "");
  const siteKey = String(process.env.CAPTCHA_SITE_KEY ?? "").trim();
  if (!baseUrl || !/^[A-Za-z0-9_-]{8,128}$/.test(siteKey)) {
    console.error("CAPTCHA is enabled but its verifier configuration is incomplete");
    return false;
  }
  if (typeof token !== "string" || token.length > 4096) return false;
  const tokenParts = token.split(":");
  if (tokenParts.length !== 3 || tokenParts[0] !== siteKey || tokenParts.some((part) => !TOKEN_PART_PATTERN.test(part))) return false;
  const siteSecret = secretValue("CAPTCHA_SITE_SECRET");
  if (!siteSecret) {
    console.error("CAPTCHA is enabled but its verifier configuration is incomplete");
    return false;
  }
  try {
    const response = await fetchImpl(`${baseUrl}/${encodeURIComponent(siteKey)}/siteverify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: siteSecret, response: token }),
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) return false;
    const result = await response.json() as { success?: unknown };
    return result.success === true;
  } catch (error) {
    console.warn("CAPTCHA verification unavailable", error instanceof Error ? error.message : String(error));
    return false;
  }
}
