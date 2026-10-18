import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { secretValue } from "./secret-value.js";

test("secret file takes precedence during env-to-file migration", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "replynest-secret-"));
  const fileName = path.join(directory, "provider-key");
  const previousValue = process.env.TEST_PROVIDER_KEY;
  const previousFile = process.env.TEST_PROVIDER_KEY_FILE;
  try {
    writeFileSync(fileName, "from-file\n", { mode: 0o600 });
    process.env.TEST_PROVIDER_KEY = "legacy-env";
    process.env.TEST_PROVIDER_KEY_FILE = fileName;
    assert.equal(secretValue("TEST_PROVIDER_KEY"), "from-file");
  } finally {
    if (previousValue === undefined) delete process.env.TEST_PROVIDER_KEY; else process.env.TEST_PROVIDER_KEY = previousValue;
    if (previousFile === undefined) delete process.env.TEST_PROVIDER_KEY_FILE; else process.env.TEST_PROVIDER_KEY_FILE = previousFile;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("secret resolver rejects relative file paths without exposing values", () => {
  const previousFile = process.env.TEST_PROVIDER_KEY_FILE;
  try {
    process.env.TEST_PROVIDER_KEY_FILE = "relative-secret";
    assert.throws(() => secretValue("TEST_PROVIDER_KEY"), /absolute path/);
  } finally {
    if (previousFile === undefined) delete process.env.TEST_PROVIDER_KEY_FILE; else process.env.TEST_PROVIDER_KEY_FILE = previousFile;
  }
});
