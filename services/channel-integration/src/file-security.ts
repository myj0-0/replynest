import net from "node:net";
import path from "node:path";

export type UploadedFormat = "text" | "markdown" | "pdf" | "docx";

export type TransferFile = { extension: string; mimeType: string };

const allowed: Record<string, { format: UploadedFormat; mime: string[] }> = {
  ".txt": { format: "text", mime: ["text/plain", "application/octet-stream"] },
  ".md": { format: "markdown", mime: ["text/markdown", "text/plain", "application/octet-stream"] },
  ".pdf": { format: "pdf", mime: ["application/pdf", "application/octet-stream"] },
  ".docx": { format: "docx", mime: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/zip", "application/octet-stream"] }
};

export function validateUploadedFile(filename: string, mimeType: string, data: Buffer): { format: UploadedFormat; extension: string } {
  if (!filename || filename.length > 200 || filename.includes("\0") || path.basename(filename) !== filename) throw new Error("Invalid filename");
  if (!data.length || data.length > 10 * 1024 * 1024) throw new Error("File must be between 1 byte and 10 MiB");
  const extension = path.extname(filename).toLowerCase();
  const rule = allowed[extension];
  if (!rule || !rule.mime.includes(mimeType.toLowerCase())) throw new Error("Unsupported file type or MIME mismatch");
  if (rule.format === "pdf" && data.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("PDF magic bytes mismatch");
  if (rule.format === "docx" && !(data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04)) throw new Error("DOCX ZIP magic bytes mismatch");
  if ((rule.format === "text" || rule.format === "markdown") && data.includes(0)) throw new Error("Text file contains NUL bytes");
  return { format: rule.format, extension };
}

const transferAllowed: Record<string, string[]> = {
  ".jpg": ["image/jpeg"], ".jpeg": ["image/jpeg"], ".png": ["image/png"],
  ".gif": ["image/gif"], ".webp": ["image/webp"], ".pdf": ["application/pdf"],
  ".mp4": ["video/mp4"],
  ".txt": ["text/plain", "application/octet-stream"], ".md": ["text/markdown", "text/plain", "application/octet-stream"],
  ".csv": ["text/csv", "text/plain", "application/vnd.ms-excel", "application/octet-stream"],
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/zip", "application/octet-stream"],
  ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/zip", "application/octet-stream"]
};

export function validateTransferFile(filename: string, mimeType: string, data: Buffer): TransferFile {
  if (!filename || filename.length > 180 || filename.includes("\0") || path.basename(filename) !== filename) throw new Error("文件名不合法");
  if (!data.length || data.length > 25 * 1024 * 1024) throw new Error("文件大小必须在 1 字节至 25 MiB 之间");
  const extension = path.extname(filename).toLowerCase();
  const normalizedMime = mimeType.toLowerCase().split(";", 1)[0].trim() || "application/octet-stream";
  const accepted = transferAllowed[extension];
  if (!accepted?.includes(normalizedMime)) throw new Error("仅支持常用图片、MP4 视频、PDF、文本、Markdown、CSV、DOCX 和 XLSX 文件");
  const zip = data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
  if ([".docx", ".xlsx"].includes(extension) && !zip) throw new Error("Office 文件格式与扩展名不匹配");
  if (extension === ".pdf" && data.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("PDF 文件格式与扩展名不匹配");
  if ([".txt", ".md", ".csv"].includes(extension) && data.includes(0)) throw new Error("文本文件包含不允许的二进制内容");
  if ([".jpg", ".jpeg"].includes(extension) && !(data[0] === 0xff && data[1] === 0xd8)) throw new Error("JPEG 文件格式与扩展名不匹配");
  if (extension === ".png" && data.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("PNG 文件格式与扩展名不匹配");
  if (extension === ".gif" && !["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii"))) throw new Error("GIF 文件格式与扩展名不匹配");
  if (extension === ".webp" && !(data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP")) throw new Error("WebP 文件格式与扩展名不匹配");
  if(extension==='.mp4'&&(data.length<16||data.subarray(4,8).toString()!=='ftyp'||data.readUInt32BE(0)<16||data.readUInt32BE(0)>data.length||!['isom','iso2','mp41','mp42','avc1','M4V ','qt  '].includes(data.subarray(8,12).toString())))throw Error('MP4 文件格式与扩展名不匹配');
  return { extension, mimeType: normalizedMime };
}

export async function scanWithClamAv(data: Buffer): Promise<{ clean: boolean; result: string }> {
  const host = process.env.CLAMAV_HOST ?? "clamav";
  const port = Number(process.env.CLAMAV_PORT ?? 3310);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const response: Buffer[] = [];
    const timeout = setTimeout(() => socket.destroy(new Error("ClamAV scan timed out")), 30_000);
    socket.on("connect", () => {
      socket.write(Buffer.from("zINSTREAM\0"));
      for (let offset = 0; offset < data.length; offset += 64 * 1024) {
        const chunk = data.subarray(offset, Math.min(offset + 64 * 1024, data.length));
        const size = Buffer.alloc(4);
        size.writeUInt32BE(chunk.length);
        socket.write(size);
        socket.write(chunk);
      }
      socket.end(Buffer.alloc(4));
    });
    socket.on("data", chunk => response.push(chunk));
    socket.on("error", error => { clearTimeout(timeout); reject(error); });
    socket.on("close", hadError => {
      clearTimeout(timeout);
      if (hadError) return;
      const result = Buffer.concat(response).toString("utf8").replace(/\0/g, "").trim();
      if (result.endsWith("OK")) resolve({ clean: true, result: "OK" });
      else if (result.includes("FOUND")) resolve({ clean: false, result: result.slice(0, 300) });
      else reject(new Error(`Unexpected ClamAV response: ${result.slice(0, 200)}`));
    });
  });
}
