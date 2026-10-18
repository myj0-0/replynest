import {parentPort,workerData} from 'node:worker_threads';
import {getQuickJS} from 'quickjs-emscripten';
// No host functions, module loader, filesystem, network or Node objects are exposed to guest code.
const engine=await getQuickJS(),runtime=engine.newRuntime();
runtime.setMemoryLimit(16*1024*1024);runtime.setMaxStackSize(256*1024);
const deadline=Date.now()+500;let interrupted=false;
runtime.setInterruptHandler(()=>{interrupted=Date.now()>deadline;return interrupted;});
const vm=runtime.newContext();
try{
 const input=vm.newString(workerData.input);vm.setProp(vm.global,'__inputJson',input);input.dispose();
 // Serialize INSIDE the bounded guest; never traverse a guest object in the host.
 const result=vm.evalCode(`(function(){'use strict';const stringify=JSON.stringify;const input=JSON.parse(__inputJson);delete globalThis.__inputJson;const result=(function(input){'use strict';\n${workerData.source}\n})(input);if(result&&typeof result.then==='function')throw Error('async_not_supported');const json=stringify(result);if(typeof json!=='string'||json.length>32768)throw Error('output_limit');return json;})()`,'tenant-script.js');
 if(result.error){result.error.dispose();parentPort.postMessage({error:interrupted?'code_timeout':'code_execution_failed'});}
 else {const json=vm.getString(result.value);result.value.dispose();if(Buffer.byteLength(json)>32768)parentPort.postMessage({error:'code_output_limit'});else parentPort.postMessage({json});}
}catch{parentPort.postMessage({error:'code_resource_limit'});}finally{vm.dispose();runtime.dispose();}
