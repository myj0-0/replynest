import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {timingSafeEqual} from 'node:crypto';
import {execute} from './runner.mjs';
const token=readFileSync(process.env.RUNNER_TOKEN_FILE,'utf8').trim();if(token.length<32)throw Error('runner_token_required');
let running=false;
const server=createServer(async(req,res)=>{
 const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
 if(req.url==='/health'&&req.method==='GET')return send(200,{healthy:true});
 const auth=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+token);
 if(auth.length!==expected.length||!timingSafeEqual(auth,expected))return send(403,{error:'forbidden'});
 if(req.url!=='/execute'||req.method!=='POST')return send(404,{error:'not_found'});
 if(running)return send(429,{error:'code_runner_busy'});
 running=true;
 try{
  let bytes=0;const parts=[];for await(const part of req){bytes+=part.length;if(bytes>65536){send(413,{error:'code_input_limit'});req.destroy();return;}parts.push(part);}
  const body=JSON.parse(Buffer.concat(parts).toString('utf8'));if(Object.keys(body).some(k=>!['source','input'].includes(k)))return send(400,{error:'invalid_request'});
  send(200,await execute(body.source,body.input));
 }catch{if(!res.headersSent)send(400,{error:'invalid_request'});}finally{running=false;}
});
server.requestTimeout=3000;server.headersTimeout=3000;server.timeout=5000;server.maxConnections=8;
server.listen(3108,'0.0.0.0');
