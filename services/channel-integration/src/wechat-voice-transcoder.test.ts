import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {playableWechatVoice,voiceTranscodeLimits} from './wechat-voice-transcoder.js';
test('voice conversion rejects oversized input and preserves already playable media',async()=>{
  const file={bytes:Buffer.from('ID3ready'),mimeType:'audio/mpeg',fileName:'voice.mp3',extension:'.mp3'};
  assert.equal(await playableWechatVoice(file),file);
  await assert.rejects(playableWechatVoice({...file,mimeType:'audio/amr',bytes:Buffer.alloc(voiceTranscodeLimits.inputBytes+1)}),/wechat_voice_size/);
});
test('bounded Linux decoder produces browser MP3 from synthetic AMR; malformed AMR fails closed',{skip:process.env.WECHAT_VOICE_DECODER_TEST!=='true'},async()=>{
  const decoders=execFileSync('/usr/bin/ffmpeg',['-hide_banner','-decoders'],{maxBuffer:1024*1024,timeout:10000}).toString();
  for(const codec of ['amrnb','amrwb','speex'])assert.match(decoders,new RegExp('\\b'+codec+'\\b'));
  // Fifty synthetically constructed 20 ms AMR-NB frames; no customer's recording.
  const amr=Buffer.concat([Buffer.from('#!AMR\n'),...Array.from({length:50},()=>Buffer.from([4,...Array(12).fill(0)]))]);
  const result=await playableWechatVoice({bytes:amr,mimeType:'audio/amr',fileName:'voice.amr',extension:'.amr'});
  assert.equal(result.mimeType,'audio/mpeg');assert(result.bytes.length>128&&result.bytes.length<20000);
  const pcm=execFileSync('/usr/bin/ffmpeg',['-hide_banner','-loglevel','error','-i','pipe:0','-f','s16le','pipe:1'],{input:result.bytes,maxBuffer:1024*1024,timeout:10000});
  assert(pcm.length>25000&&pcm.length<40000);
  await assert.rejects(playableWechatVoice({bytes:Buffer.from('#!AMR\nnot-audio'),mimeType:'audio/amr',fileName:'bad.amr',extension:'.amr'}),/wechat_voice_transcode_failed/);
});
