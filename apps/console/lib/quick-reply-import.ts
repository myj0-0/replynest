import ExcelJS from "exceljs";

export type QuickReplyImportRow = { shortcut: string; title: string; content: string };

function splitMarkdownRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of body) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (character === "|") { cells.push(current.trim()); current = ""; continue; }
    current += character;
  }
  cells.push(current.trim());
  return cells;
}

function rowsFromMatrix(matrix: string[][]): QuickReplyImportRow[] {
  const headerIndex = matrix.findIndex(row => row.map(value => value.trim().toLowerCase()).join("|") === "shortcut|title|content");
  if (headerIndex < 0) throw new Error("找不到 shortcut、title、content 三列表头");
  const rows: QuickReplyImportRow[] = [];
  for (const raw of matrix.slice(headerIndex + 1)) {
    if (raw.length >= 3 && raw.every(value => /^:?-{3,}:?$/.test(value.trim()))) continue;
    const values = raw.slice(0, 3).map(value => value.trim());
    if (values.every(value => !value)) continue;
    if (values.some(value => !value)) throw new Error(`第 ${headerIndex + rows.length + 2} 行存在空字段`);
    rows.push({ shortcut: values[0], title: values[1], content: values[2].replace(/<br\s*\/?>/gi, "\n") });
    if (rows.length > 500) throw new Error("单次最多导入 500 条快捷回复");
  }
  if (!rows.length) throw new Error("模板中没有可导入的快捷回复");
  return rows;
}

export function parseQuickReplyMarkdown(source: string): QuickReplyImportRow[] {
  const matrix = source.replace(/^\uFEFF/, "").split(/\r?\n/).filter(line => line.includes("|")).map(splitMarkdownRow);
  return rowsFromMatrix(matrix);
}

export async function parseQuickReplyWorkbook(bytes: ArrayBuffer): Promise<QuickReplyImportRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("Excel 文件没有工作表");
  const matrix: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, row => {
    matrix.push([1, 2, 3].map(column => row.getCell(column).text.trim()));
  });
  return rowsFromMatrix(matrix);
}
