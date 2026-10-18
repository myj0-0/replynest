import test from 'node:test';import assert from 'node:assert/strict';
import {documentSettings,documentScopeSql} from './knowledge-document-core.js';
const now=new Date('2026-10-14T00:00:00Z'),base={document_kind:'temporary',valid_from:'2026-10-14T08:00:00+08:00',valid_until:'2026-10-20T08:00:00+08:00',scope:{channels:['web_chat']},requires_human_approval:true};
test('both document categories require explicit future end and zoned timestamps',()=>{
 assert.equal(documentSettings(base,now).valid_from,now.toISOString());assert.equal(documentSettings({...base,document_kind:'long_term'},now).document_kind,'long_term');
 for(const change of [{valid_until:null},{valid_until:base.valid_from},{valid_until:'2026-10-13T00:00:00Z'},{valid_from:'2026-02-31T08:00:00Z'},{valid_until:'2026-10-20T08:00:00'},{document_kind:'forever'}])assert.throws(()=>documentSettings({...base,...change},now));
});
test('scope only supports bounded structured arrays, not instructions or arbitrary keys',()=>{
 for(const scope of [{channels:'all'},{unknown:['x']},{channels:Array(21).fill('x')},{channels:['']},{channels:[{}]}])assert.throws(()=>documentSettings({...base,scope},now));
 assert.deepEqual(documentSettings({...base,scope:{channels:['web_chat','web_chat']}},now).scope,{channels:['web_chat']});
});
test('scope SQL fails closed on missing contextual values and supports human-review exclusion',()=>{
 const saved=process.env.KNOWLEDGE_DOCUMENT_CONTROLS_ENABLED;process.env.KNOWLEDGE_DOCUMENT_CONTROLS_ENABLED='true';
 try{const sql=documentScopeSql('d','$4::jsonb',true);assert.match(sql,/requires_human_approval=FALSE/);assert.match(sql,/NOT COALESCE/);assert.match(sql,/sku_id/);assert.throws(()=>documentScopeSql('d;DROP TABLE x','$4::jsonb'));}finally{if(saved===undefined)delete process.env.KNOWLEDGE_DOCUMENT_CONTROLS_ENABLED;else process.env.KNOWLEDGE_DOCUMENT_CONTROLS_ENABLED=saved;}
});
