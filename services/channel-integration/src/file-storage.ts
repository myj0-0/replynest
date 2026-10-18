import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { secretValue } from "./secret-value.js";

type StorageProvider = "filesystem" | "s3";
let cachedS3: S3Client | undefined;

function provider(): StorageProvider {
  const selected = process.env.KNOWLEDGE_STORAGE_PROVIDER ?? "filesystem";
  if (selected !== "filesystem" && selected !== "s3") throw new Error("Unsupported knowledge storage provider");
  return selected;
}

function validKey(storageKey: string): string {
  if (!/^[a-zA-Z0-9._/-]+$/.test(storageKey) || storageKey.startsWith("/") || storageKey.includes("..")) throw new Error("Invalid storage key");
  return storageKey;
}

function resolveKey(storageKey: string): string {
  const root = path.resolve(process.env.KNOWLEDGE_STORAGE_ROOT ?? "/app/data/knowledge");
  validKey(storageKey);
  const resolved = path.resolve(root, storageKey);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("Storage path escapes root");
  return resolved;
}

function s3Bucket(): string {
  const bucket = process.env.S3_BUCKET?.trim();
  if (!bucket) throw new Error("S3 bucket is not configured");
  return bucket;
}

function objectKey(storageKey: string): string {
  const prefix = (process.env.S3_PREFIX ?? "replynest").replace(/^\/+|\/+$/g, "");
  return prefix ? `${prefix}/${validKey(storageKey)}` : validKey(storageKey);
}

function s3Client(): S3Client {
  if (cachedS3) return cachedS3;
  const accessKeyId = secretValue("S3_ACCESS_KEY_ID");
  const secretAccessKey = secretValue("S3_SECRET_ACCESS_KEY");
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) throw new Error("S3 credentials are incomplete");
  cachedS3 = new S3Client({
    region: process.env.S3_REGION ?? "auto",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
  });
  return cachedS3;
}

function encryption() {
  const selected = process.env.S3_SERVER_SIDE_ENCRYPTION ?? "AES256";
  if (selected === "none") return {};
  const endpoint = process.env.S3_ENDPOINT;
  const isR2 = endpoint ? (() => {
    try { return new URL(endpoint).hostname.endsWith(".r2.cloudflarestorage.com"); }
    catch { return false; }
  })() : false;
  if (isR2 && selected === "AES256") return {};
  if (selected !== "AES256" && selected !== "aws:kms") throw new Error("Unsupported S3 server-side encryption mode");
  return { ServerSideEncryption: selected, ...(selected === "aws:kms" && process.env.S3_KMS_KEY_ID ? { SSEKMSKeyId: process.env.S3_KMS_KEY_ID } : {}) } as const;
}

export function buildStorageKey(tenantId: string, documentId: string, extension: string): string {
  const safeTenant = tenantId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeExtension = extension.toLowerCase().replace(/[^a-z0-9.]/g, "");
  return `quarantine/${safeTenant}/${documentId}/source${safeExtension}`;
}

export function buildTransferStorageKey(tenantId: string, transferId: string, extension: string): string {
  const safeTenant = tenantId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeTransfer = transferId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeExtension = extension.toLowerCase().replace(/[^a-z0-9.]/g, "");
  return `quarantine/${safeTenant}/transfers/${safeTransfer}/file${safeExtension}`;
}

export function cleanStorageKey(storageKey: string): string {
  const valid = validKey(storageKey);
  if (valid.startsWith("clean/")) return valid;
  return valid.startsWith("quarantine/") ? `clean/${valid.slice("quarantine/".length)}` : `clean/${valid}`;
}

export async function storeQuarantined(storageKey: string, data: Buffer): Promise<void> {
  if (!storageKey.startsWith("quarantine/")) throw new Error("New uploads must enter quarantine storage");
  if (provider() === "s3") {
    await s3Client().send(new PutObjectCommand({ Bucket: s3Bucket(), Key: objectKey(storageKey), Body: data, ContentType: "application/octet-stream", ...encryption() }));
    return;
  }
  const finalPath = resolveKey(storageKey);
  await mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
  const temporary = `${finalPath}.uploading`;
  await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
  await rename(temporary, finalPath);
}

export async function readStored(storageKey: string): Promise<Buffer> {
  if (provider() === "s3") {
    const result = await s3Client().send(new GetObjectCommand({ Bucket: s3Bucket(), Key: objectKey(storageKey) }));
    if (!result.Body) throw new Error("S3 object body is missing");
    return Buffer.from(await result.Body.transformToByteArray());
  }
  return readFile(resolveKey(storageKey));
}

export async function prepareCleanCopy(storageKey: string): Promise<string> {
  const cleanKey = cleanStorageKey(storageKey);
  if (cleanKey === storageKey) return cleanKey;
  if (provider() === "s3") {
    const source = `${s3Bucket()}/${objectKey(storageKey).split("/").map(encodeURIComponent).join("/")}`;
    await s3Client().send(new CopyObjectCommand({ Bucket: s3Bucket(), Key: objectKey(cleanKey), CopySource: source, ...encryption() }));
    return cleanKey;
  }
  const destination = resolveKey(cleanKey);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(resolveKey(storageKey), destination);
  return cleanKey;
}

export async function removeStored(storageKey: string): Promise<void> {
  if (provider() === "s3") {
    await s3Client().send(new DeleteObjectCommand({ Bucket: s3Bucket(), Key: objectKey(storageKey) }));
    return;
  }
  try { await unlink(resolveKey(storageKey)); }
  catch (error: any) { if (error?.code !== "ENOENT") throw error; }
}
