const {test} = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('../vendor/jszip.min.js');
const {checkZip,resolve,escape} = require('../browser-epub.js');

test('EPUB resource paths resolve relative links and reject archive escapes',()=>{
  assert.equal(resolve('OPS/Text/chapter.xhtml','../Images/a%20b.jpg'), 'OPS/Images/a b.jpg');
  assert.equal(resolve('OPS/Text/chapter.xhtml','next.xhtml#one'),'OPS/Text/next.xhtml');
  for(const href of ['../../../secret','https://example.com/a','//example.com/a','/etc/passwd','..\\x']) assert.throws(()=>resolve('OPS/chapter.xhtml',href));
});
test('ZIP preflight accepts normal archives and rejects invalid or oversized inputs',async()=>{
  const zip=new JSZip(); zip.file('mimetype','application/epub+zip'); zip.file('chapter.xhtml','Hello');
  const buffer=await zip.generateAsync({type:'arraybuffer'});
  assert.equal(checkZip(buffer),2);
  assert.throws(()=>checkZip(new ArrayBuffer(12)));
  const damaged=buffer.slice(0); const view=new DataView(damaged);
  for(let i=0;i<damaged.byteLength-46;i++)if(view.getUint32(i,true)===0x02014b50){view.setUint32(i+24,600*1024*1024,true);break;}
  assert.throws(()=>checkZip(damaged),/large/);
});
test('ZIP preflight rejects unsafe paths before decompression',async()=>{
  const zip=new JSZip();zip.file('../secret','data');
  const buffer=await zip.generateAsync({type:'arraybuffer'});
  assert.throws(()=>checkZip(buffer),/Unsafe/);
});
test('notebook output escapes markup',()=>assert.equal(escape('<script>"&'), '&lt;script&gt;&quot;&amp;'));
