import assert from "node:assert/strict";
import test from "node:test";
import { validateTransferFile, validateUploadedFile } from "./file-security.js";

test("accepts supported text and verifies format", () => {
  assert.deepEqual(
    validateUploadedFile("policy.md", "text/markdown", Buffer.from("temporary policy")),
    { format: "markdown", extension: ".md" }
  );
});

test("rejects traversal, MIME mismatch, bad magic and binary text", () => {
  assert.throws(() => validateUploadedFile("../policy.txt", "text/plain", Buffer.from("x")), /filename/i);
  assert.throws(() => validateUploadedFile("policy.pdf", "text/plain", Buffer.from("%PDF-1.7")), /unsupported/i);
  assert.throws(() => validateUploadedFile("policy.pdf", "application/pdf", Buffer.from("not a pdf")), /magic/i);
  assert.throws(() => validateUploadedFile("policy.txt", "text/plain", Buffer.from([0x61, 0, 0x62])), /NUL/);
});

test("accepts supported transfer files with matching signatures", () => {
  assert.deepEqual(validateTransferFile('clip.mp4','video/mp4',Buffer.from('000000106674797069736f6d00000000','hex')),{extension:'.mp4',mimeType:'video/mp4'});
  assert.throws(()=>validateTransferFile('clip.mp4','video/mp4',Buffer.from('not a video')),/MP4/);
  assert.deepEqual(validateTransferFile("photo.png", "image/png", Buffer.from("89504e470d0a1a0a00", "hex")), {
    extension: ".png", mimeType: "image/png"
  });
  assert.deepEqual(validateTransferFile("details.csv", "text/csv", Buffer.from("order,status\n1,ready")), {
    extension: ".csv", mimeType: "text/csv"
  });
});

test("rejects executable, spoofed image, oversized, and path transfer uploads", () => {
  assert.throws(() => validateTransferFile("payload.exe", "application/octet-stream", Buffer.from("MZ")), /仅支持/);
  assert.throws(() => validateTransferFile("photo.png", "image/png", Buffer.from("not-png")), /PNG/);
  assert.throws(() => validateTransferFile("../photo.jpg", "image/jpeg", Buffer.from([0xff, 0xd8])), /文件名/);
  assert.throws(() => validateTransferFile("huge.txt", "text/plain", Buffer.alloc(25 * 1024 * 1024 + 1, 0x61)), /25 MiB/);
});
