import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {handleCommunicationsApi} from './communications-api.js';
for (const role of ['tenant_admin','supervisor','agent'] as const) {
  test(`platform diagnostics are not exposed to ${role}`,async()=>{
    const server=createServer((req,res)=>{void handleCommunicationsApi(req,res,new URL(req.url!,'http://localhost'),{role},'test-request');});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
      const address=server.address();assert.ok(address && typeof address !== 'string');
      const response=await fetch(`http://127.0.0.1:${address.port}/api/v1/integrations/communications/diagnostics`);
      assert.equal(response.status,403);
      const body=await response.json() as {data?:unknown;error:{code:string}};
      assert.equal(body.data,undefined);assert.equal(body.error.code,'platform_diagnostics_restricted');
      assert.doesNotMatch(JSON.stringify(body),/smtp|mailgun|endpoint|missing|email_profiles/i);
    } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  });
}
