import test from 'node:test';
import assert from 'node:assert/strict';
import {brandedMail,mailBrand} from './mail-brand.js';
import {mailMimeBody} from './smtp-mailer.js';
test('brand includes identity and safe text/link HTML, no executable user HTML',()=>{
 const m=brandedMail({to:'test@example.invalid',subject:'欢迎 <script>',text:'<img src=x onerror=alert(1)>\nhttps://console.replynest.cn/invite?token=abc&test=1'});
 assert(m.html?.includes('&lt;img'));assert(!m.html?.includes('<script>'));assert(m.html?.includes('token=abc&amp;test=1'));assert(m.text.includes(mailBrand.contact));assert(m.html?.includes(mailBrand.logo));assert.equal(m.replyTo,mailBrand.contact);
 const mime=mailMimeBody(m);assert(mime.headers.includes('multipart/alternative'));assert(mime.body.includes(Buffer.from(m.text).toString('base64').slice(0,60)));assert(mime.body.includes('text/html'));
});
