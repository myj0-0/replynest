import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { secretValue } from "./secret-value.js";

export type WeChatCredentialMaterial = {
  app_id: string;
  app_secret: string;
  token: string;
  encoding_aes_key: string;
};

type Envelope = { version:"v1"; iv:string; ciphertext:string; tag:string };
const AAD=Buffer.from("replynest:wechat-channel:v1");

function masterKey():Buffer{
  const configured=secretValue("WECHAT_CHANNEL_MASTER_KEY");
  if(!configured)throw new Error("wechat_channel_master_key_not_configured");
  const key=/^[a-f0-9]{64}$/i.test(configured)?Buffer.from(configured,"hex"):Buffer.from(configured,"base64");
  if(key.length!==32)throw new Error("invalid_wechat_channel_master_key");
  return key;
}

export function encryptWeChatCredential(value:WeChatCredentialMaterial):Envelope{
  const iv=randomBytes(12);const cipher=createCipheriv("aes-256-gcm",masterKey(),iv);cipher.setAAD(AAD);
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),"utf8"),cipher.final()]);
  return{version:"v1",iv:iv.toString("base64url"),ciphertext:ciphertext.toString("base64url"),tag:cipher.getAuthTag().toString("base64url")};
}

export function decryptWeChatCredential(value:Envelope):WeChatCredentialMaterial{
  if(value.version!=="v1")throw new Error("invalid_wechat_credential_envelope");
  const iv=Buffer.from(value.iv,"base64url"),ciphertext=Buffer.from(value.ciphertext,"base64url"),tag=Buffer.from(value.tag,"base64url");
  if(iv.length!==12||tag.length!==16||ciphertext.length>16*1024)throw new Error("invalid_wechat_credential_envelope");
  const decipher=createDecipheriv("aes-256-gcm",masterKey(),iv);decipher.setAAD(AAD);decipher.setAuthTag(tag);
  const parsed=JSON.parse(Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString("utf8")) as WeChatCredentialMaterial;
  return parsed;
}

export async function writeWeChatCredential(fileName:string,value:WeChatCredentialMaterial):Promise<string>{
  if(!/^[A-Za-z0-9_-]{12,64}\.json$/.test(fileName))throw new Error("invalid_wechat_credential_filename");
  const root=path.resolve(process.env.WECHAT_CHANNEL_WRITABLE_SECRET_ROOT??"/app/data/channel-secrets");
  await mkdir(root,{recursive:true,mode:0o700});
  const destination=path.join(root,fileName);const temporary=`${destination}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(temporary,`${JSON.stringify(encryptWeChatCredential(value))}\n`,{flag:"wx",mode:0o600});
  await rename(temporary,destination);
  return destination;
}

export async function readStoredWeChatCredential(reference:string):Promise<WeChatCredentialMaterial>{
  const parsed=JSON.parse(await readFile(reference,"utf8")) as Envelope|WeChatCredentialMaterial;
  return "version" in parsed?decryptWeChatCredential(parsed):parsed;
}
