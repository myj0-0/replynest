import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildStorageKey, cleanStorageKey, prepareCleanCopy, readStored, removeStored, storeQuarantined } from "./file-storage.js";

test("new uploads are tenant-scoped under quarantine", () => {
  assert.equal(buildStorageKey("tenant/demo", "doc-1", ".PDF"), "quarantine/tenant_demo/doc-1/source.pdf");
});

test("clean storage promotion is deterministic and idempotent", () => {
  assert.equal(cleanStorageKey("quarantine/tenant/doc/source.pdf"), "clean/tenant/doc/source.pdf");
  assert.equal(cleanStorageKey("clean/tenant/doc/source.pdf"), "clean/tenant/doc/source.pdf");
  assert.throws(() => cleanStorageKey("../secret"));
});

test("filesystem storage copies a scanned object before quarantine removal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "replynest-storage-"));
  const previousRoot = process.env.KNOWLEDGE_STORAGE_ROOT;
  const previousProvider = process.env.KNOWLEDGE_STORAGE_PROVIDER;
  process.env.KNOWLEDGE_STORAGE_ROOT = root;
  process.env.KNOWLEDGE_STORAGE_PROVIDER = "filesystem";
  try {
    const quarantine = buildStorageKey("tenant", "doc", ".txt");
    await storeQuarantined(quarantine, Buffer.from("synthetic"));
    const clean = await prepareCleanCopy(quarantine);
    assert.equal((await readStored(clean)).toString(), "synthetic");
    assert.equal((await readStored(quarantine)).toString(), "synthetic");
    await removeStored(quarantine);
    await assert.rejects(() => readStored(quarantine));
  } finally {
    if (previousRoot === undefined) delete process.env.KNOWLEDGE_STORAGE_ROOT; else process.env.KNOWLEDGE_STORAGE_ROOT = previousRoot;
    if (previousProvider === undefined) delete process.env.KNOWLEDGE_STORAGE_PROVIDER; else process.env.KNOWLEDGE_STORAGE_PROVIDER = previousProvider;
    await rm(root, { recursive: true, force: true });
  }
});
