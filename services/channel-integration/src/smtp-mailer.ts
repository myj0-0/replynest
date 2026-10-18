import { createConnection, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";
import { randomUUID } from 'node:crypto';

export type Mail = { to: string; subject: string; text: string; html?: string; replyTo?: string };
export type SmtpConfig = {
  host: string;
  port: number;
  from: string;
  secure: boolean;
  username?: string;
  password?: string;
};

export function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function mailMimeBody(mail: Mail): {headers:string;body:string} {
  const base64=(text:string)=>Buffer.from(text,'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n')??'';
  if(!mail.html)return {headers:'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64',body:base64(mail.text)};
  const boundary='replynest-'+randomUUID();
  return {headers:`MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="${boundary}"`,body:
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64(mail.text)}\r\n--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64(mail.html)}\r\n--${boundary}--`};
}

export async function sendSmtpMail(mail: Mail, config: SmtpConfig): Promise<void> {
  const host = config.host.trim();
  const port = config.port;
  const from = sanitizeHeader(config.from);
  const to = sanitizeHeader(mail.to);
  const subject = sanitizeHeader(mail.subject);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !/^\S+@\S+\.\S+$/.test(to) || !from) {
    throw new Error("Invalid SMTP configuration or recipient");
  }
  if (Boolean(config.username) !== Boolean(config.password)) throw new Error("SMTP username and password must be configured together");

  const socket: Socket | TLSSocket = config.secure
    ? connectTls({ host, port, servername: host, rejectUnauthorized: true })
    : createConnection({ host, port });
  socket.setTimeout(5_000);
  let buffer = "";
  let lines: string[] = [];
  const replies: Array<(value: { code: number; text: string }) => void> = [];
  const failures: Array<(error: Error) => void> = [];
  const fail = (error: Error) => { while (failures.length) failures.shift()?.(error); };
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("SMTP connection closed")));
  socket.on("timeout", () => { fail(new Error("SMTP connection timed out")); socket.destroy(); });
  socket.on("data", chunk => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const index = buffer.indexOf("\r\n");
      if (index < 0) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      lines.push(line);
      const match = line.match(/^(\d{3})([ -])/);
      if (match?.[2] === " ") {
        const resolve = replies.shift();
        failures.shift();
        resolve?.({ code: Number(match[1]), text: lines.join("\n") });
        lines = [];
      }
    }
  });

  const reply = () => new Promise<{ code: number; text: string }>((resolve, reject) => { replies.push(resolve); failures.push(reject); });
  const command = async (value: string, expected: number[]) => {
    const pending = reply();
    socket.write(`${value}\r\n`);
    const result = await pending;
    if (!expected.includes(result.code)) throw new Error(`SMTP command failed with ${result.code}`);
  };

  try {
    const greeting = await reply();
    if (greeting.code !== 220) throw new Error(`SMTP greeting failed with ${greeting.code}`);
    await command("EHLO crm-console", [250]);
    if (config.username && config.password) {
      await command("AUTH LOGIN", [334]);
      await command(Buffer.from(config.username).toString("base64"), [334]);
      await command(Buffer.from(config.password).toString("base64"), [235]);
    }
    await command(`MAIL FROM:<${from}>`, [250]);
    await command(`RCPT TO:<${to}>`, [250, 251]);
    await command("DATA", [354]);
    const mime=mailMimeBody(mail);
    const body = mime.body.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    const pendingAcceptance = reply();
    const replyTo=mail.replyTo?`Reply-To: ${sanitizeHeader(mail.replyTo)}\r\n`:'';
    const encodedSubject=`=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
    socket.write(`From: ${from}\r\nTo: ${to}\r\n${replyTo}Subject: ${encodedSubject}\r\n${mime.headers}\r\n\r\n${body}\r\n.\r\n`);
    const accepted = await pendingAcceptance;
    if (accepted.code !== 250) throw new Error(`SMTP message rejected with ${accepted.code}`);
    // The 250 acceptance is definitive even if the server closes on QUIT.
    try { await command("QUIT", [221]); } catch { /* already accepted */ }
  } finally {
    socket.end();
  }
}
