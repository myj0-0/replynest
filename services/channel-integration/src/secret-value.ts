import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const MAX_SECRET_BYTES = 64 * 1024;

export function secretValue(name: string): string | undefined {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error("Invalid secret name");
  const fileName = String(process.env[`${name}_FILE`] ?? "").trim();
  if (fileName) {
    if (!path.isAbsolute(fileName)) throw new Error(`Secret file for ${name} must use an absolute path`);
    const metadata = statSync(fileName);
    if (!metadata.isFile() || metadata.size > MAX_SECRET_BYTES) throw new Error(`Secret file for ${name} is invalid`);
    const value = readFileSync(fileName, "utf8").replace(/\r?\n$/, "");
    if (value.includes("\0")) throw new Error(`Secret file for ${name} contains invalid data`);
    return value || undefined;
  }
  const value = String(process.env[name] ?? "").trim();
  return value || undefined;
}
