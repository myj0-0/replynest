import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { WeChatConfig } from "./wechat-official.js";
import { readStoredWeChatCredential, type WeChatCredentialMaterial } from "./wechat-channel-secret-store.js";

const DEFAULT_SECRET_ROOT = "/run/replynest-secrets/channels";
const MAX_CREDENTIAL_BYTES = 16 * 1024;

export type WeChatConnection = {
  connectionId: string;
  tenantId: string;
  callbackKey: string;
  displayName: string;
  config: WeChatConfig;
};

type ConnectionCredential = {
  app_id?: unknown;
  app_secret?: unknown;
  token?: unknown;
  encoding_aes_key?: unknown;
};

function credentialRoot(): string {
  return path.resolve(process.env.WECHAT_CHANNEL_SECRET_ROOT ?? DEFAULT_SECRET_ROOT);
}

function allowedCredentialRoots():string[]{return[credentialRoot(),path.resolve(process.env.WECHAT_CHANNEL_WRITABLE_SECRET_ROOT??"/app/data/channel-secrets")];}

async function assertAllowedCredentialPath(reference:string):Promise<string>{
  const resolved=path.resolve(reference);if(!path.isAbsolute(reference))throw new Error("wechat_credential_ref_outside_root");
  const lexicalRoots=allowedCredentialRoots();
  if(!lexicalRoots.some(root=>resolved===root||resolved.startsWith(`${root}${path.sep}`)))throw new Error("wechat_credential_ref_outside_root");
  const realResolved=await realpath(resolved);let inside=false;
  for(const root of lexicalRoots){try{const realRoot=await realpath(root);if(realResolved===realRoot||realResolved.startsWith(`${realRoot}${path.sep}`)){inside=true;break;}}catch{continue}}
  if(!inside)throw new Error("wechat_credential_ref_outside_root");return realResolved;
}

export function validateCallbackKey(value: string): string {
  if (!/^[A-Za-z0-9_-]{12,64}$/.test(value)) throw new Error("invalid_wechat_callback_key");
  return value;
}

export async function readWeChatCredential(reference: string, expectedAppId: string): Promise<WeChatConfig> {
  const realResolved=await assertAllowedCredentialPath(reference);
  const metadata = await stat(realResolved);
  if (!metadata.isFile() || metadata.size > MAX_CREDENTIAL_BYTES) throw new Error("wechat_credential_file_too_large");
  let parsed: ConnectionCredential;
  try { parsed = await readStoredWeChatCredential(realResolved); }
  catch { throw new Error("invalid_wechat_credential_json"); }
  const appId = typeof parsed.app_id === "string" ? parsed.app_id.trim() : "";
  const appSecret = typeof parsed.app_secret === "string" ? parsed.app_secret.trim() : "";
  const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
  const encodingAesKey = typeof parsed.encoding_aes_key === "string" ? parsed.encoding_aes_key.trim() : "";
  if (!/^wx[A-Za-z0-9]{16}$/.test(appId) || appId !== expectedAppId) throw new Error("wechat_credential_app_id_mismatch");
  if (!/^[A-Fa-f0-9]{32}$/.test(appSecret)) throw new Error("invalid_wechat_app_secret");
  if (!/^[A-Za-z0-9]{3,32}$/.test(token)) throw new Error("invalid_wechat_callback_token");
  if (encodingAesKey && !/^[A-Za-z0-9]{43}$/.test(encodingAesKey)) throw new Error("invalid_wechat_encoding_aes_key");
  return { appId, appSecret, token, encodingAesKey: encodingAesKey || undefined };
}

export async function readWeChatCredentialMaterial(reference:string):Promise<WeChatCredentialMaterial>{
  return readStoredWeChatCredential(await assertAllowedCredentialPath(reference));
}

export async function resolveWeChatConnection(callbackKey: string): Promise<WeChatConnection | undefined> {
  validateCallbackKey(callbackKey);
  const { pool } = await import("./database.js");
  const result = await pool.query<{
    connection_id: string; tenant_id: string; callback_key: string; display_name: string;
    external_account_id: string; credential_ref: string;
  }>(
    `SELECT connection_id,tenant_id,callback_key,display_name,external_account_id,credential_ref
       FROM channel_connections
      WHERE channel_type='wechat_official_account' AND callback_key=$1 AND status='ready'`,
    [callbackKey]
  );
  const row = result.rows[0];
  if (!row?.credential_ref || !row.external_account_id) return undefined;
  return {
    connectionId: row.connection_id,
    tenantId: row.tenant_id,
    callbackKey: row.callback_key,
    displayName: row.display_name,
    config: await readWeChatCredential(row.credential_ref, row.external_account_id),
  };
}

export async function resolveWeChatConnectionById(connectionId: string, tenantId: string): Promise<WeChatConnection | undefined> {
  const { pool } = await import("./database.js");
  const result = await pool.query<{ callback_key: string }>(
    `SELECT callback_key FROM channel_connections
      WHERE connection_id=$1 AND tenant_id=$2 AND channel_type='wechat_official_account' AND status='ready'`,
    [connectionId, tenantId]
  );
  return result.rows[0]?.callback_key ? resolveWeChatConnection(result.rows[0].callback_key) : undefined;
}
