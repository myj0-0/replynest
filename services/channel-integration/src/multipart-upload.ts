import busboy from "busboy";
import type { IncomingMessage } from "node:http";

export type MultipartKnowledgeUpload = {
  title: string;
  sourceType: string;
  filename: string;
  mimeType: string;
  data: Buffer;
  settings?:Record<string,unknown>;
};

export type MultipartSingleFile = { filename: string; mimeType: string; data: Buffer };

export async function readSingleFileMultipart(request: IncomingMessage, maximumBytes = 25 * 1024 * 1024): Promise<MultipartSingleFile> {
  return new Promise((resolve, reject) => {
    let parser;
    try { parser = busboy({ headers: request.headers, defParamCharset: "utf8", limits: { files: 1, fileSize: maximumBytes, fields: 2, fieldSize: 1024 } }); }
    catch (error) { reject(error); return; }
    let filename = ""; let mimeType = ""; let fileSeen = false; let limited = false;
    const chunks: Buffer[] = [];
    parser.on("file", (name, stream, info) => {
      if (name !== "file" || fileSeen) { stream.resume(); return; }
      fileSeen = true; filename = info.filename; mimeType = info.mimeType;
      stream.on("limit", () => { limited = true; });
      stream.on("data", chunk => chunks.push(Buffer.from(chunk)));
    });
    parser.on("filesLimit", () => { limited = true; });
    parser.on("error", reject);
    parser.on("close", () => {
      if (limited) return reject(new Error("文件超过 25 MiB 限制"));
      if (!fileSeen) return reject(new Error("缺少 file 文件字段"));
      resolve({ filename, mimeType, data: Buffer.concat(chunks) });
    });
    request.pipe(parser);
  });
}

export async function readKnowledgeMultipart(request: IncomingMessage): Promise<MultipartKnowledgeUpload> {
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = busboy({ headers: request.headers, defParamCharset: "utf8", limits: { files: 1, fileSize: 10 * 1024 * 1024, fields: 4, fieldSize: 16384 } });
    } catch (error) {
      reject(error);
      return;
    }
    const fields: Record<string, string> = {};
    let filename = "";
    let mimeType = "";
    const chunks: Buffer[] = [];
    let fileSeen = false;
    let limited = false;
    parser.on("field", (name, value,info) => {if(info.valueTruncated)limited=true; if (["title", "source_type","document_settings"].includes(name)){if(Object.hasOwn(fields,name))limited=true;fields[name] = value;} });
    parser.on("file", (name, stream, info) => {
      if (name !== "file" || fileSeen) { stream.resume(); return; }
      fileSeen = true;
      filename = info.filename;
      mimeType = info.mimeType;
      stream.on("limit", () => { limited = true; });
      stream.on("data", chunk => chunks.push(Buffer.from(chunk)));
    });
    parser.on("filesLimit", () => { limited = true; });
    parser.on("error", reject);
    parser.on("close", () => {
      if (limited) return reject(new Error("Multipart file exceeds limits"));
      if (!fileSeen) return reject(new Error("Multipart field 'file' is required"));
      let settings;try{settings=fields.document_settings?JSON.parse(fields.document_settings):undefined;}catch{return reject(new Error('Invalid document settings'));}
      resolve({
        title: String(fields.title ?? "").trim(),
        sourceType: String(fields.source_type ?? "knowledge").trim(),
        filename,
        mimeType,
        data: Buffer.concat(chunks),settings
      });
    });
    request.pipe(parser);
  });
}
