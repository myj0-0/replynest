import test from 'node:test';
import assert from 'node:assert/strict';
import type {PoolClient} from 'pg';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
import {automaticKnowledgeAuthorized,KNOWLEDGE_SEND_DISCLOSURE_VERSION,KNOWLEDGE_WECHAT_DISCLOSURE_VERSION,
 automaticSemanticKnowledgeAuthorized,SEMANTIC_KNOWLEDGE_SEND_DISCLOSURE_VERSION,SEMANTIC_KNOWLEDGE_WECHAT_DISCLOSURE_VERSION} from './automatic-knowledge-consent.js';
const lease={tenantId:'a',accountId:'1',authorizationId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',channel:'web_chat'} as AutomaticReceptionLease;
test('published knowledge requires current tenant and primary disclosure; website consent never implies WeChat consent',async()=>{
 const queries:Array<{sql:string;values:unknown[]}>=[];
 const db={query:async(sql:string,values:unknown[])=>{queries.push({sql,values});return {rowCount:queries.length===1?1:0};}} as unknown as Pick<PoolClient,'query'>;
 assert.equal(await automaticKnowledgeAuthorized(db,lease,true),true);
 assert.deepEqual(queries[0].values,[lease.tenantId,lease.accountId,lease.authorizationId,'automatic-send-v1',[KNOWLEDGE_SEND_DISCLOSURE_VERSION,SEMANTIC_KNOWLEDGE_SEND_DISCLOSURE_VERSION]]);
 assert.match(queries[0].sql,/a.resource_id=g.authorization_id/);assert.match(queries[0].sql,/a.actor_id::text=g.actor_id/);assert.match(queries[0].sql,/FOR SHARE/);
 queries.length=0;assert.equal(await automaticKnowledgeAuthorized(db,{...lease,channel:'shared_wechat'},true),false);
 assert.equal(queries.length,2);assert.deepEqual(queries[1].values[3],[KNOWLEDGE_WECHAT_DISCLOSURE_VERSION,SEMANTIC_KNOWLEDGE_WECHAT_DISCLOSURE_VERSION]);assert.match(queries[1].sql,/a.grant_id=g.grant_id/);
});
test('old or missing primary disclosure stops before looking up any secondary channel',async()=>{
 let reads=0;const db={query:async()=>{reads++;return {rowCount:0};}} as unknown as Pick<PoolClient,'query'>;
 assert.equal(await automaticKnowledgeAuthorized(db,{...lease,channel:'shared_wechat'}),false);assert.equal(reads,1);
});
test('long prose retrieval requires separate v3 disclosure; v2 FAQ is not silently broadened',async()=>{
 const values:unknown[][]=[];
 const db={query:async(_sql:string,args:unknown[])=>{values.push(args);return {rowCount:(args.at(-1) as string[]).includes(KNOWLEDGE_SEND_DISCLOSURE_VERSION)?1:0};}} as unknown as Pick<PoolClient,'query'>;
 assert.equal(await automaticKnowledgeAuthorized(db,lease),true);
 assert.equal(await automaticSemanticKnowledgeAuthorized(db,lease),false);assert.deepEqual(values.at(-1)!.at(-1),[SEMANTIC_KNOWLEDGE_SEND_DISCLOSURE_VERSION]);
 values.length=0;
 const confirmed={query:async(_sql:string,args:unknown[])=>{values.push(args);return {rowCount:1};}} as unknown as Pick<PoolClient,'query'>;
 assert.equal(await automaticSemanticKnowledgeAuthorized(confirmed,{...lease,channel:'shared_wechat'},true),true);
 assert.deepEqual(values[1].at(-1),[SEMANTIC_KNOWLEDGE_WECHAT_DISCLOSURE_VERSION]);
});
