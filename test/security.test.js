import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateFilename, validateUpload, createMalwareScanner } from '../lib/uploads.js';
import { validateTicket, createStore } from '../lib/store.js';
import { acquireProcessLock } from '../lib/process-lock.js';

const details = { machine:'foam', customerName:'QA', department:'Testing', purpose:'Test fixture', quantity:'1', width:'20', length:'24', thickness:'2', neededBy:'No rush' };
const foamFiles = [{ originalName:'design.svg', storedName:'design.svg', size:100 }];
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'mandir-security-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true})); return dir;
}
async function fixture(t, name, bytes) {
  const dir = await directory(t), filename = crypto.randomUUID() + path.extname(name), location = path.join(dir, filename);
  await fs.writeFile(location,bytes);
  return { originalname:name, filename, path:location };
}
const svg = body => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">${body}</svg>`;
const dxf = '0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n0\n20\n0\n11\n24\n21\n12\n0\nENDSEC\n0\nEOF\n';

test('filename allowlist rejects executables, paths, control characters and oversized names', () => {
  for (const name of ['design.html','design.pdf.exe','../design.pdf','dir\\design.pdf','a\0.pdf','a\n.pdf','C:design.svg','x'.repeat(241)+'.pdf','']) assert.throws(() => validateFilename(name));
  assert.equal(validateFilename('Poster final.PDF'),'.pdf');
  assert.equal(validateFilename('photo.JPEG'),'.jpeg');
  assert.equal(validateFilename('transparent.PNG'),'.png');
  assert.equal(validateFilename('large-format.TIFF'),'.tiff');
  assert.equal(validateFilename('drawing.dxf'),'.dxf');
  assert.throws(() => validateFilename('animation.gif'));
});
test('static SVG validates with a content hash; MIME is not trusted', async t => {
  const content = '<?xml version="1.0" encoding="UTF-8"?>\n<!-- Exported by a vector editor -->\n'
    + svg('<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="24" height="24" fill="url(#g)"/>');
  const file = await fixture(t,'design.svg',content);
  file.mimetype = 'application/octet-stream';
  const result = await validateUpload(file);
  assert.equal(result.sha256,crypto.createHash('sha256').update(content).digest('hex'));
  assert.equal(result.size,Buffer.byteLength(content)); assert.equal(result.scan,'not-configured');
});
for (const [label, content] of Object.entries({
  script:svg('<script>alert(1)</script>'),
  event:svg('<rect onload="alert(1)"/>'),
  css:svg('<rect style="fill:red"/>'),
  foreign:svg('<foreignObject><div/></foreignObject>'),
  remote:svg('<rect fill="url(https://example.invalid/image)"/>'),
  cssEscape:svg('<rect fill="u\\72l(//example.invalid/image)"/>'),
  encodedURL:svg('<rect fill="&#117;rl(https://example.invalid/image)"/>'),
  xxe:'<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>'+svg('<text>&x;</text>'),
  stylesheet:'<?xml-stylesheet href="https://example.invalid/a.css"?>'+svg(''),
  cdata:svg('<text><![CDATA[unparsed text]]></text>'),
  broken:svg('<rect>'),
  nonSVG:'<html xmlns="http://www.w3.org/2000/svg"/>',
  deep:svg('<g>'.repeat(101)+'</g>'.repeat(101)),
  token:svg('<path d="'+'0'.repeat(262145)+'"/>'),
  invalidUtf8:Buffer.from([0xff,0xfe,0x3c,0x73]),
})) test(`SVG rejects ${label}`, async t => {
  await assert.rejects(validateUpload(await fixture(t,'bad.svg',content)),error => error.status===400);
});
test('streaming SVG permits a large file made of bounded static elements', async t => {
  const content = svg('<rect x="0" y="0" width="1" height="1"/>'.repeat(30000));
  assert.ok((await validateUpload(await fixture(t,'large.svg',content))).size>1000000);
});
test('ASCII DXF accepts paired finite groups and rejects malformed or non-finite records', async t => {
  assert.equal((await validateUpload(await fixture(t,'valid.dxf',dxf))).validation,'screened-v1');
  for (const content of [dxf.replace('0\nEOF\n',''),dxf.replace('10\n0\n','10\nNaN\n'),dxf.replace('10\n0\n','10\n1e999\n'),dxf.replace('10\n0\n','oops\n0\n'),'AutoCAD Binary DXF\0',dxf+'0\nLINE\n',dxf.replace('0\nENDSEC\n','')]) {
    await assert.rejects(validateUpload(await fixture(t,'bad.dxf',content)),error => error.status===400);
  }
});
test('print-file envelope checks accept supported images and reject spoofed or truncated uploads', async t => {
  for (const [name, content] of [['empty.pdf',''],['fake.pdf','<script>alert(1)</script>'],['cut.pdf','%PDF-1.7\nmissing footer'],['image.jpg',Buffer.from('ffd8ff','hex')],['image.png',Buffer.from('89504e470d0a1a0a','hex')],['image.tif',Buffer.from('49490000','hex')]]) {
    await assert.rejects(validateUpload(await fixture(t,name,content)),error => error.status===400);
  }
  // Envelope success deliberately does NOT mean a complete PDF parse or a malware verdict.
  assert.equal((await validateUpload(await fixture(t,'envelope.pdf','%PDF-1.7\n%%EOF\n'))).scan,'not-configured');
  assert.equal((await validateUpload(await fixture(t,'image.png',Buffer.from('89504e470d0a1a0a0000000049454e44ae426082','hex')))).validation,'screened-v1');
  assert.equal((await validateUpload(await fixture(t,'image.tiff',Buffer.from('49492a0008000000','hex')))).validation,'screened-v1');
});
test('malware screening fails closed when required, unavailable, or rejected', async t => {
  const file = await fixture(t,'safe.svg',svg('<rect width="1" height="1"/>'));
  await assert.rejects(validateUpload(file,{requireScanner:true}),error=>error.status===503);
  await assert.rejects(validateUpload(file,{scanner:async()=>{throw Object.assign(new Error('Unsafe'),{status:400});}}),error=>error.status===400);
  let scanned = '';
  assert.equal((await validateUpload(file,{requireScanner:true,scanner:async file=>{scanned=file;}})).scan,'clean');
  assert.equal(scanned,file.path);
  assert.throws(()=>createMalwareScanner('clamscan'));
  await assert.rejects(createMalwareScanner('/nonexistent/mandir-clamscan')(file.path),error=>error.status===503);
  // Node is intentionally not a scanner: an unsupported invocation must never count as clean.
  await assert.rejects(createMalwareScanner(process.execPath)(file.path),error=>error.status===503);
});
test('ticket numeric validation rejects coercion, invalid units and unsafe dimensions', () => {
  for (const value of [true,false,null,[],['2'],{},'0x10','1e2','Infinity','NaN','-1','0','0.009',Infinity,NaN]) {
    assert.throws(()=>validateTicket({...details,width:value},foamFiles), undefined, String(value));
  }
  for (const body of [null,undefined,[],{}, {...details,machine:['foam']}, {...details,unit:'mm'}, {...details,quantity:'1.5'}, {...details,quantity:'10001'}]) assert.throws(()=>validateTicket(body,[]));
  assert.equal(validateTicket({...details,width:'.01'},foamFiles).width,0.01);
  assert.equal(validateTicket({...details,width:' '},foamFiles).width,0);
  assert.equal(validateTicket({...details,unit:'in'},foamFiles).unit,'in');
  const print = {...details,machine:'printer',paperType:'Glossy',width:'24'};
  const printFiles = [{ originalName: 'poster.pdf' }];
  assert.equal(validateTicket(print,printFiles).width,24);
  assert.throws(()=>validateTicket({...print,width:'24.0001'},printFiles));
});
test('two staff updates using the same revision cannot overwrite each other', async t => {
  const store = await createStore(await directory(t));
  const {ticket} = await store.create(validateTicket(details,foamFiles),'request-1');
  const results = await Promise.allSettled([store.update(ticket.id,'ready',1),store.update(ticket.id,'cancelled',1)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
  assert.equal(store.list()[0].revision,2); assert.equal(store.list()[0].history.length,2);
});
test('idempotency checks design bytes and details, while ignoring random storage names', async t => {
  const store = await createStore(await directory(t));
  const ticket = validateTicket(details,[{originalName:'a.svg',storedName:'first',size:10,sha256:'hash1'}]);
  await store.create(ticket,'key');
  assert.equal((await store.create({...ticket,files:[{...ticket.files[0],storedName:'second'}]},'key')).duplicate,true);
  await assert.rejects(store.create({...ticket,quantity:2},'key'),error=>error.status===409);
  await assert.rejects(store.create({...ticket,files:[{...ticket.files[0],sha256:'hash2'}]},'key'),error=>error.status===409);
  assert.equal(store.list().length,1);
  assert.equal((await store.create(ticket,'another')).ticket.ticketNumber,'F-0002');
});
test('legacy numbered tickets cannot have their sequence accidentally reused', async t => {
  const dir = await directory(t);
  await fs.writeFile(path.join(dir,'tickets.json'),JSON.stringify([{...validateTicket(details,foamFiles),id:'legacy',ticketNumber:'F-0042',status:'queued'}]));
  const store = await createStore(dir);
  assert.equal((await store.create(validateTicket(details,foamFiles),'new')).ticket.ticketNumber,'F-0043');
});
test('data directory lock rejects a second server and can be released cleanly', async t => {
  const dir = await directory(t), release = acquireProcessLock(dir);
  assert.throws(()=>acquireProcessLock(dir),/locked/);
  release(); release();
  const nextRelease = acquireProcessLock(dir); nextRelease();
});
