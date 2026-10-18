import test from 'node:test';import assert from 'node:assert/strict';import {mediaByteRange} from './media-byte-range.js';
test('media ranges permit bounded seek, reject malformed and multipart ranges',()=>{
  assert.equal(mediaByteRange(undefined,100),undefined);
  assert.deepEqual(mediaByteRange('bytes=10-19',100),{start:10,end:19});
  assert.deepEqual(mediaByteRange('bytes=95-',100),{start:95,end:99});
  assert.deepEqual(mediaByteRange('bytes=-10',100),{start:90,end:99});
  assert.deepEqual(mediaByteRange('bytes=0-999',100),{start:0,end:99});
  for(const raw of ['bytes=','bytes=-0','bytes=100-','bytes=5-4','bytes=0-1,4-5','bytes=999999999999999999-'])assert.equal(mediaByteRange(raw,100),null);
});
