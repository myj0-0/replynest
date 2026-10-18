import test from 'node:test';
import assert from 'node:assert/strict';
import { generateExtension } from './extension-qwen.js';
import { exampleDefinition } from './extension-core.js';
import { appCapabilities, capabilityVersion } from './extension-capabilities.js';
const envelope={kind:'app',capability_version:capabilityVersion,required_capabilities:appCapabilities(exampleDefinition),definition:exampleDefinition};
test('Qwen uses structured output, no tools and bounds request; verifies returned schema',async()=>{
  process.env.EXTENSION_QWEN_API_KEY='test-only';
  try {
    const fake:typeof fetch=async(url,init)=>{
      assert.equal(url,'https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions');
      const request=JSON.parse(String(init?.body));assert.equal(request.enable_thinking,false);assert.equal(request.max_tokens,5000);assert.equal(request.tools,undefined);assert.equal(request.messages.length,2);assert.equal(request.messages[1].content,'synthetic');
      assert.match(request.messages[0].content,/preview_only/);assert.match(request.messages[0].content,/message.broadcast/);
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(envelope)}}],usage:{prompt_tokens:100,completion_tokens:200}}));
    };
    const r=await generateExtension('synthetic',fake);assert.equal(r.definition.schema_version,1);assert.equal(r.output_tokens,200);
    await assert.rejects(generateExtension('synthetic',async()=>new Response('sensitive-key-provider-error',{status:401})),/qwen_request_failed/);
    await assert.rejects(generateExtension('synthetic',async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"code":"unsafe"}'}}]}))),/qwen_invalid_definition/);
    await assert.rejects(generateExtension('synthetic',async()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:JSON.stringify(exampleDefinition)}}]}))),/qwen_invalid_definition/);
    await assert.rejects(generateExtension('synthetic',async()=>new Response('x'.repeat(97000))),/qwen_invalid_response/);
  } finally {delete process.env.EXTENSION_QWEN_API_KEY;}
});
