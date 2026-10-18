// Execute the server-only XLSX importer, not ExcelJS's prebundled browser build.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const require=createRequire(new URL('../apps/console/package.json',import.meta.url));
const ExcelJS=require('exceljs'),ts=require('typescript');
const excelRequire=createRequire(require.resolve('exceljs'));
const uuid=excelRequire('uuid');
const code=ts.transpileModule(readFileSync(new URL('../apps/console/lib/quick-reply-import.ts',import.meta.url),'utf8'),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}
}).outputText;
const module={exports:{}};
vm.runInNewContext(code,{exports:module.exports,require});
const {parseQuickReplyWorkbook,parseQuickReplyMarkdown}=module.exports;
const plain=value=>JSON.parse(JSON.stringify(value));
async function workbook(rows){
 const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('快捷回复');
 rows.forEach(row=>sheet.addRow(row));
 // Extended conditional formatting exercises ExcelJS's actual require('uuid').v4.
 sheet.addConditionalFormatting({ref:'A2:A3',rules:[{type:'iconSet',iconSet:'3Stars',cfvo:[{type:'percent',value:0},{type:'percent',value:33},{type:'percent',value:67}]}]});
 const bytes=await book.xlsx.writeBuffer();return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
}
test('ExcelJS uses the fixed CJS uuid API, including bounded caller-provided buffers',()=>{
 assert.equal(excelRequire('uuid/package.json').version,'11.1.1');
 assert.equal(uuid.version(uuid.v4()),4);
 const short=Buffer.alloc(15,7),original=Buffer.from(short);
 assert.throws(()=>uuid.v5('synthetic',uuid.v5.DNS,short),RangeError);
 assert.deepEqual(short,original);
 assert.throws(()=>uuid.v3('synthetic',uuid.v3.DNS,Buffer.alloc(16),1),RangeError);
});
test('actual XLSX write/read and shortcut import preserve Chinese, emoji and multiline text',async()=>{
 const rows=[['shortcut','title','content'],['/shipping','发货 🚚','第一行\n第二行'],['/return','退货说明','仅为合成验收']];
 const actual=plain(await parseQuickReplyWorkbook(await workbook(rows)));
 assert.deepEqual(actual,[{shortcut:'/shipping',title:'发货 🚚',content:'第一行\n第二行'},{shortcut:'/return',title:'退货说明',content:'仅为合成验收'}]);
 assert.deepEqual(plain(parseQuickReplyMarkdown('| shortcut | title | content |\n| /test | 测试 | 第一行<br>第二行 |')),[{shortcut:'/test',title:'测试',content:'第一行\n第二行'}]);
});
test('XLSX importer retains header, empty-field, row-count and malformed-file rejection',async()=>{
 await assert.rejects(parseQuickReplyWorkbook(await workbook([['wrong','title','content'],['a','b','c']])),/表头/);
 await assert.rejects(parseQuickReplyWorkbook(await workbook([['shortcut','title','content'],['/test','','text']])),/空字段/);
 await assert.rejects(parseQuickReplyWorkbook(await workbook([['shortcut','title','content'],...Array.from({length:501},(_,i)=>['/'+i,'title','text'])])),/500/);
 await assert.rejects(parseQuickReplyWorkbook(new ArrayBuffer(8)));
});
