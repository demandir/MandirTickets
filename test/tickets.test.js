import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { createStore, validateTicket, publicQueue, machines } from '../lib/store.js';
import { createSheetsSync, csv } from '../lib/sheets.js';

const input = { machine:'foam', customerName:'Test Person', department:'Events', purpose:'Stage lettering', phone:'', quantity:'2', width:'20', length:'36', thickness:'2', neededBy:'2099-12-31' };
const foamFiles = [{ originalName:'cut.svg', storedName:'cut.svg', size:100 }];
async function temp(t) { const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mandir-test-')); t.after(()=>fs.rm(dir,{recursive:true,force:true})); return dir; }

test('uses plain-language public machine names', () => {
  assert.deepEqual(machines, { printer:'Poster printing', foam:'Foam cutting' });
});

test('concurrent requests keep every ticket and assign independent, persistent queue numbers', async t => {
  const dir=await temp(t), store=await createStore(dir);
  const details=validateTicket(input,foamFiles);
  const jobs=await Promise.all(Array.from({length:25},(_,i)=>store.create(details,'request-'+i)));
  assert.equal(new Set(jobs.map(j=>j.ticket.ticketNumber)).size,25);
  assert.equal(store.list().length,25);
  const duplicate=await store.create(details,'request-0');
  assert.equal(duplicate.duplicate,true); assert.equal(store.list().length,25);
  const restored=await createStore(dir);
  assert.equal((await restored.create(details,'next')).ticket.ticketNumber,'F-0026');
  const print=validateTicket({...input,machine:'printer',paperType:'Canvas'},[{originalName:'poster.pdf',storedName:'file.pdf',size:100}]);
  assert.equal((await restored.create(print,'print')).ticket.ticketNumber,'P-0001');
});
test('validates department, purpose, printer width, quantity and required artwork files',()=>{
  for(const patch of [{department:''},{purpose:''},{width:'-1'},{quantity:'1.5'},{thickness:'0'},{neededBy:'Invalid'},{neededBy:'2099-02-29'},{neededBy:false}]) assert.throws(()=>validateTicket({...input,...patch},foamFiles));
  assert.throws(()=>validateTicket({...input,machine:'printer',paperType:'Standard',width:'25'},[{originalName:'a.pdf'}]));
  for (const machine of ['printer', 'foam']) assert.throws(()=>validateTicket({...input,machine},[]),/at least one artwork file/i);
  assert.equal(validateTicket(input,foamFiles).machine,'foam');
  assert.equal(validateTicket({...input,neededBy:'Today'},foamFiles).neededBy,'Today');
  assert.equal(validateTicket({...input,neededBy:undefined},foamFiles).neededBy,'No rush');
  const withoutOptionalFields={...input}; delete withoutOptionalFields.phone; delete withoutOptionalFields.width; delete withoutOptionalFields.length;
  assert.deepEqual({phone:validateTicket(withoutOptionalFields,foamFiles).phone,width:validateTicket(withoutOptionalFields,foamFiles).width,length:validateTicket(withoutOptionalFields,foamFiles).length},{phone:'',width:0,length:0});
});
test('validates file formats for each machine',()=>{
  assert.doesNotThrow(()=>validateTicket({...input,machine:'printer'},[{originalName:'cut.ai'},{originalName:'archive.zip'},{originalName:'README'}]));
  assert.throws(()=>validateTicket(input,[{originalName:'photo.jpg'}]),/SVG or DXF/i);
  assert.doesNotThrow(()=>validateTicket({...input,machine:'printer'},[{originalName:'poster.JPG'}]));
  assert.doesNotThrow(()=>validateTicket({...input,machine:'printer'},[{originalName:'transparent.png'},{originalName:'phone.HEIC'},{originalName:'art.webp'}]));
  assert.doesNotThrow(()=>validateTicket(input,[{originalName:'cut.DXF'}]));
});
test('status changes move queue positions, hide closed jobs, preserve history and private data',async t=>{
  const store=await createStore(await temp(t));
  const first=(await store.create(validateTicket(input,foamFiles),'one')).ticket;
  const second=(await store.create(validateTicket(input,foamFiles),'two')).ticket;
  await store.review(second.id,{decision:'approve',operator:'Admin'},1);
  await store.update(first.id,'ready');
  const queue=publicQueue(store.list())[1];
  assert.equal(queue.tickets.find(t=>t.ticketNumber===second.ticketNumber).position,1);
  assert.equal(queue.tickets[0].customerName,'Test Person');
  assert.ok(!JSON.stringify(queue).includes('Events'));
  await store.update(first.id,'collected');
  assert.equal(publicQueue(store.list())[1].tickets.length,1);
  assert.equal(store.list()[0].history.length,3);
  await assert.rejects(store.update(second.id,'bad'));
});
test('Sheets failure preserves pending records and retries latest status once',async t=>{
  const store=await createStore(await temp(t));
  const job=(await store.create(validateTicket(input,foamFiles),'one')).ticket;
  let failed=true; const writes=[];
  const sheets=createSheetsSync(store,{url:'https://script.google.com/macros/s/test/exec',secret:'test',fetcher:async(_url,opts)=>{
    if(failed)throw new Error('offline');writes.push(JSON.parse(opts.body));return {ok:true,json:async()=>({ok:true})};
  }});
  await sheets.sync(); assert.equal(sheets.state().pending,1); assert.ok(sheets.state().lastError);
  await store.update(job.id,'ready'); failed=false;
  await sheets.sync(); await sheets.sync();
  assert.equal(sheets.state().pending,0);assert.equal(writes.length,1);assert.equal(writes[0].row[13],'ready');
});
test('a status update during Sheets delivery stays pending for the next sync',async t=>{
  const store=await createStore(await temp(t));
  const job=(await store.create(validateTicket(input,foamFiles),'one')).ticket;
  const sheets=createSheetsSync(store,{url:'https://script.google.com/macros/s/test/exec',secret:'test',fetcher:async()=>{
    await store.update(job.id,'in-progress');return {ok:true,json:async()=>({ok:true})};
  }});
  await sheets.sync();assert.equal(sheets.state().pending,1);
  await sheets.sync();assert.equal(sheets.state().pending,0);
});
test('spreadsheet exports escape formulas, quotes, commas and newlines',()=>{
  const ticket={...validateTicket({...input,customerName:'=SUM(1,2)',purpose:'Line one\n"line two"'},foamFiles),id:'id',ticketNumber:'F-0001',status:'queued',createdAt:'now',revision:1};
  const output=csv([ticket]);assert.ok(output.includes('"\'=SUM(1,2)"'));assert.ok(output.includes('"Line one\n""line two"""'));
});
test('Sheets can sync new tickets after starting with an empty queue', async t => {
  const store = await createStore(await temp(t));
  let writes = 0;
  const sheets = createSheetsSync(store, { url:'https://script.google.com/macros/s/test/exec', secret:'test', fetcher:async()=>{
    writes++; return {ok:true,json:async()=>({ok:true})};
  }});
  await sheets.sync();
  await store.create(validateTicket(input,foamFiles),'after-empty');
  await sheets.sync();
  assert.equal(writes,1); assert.equal(sheets.state().pending,0);
});
test('reopening clears the old ready timestamp and survives a restart', async t => {
  const dir = await temp(t), store = await createStore(dir);
  const {ticket} = await store.create(validateTicket(input,foamFiles),'reopen');
  assert.ok((await store.update(ticket.id,'ready')).completedAt);
  const reopened = await store.update(ticket.id,'queued');
  assert.equal(reopened.completedAt,null);
  assert.equal((await createStore(dir)).list()[0].status,'queued');
});
test('HTTP flow: auth, bounded uploads, receipt, privacy, tracking, status and export',async t=>{
  const dir=await temp(t);
  const child=spawn(process.execPath,['server.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,NODE_ENV:'test',APP_ORIGIN:'https://desk.example',COOKIE_SECURE:'true',CLAMSCAN_PATH:'',PORT:'0',DATA_DIR:dir,ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'test-only-secret',STAFF_USERNAME:'workshop',STAFF_PASSWORD:'staff-test-secret',TEXTBEE_API_KEY:'',TEXTBEE_DEVICE_ID:'',WORKSHOP_GOOGLE_SCRIPT_URL:'',SHEETS_WEBHOOK_URL:'',SHEETS_SHARED_SECRET:'',MAX_UPLOAD_BYTES:'1048576',MAX_UPLOAD_FILES:'3',MAX_UPLOAD_TOTAL_BYTES:'1500000',UPLOAD_REQUEST_TIMEOUT_MS:'250'},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{const exited=once(child,'exit');child.kill();await exited;});
  const port=await new Promise((resolve,reject)=>{child.stdout.on('data',d=>{const m=String(d).match(/port (\d+)/);if(m)resolve(m[1]);});child.once('error',reject);child.once('exit',()=>reject(new Error('Server exited before listening.')));});
  const base='http://127.0.0.1:'+port;
  const health=await(await fetch(base+'/api/health')).json(); assert.equal(health.ok,true); assert.ok(!Number.isNaN(Date.parse(health.time)));
  const preflight=await fetch(base+'/api/session',{method:'OPTIONS',headers:{origin:'https://desk.example','access-control-request-method':'POST'}});
  assert.equal(preflight.status,204); assert.equal(preflight.headers.get('access-control-allow-origin'),'https://desk.example');
  assert.equal(preflight.headers.get('access-control-allow-credentials'),'true');
  assert.equal((await fetch(base+'/api/tickets')).status,401);
  assert.equal((await fetch(base+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'bad'})})).status,401);
  const login=await fetch(base+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'test-only-secret'})});
  const cookie=login.headers.get('set-cookie').split(';')[0]; assert.match(login.headers.get('set-cookie'),/HttpOnly/); assert.match(login.headers.get('set-cookie'),/SameSite=None/); assert.match(login.headers.get('set-cookie'),/Secure/);
  const design = 'layered artwork in an unrestricted printer format';
  const form=()=>{const data=new FormData();for(const[k,v]of Object.entries({...input,machine:'printer',paperType:'Glossy'}))data.set(k,v);data.set('files',new Blob([design]),'sample.psd');return data;};
  assert.equal((await fetch(base+'/api/session',{method:'POST'})).status,400);
  assert.equal((await fetch(base+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:'{"password":'})).status,400);
  assert.equal((await fetch(base+'/api/tickets',{method:'POST',body:form()})).status,400);
  assert.equal((await fs.readdir(path.join(dir,'uploads'))).length,0);
  const response=await fetch(base+'/api/tickets',{method:'POST',headers:{'idempotency-key':'http-test-request-123'},body:form()});
  assert.equal(response.status,201);const receipt=await response.json();assert.equal(receipt.ticket.ticketNumber,'P-0001');assert.equal(receipt.ticket.status,'pending-review');assert.equal(receipt.ticket.position,null);assert.ok(receipt.ticket.trackingCode);
  const halfOpen = () => new Promise((resolve,reject) => {
    const socket=net.createConnection({host:'127.0.0.1',port:Number(port)},()=>{
      socket.write('POST /api/tickets HTTP/1.1\r\nHost: 127.0.0.1\r\nIdempotency-Key: half-open-request-123\r\nContent-Type: multipart/form-data; boundary=hold\r\nContent-Length: 100000\r\nConnection: keep-alive\r\n\r\n--hold\r\n');
      resolve(socket);
    });
    socket.once('error',reject);
  });
  const stalled=await Promise.all(Array.from({length:4},halfOpen));
  t.after(()=>stalled.forEach(socket=>socket.destroy()));
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal((await fetch(base+'/api/tickets',{method:'POST',headers:{'idempotency-key':'http-test-request-123'},body:form()})).status,429);
  await new Promise(resolve=>setTimeout(resolve,350));
  const retry=await fetch(base+'/api/tickets',{method:'POST',headers:{'idempotency-key':'http-test-request-123'},body:form()});assert.equal(retry.status,200);
  const list=await(await fetch(base+'/api/tickets',{headers:{cookie}})).json();assert.equal(list.tickets.length,0);assert.equal(list.sheets.configured,false);
  const adminList=await(await fetch(base+'/api/admin/requests',{headers:{cookie}})).json();
  assert.equal(adminList.tickets[0].paperType,'');
  const job=adminList.tickets[0], download=base+'/api/tickets/'+job.id+'/files/'+job.files[0].storedName;
  assert.equal((await fetch(download)).status,401);
  const downloaded = await fetch(download,{headers:{cookie}});
  assert.equal(downloaded.headers.get('content-type'),'application/octet-stream');
  assert.match(downloaded.headers.get('content-disposition'),/^attachment;/);
  assert.equal(await downloaded.text(),design);
  assert.equal((await fs.readdir(path.join(dir,'uploads'))).length,1);
  const patch = body => fetch(base+'/api/tickets/'+job.id,{method:'PATCH',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await patch({status:'ready'})).status,400);
  assert.equal((await patch({status:'ready',expectedRevision:job.revision})).status,409);
  assert.equal((await patch({status:'in-progress',expectedRevision:job.revision})).status,409);
  assert.equal((await fetch(base+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'workshop',password:'test-only-secret'})})).status,401);
  const staffLogin=await fetch(base+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'workshop',password:'staff-test-secret'})});
  const staffCookie=staffLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base+'/api/admin/requests',{headers:{cookie:staffCookie}})).status,403);
  assert.equal((await fetch(download,{headers:{cookie:staffCookie}})).status,404);
  const review=body=>fetch(base+'/api/admin/requests/'+job.id+'/review',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await fetch(base+'/api/admin/requests/'+job.id+'/review',{method:'POST',headers:{cookie:staffCookie,'content-type':'application/json'},body:JSON.stringify({decision:'approve',expectedRevision:1})})).status,403);
  assert.equal((await review({decision:'approve',operator:'Admin',expectedRevision:1})).status,200);
  assert.equal((await patch({status:'in-progress',expectedRevision:2})).status,200);
  const usageBody = { expectedRevision:3, requestKey:'http-usage-request-123', used:6, waste:0.5, operator:'Test volunteer', note:'Initial run' };
  const usage = () => fetch(base+'/api/tickets/'+job.id+'/usage',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(usageBody)});
  assert.equal((await usage()).status,200);
  assert.equal((await usage()).status,200);
  assert.equal((await patch({status:'ready',expectedRevision:4})).status,200);
  assert.equal((await fetch(base+'/api/usage/export')).status,401);
  assert.match(await(await fetch(base+'/api/usage/export',{headers:{cookie}})).text(),/6.5/);
  assert.equal((await patch({status:'cancelled',expectedRevision:job.revision})).status,409);
  const changed = form(); changed.set('quantity','99');
  assert.equal((await fetch(base+'/api/tickets',{method:'POST',headers:{'idempotency-key':'http-test-request-123'},body:changed})).status,409);
  const disguised = form(); disguised.set('files',new Blob(['not a pdf']),'bad.pdf');
  assert.equal((await fetch(base+'/api/tickets',{method:'POST',headers:{'idempotency-key':'http-disguised-1234'},body:disguised})).status,400);
  const oversized = form(); oversized.set('files',new Blob([new Uint8Array(1048577)]),'oversized.jpg');
  const oversizedResponse = await fetch(base+'/api/tickets',{method:'POST',headers:{'idempotency-key':'http-oversized-1234'},body:oversized});
  assert.equal(oversizedResponse.status,400); assert.match((await oversizedResponse.json()).error,/1 MB/);
  const overTotal = form();
  const largePdf = () => new Blob(['%PDF-1.7\n',new Uint8Array(800000),'\n%%EOF\n']);
  overTotal.set('files',largePdf(),'one.pdf'); overTotal.append('files',largePdf(),'two.pdf');
  const overTotalResponse = await fetch(base+'/api/tickets',{method:'POST',headers:{'idempotency-key':'http-over-total-1234'},body:overTotal});
  assert.equal(overTotalResponse.status,400); assert.match((await overTotalResponse.json()).error,/total no more than 2 MB/i);
  assert.equal((await fs.readdir(path.join(dir,'uploads'))).length,1);
  assert.equal((await(await fetch(base+'/api/track/P-0001')).json()).status,'ready');
  const queue=await(await fetch(base+'/api/queue')).text();assert.ok(queue.includes('Test Person'));assert.ok(!queue.includes('sample.psd'));
  assert.equal((await fetch(base+'/api/export')).status,401);assert.match(await(await fetch(base+'/api/export',{headers:{cookie}})).text(),/P-0001/);
  assert.equal((await fetch(base+'/api/session',{method:'POST',headers:{origin:'https://other.invalid','content-type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/api/session',{method:'POST',headers:{origin:base.replace('http:','https:'),'content-type':'application/json'},body:'{}'})).status,403);
  await fetch(base+'/api/session',{method:'DELETE',headers:{cookie}});assert.equal((await fetch(base+'/api/tickets',{headers:{cookie}})).status,401);
});
