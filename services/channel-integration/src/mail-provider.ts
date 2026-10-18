import { sendSmtpMail, type Mail } from "./smtp-mailer.js";
import { secretValue } from "./secret-value.js";
import { brandedMail } from './mail-brand.js';

export type MailProviderName = "mailpit" | "aliyun_smtp" | "mailgun";
export type ProviderDiagnostic = {
  provider: string;
  configured: boolean;
  live_send_enabled: boolean;
  missing: string[];
  endpoint?: string;
};

function provider(): MailProviderName {
  const value = process.env.MAIL_PROVIDER ?? "mailpit";
  if (!["mailpit", "aliyun_smtp", "mailgun"].includes(value)) throw new Error(`Unsupported MAIL_PROVIDER: ${value}`);
  return value as MailProviderName;
}

function missing(names: string[]): string[] {
  return names.filter(name => !secretValue(name));
}

export function mailProviderDiagnostic(selected: MailProviderName = provider()): ProviderDiagnostic {
  if (selected === "mailpit") {
    const absent = missing(["SMTP_HOST", "SMTP_FROM"]);
    return { provider: selected, configured: absent.length === 0, live_send_enabled: false, missing: absent, endpoint: `${process.env.SMTP_HOST ?? ""}:${process.env.SMTP_PORT ?? "1025"}` };
  }
  if (selected === "aliyun_smtp") {
    const absent = missing(["ALIYUN_MAIL_SMTP_HOST", "ALIYUN_MAIL_SMTP_USERNAME", "ALIYUN_MAIL_SMTP_PASSWORD", "ALIYUN_MAIL_FROM"]);
    return { provider: selected, configured: absent.length === 0, live_send_enabled: process.env.MAIL_LIVE_SEND_ENABLED === "true", missing: absent, endpoint: `${process.env.ALIYUN_MAIL_SMTP_HOST ?? ""}:${process.env.ALIYUN_MAIL_SMTP_PORT ?? "465"}` };
  }
  const absent = missing(["MAILGUN_API_KEY", "MAILGUN_DOMAIN", "MAILGUN_FROM"]);
  return { provider: selected, configured: absent.length === 0, live_send_enabled: process.env.MAIL_LIVE_SEND_ENABLED === "true", missing: absent, endpoint: process.env.MAILGUN_API_BASE_URL ?? "https://api.mailgun.net" };
}

export function mailProviderDiagnostics(): { selected: MailProviderName; providers: ProviderDiagnostic[] } {
  const selected = provider();
  return {
    selected,
    providers: (["mailpit", "aliyun_smtp", "mailgun"] as MailProviderName[]).map(name => mailProviderDiagnostic(name))
  };
}

async function sendMailgun(mail: Mail): Promise<void> {
  const apiKey = secretValue("MAILGUN_API_KEY") ?? "";
  const domain = process.env.MAILGUN_DOMAIN?.trim() ?? "";
  const from = process.env.MAILGUN_FROM?.trim() ?? "";
  const baseUrl = (process.env.MAILGUN_API_BASE_URL ?? "https://api.mailgun.net").replace(/\/$/, "");
  if (!apiKey || !domain || !from) throw new Error("Mailgun configuration is incomplete");
  const form = new FormData();
  form.set("from", from);
  form.set("to", mail.to);
  form.set("subject", mail.subject);
  form.set("text", mail.text);
  if(mail.html)form.set('html',mail.html);
  if(mail.replyTo)form.set('h:Reply-To',mail.replyTo);
  const response = await fetch(`${baseUrl}/v3/${encodeURIComponent(domain)}/messages`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString("base64")}` },
    body: form,
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Mailgun send failed with HTTP ${response.status}`);
}

export async function sendMail(mail: Mail): Promise<void> {
  mail=brandedMail(mail);
  const selected = provider();
  const diagnostic = mailProviderDiagnostic();
  if (!diagnostic.configured) throw new Error(`${selected} configuration is incomplete`);
  if (selected !== "mailpit" && process.env.MAIL_LIVE_SEND_ENABLED !== "true") throw new Error("External email delivery is disabled");
  if (selected === "mailgun") return sendMailgun(mail);
  if (selected === "aliyun_smtp") {
    return sendSmtpMail(mail, {
      host: process.env.ALIYUN_MAIL_SMTP_HOST!,
      port: Number(process.env.ALIYUN_MAIL_SMTP_PORT ?? 465),
      from: process.env.ALIYUN_MAIL_FROM!,
      secure: true,
      username: secretValue("ALIYUN_MAIL_SMTP_USERNAME")!,
      password: secretValue("ALIYUN_MAIL_SMTP_PASSWORD")!
    });
  }
  return sendSmtpMail(mail, {
    host: process.env.SMTP_HOST!,
    port: Number(process.env.SMTP_PORT ?? 1025),
    from: process.env.SMTP_FROM!,
    secure: false
  });
}
