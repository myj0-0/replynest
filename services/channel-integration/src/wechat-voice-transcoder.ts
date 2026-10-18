import {spawn} from 'node:child_process';
import type {MediaFile} from './wechat-media-adapter.js';

export const voiceTranscodeLimits={inputBytes:10*1024*1024,outputBytes:2*1024*1024,wallMs:15000,memoryBytes:384*1024*1024,cpuSeconds:8,durationSeconds:90} as const;
/** Only pre-scanned bytes reach a decoder. Pipes only: no filesystem or network protocols. */
export async function playableWechatVoice(file:MediaFile):Promise<MediaFile>{
  if(!['audio/amr','audio/speex'].includes(file.mimeType))return file;
  if(!file.bytes.length||file.bytes.length>voiceTranscodeLimits.inputBytes)throw Error('wechat_voice_size');
  return new Promise((resolve,reject)=>{
    const child=spawn('/usr/bin/prlimit',[
      `--as=${voiceTranscodeLimits.memoryBytes}`,`--cpu=${voiceTranscodeLimits.cpuSeconds}`,'--core=0','--nofile=64','--',
      '/usr/bin/ffmpeg','-hide_banner','-loglevel','error','-nostdin','-threads','1',
      '-protocol_whitelist','pipe','-max_alloc','33554432','-f',file.mimeType==='audio/amr'?'amr':'ogg','-i','pipe:0','-map','0:a:0','-vn','-sn','-dn',
      '-t',String(voiceTranscodeLimits.durationSeconds),'-threads','1','-ac','1','-ar','16000',
      '-c:a','libmp3lame','-b:a','32k','-map_metadata','-1','-f','mp3','pipe:1'
    ],{shell:false,env:{PATH:'/usr/bin:/bin',LANG:'C'},stdio:['pipe','pipe','pipe']});
    let settled=false,total=0;const chunks:Buffer[]=[];
    const fail=()=>{if(settled)return;settled=true;clearTimeout(timer);child.kill('SIGKILL');reject(Error('wechat_voice_transcode_failed'));};
    const timer=setTimeout(fail,voiceTranscodeLimits.wallMs);
    child.on('error',fail);child.stdin.on('error',()=>{});child.stdout.on('error',fail);
    child.stderr.resume(); // Decoder diagnostics may contain content: never persist or emit them.
    child.stdout.on('data',(chunk:Buffer)=>{total+=chunk.length;if(total>voiceTranscodeLimits.outputBytes)fail();else chunks.push(chunk);});
    child.on('close',code=>{
      if(settled)return;
      if(code!==0||total<128)return fail();
      const bytes=Buffer.concat(chunks,total);
      if(bytes.subarray(0,3).toString()!=='ID3'&&!(bytes[0]===255&&(bytes[1]&0xe0)===0xe0))return fail();
      settled=true;clearTimeout(timer);resolve({bytes,mimeType:'audio/mpeg',extension:'.mp3',fileName:'微信语音.mp3'});
    });
    child.stdin.end(file.bytes);
  });
}
