import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createStore, validateTicket, publicQueue } from '../lib/store.js';
import { createGoogleWorkshop } from '../lib/google-workshop.js';
import { usageCsv } from '../lib/workflow.js';
const details = { machine:'foam', customerName:'Private Name', department:'Events', purpose:'Private design', quantity:'1', width:'24', length:'36', thickness:'2', neededBy:'Today' };
const foamFiles = [{ originalName:'design.svg', storedName:'design.svg', size:100 }];
const input = { requestKey:'usage-request-0001', used:6, waste:1, operator:'Tester', note:'Cut and offcut waste' };
async function setup(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(),'workshop-')); t.after(() => fs.rm(dir,{recursive:true,force:true})); return {dir, store:await createStore(dir)}; }
test('review gates production; approved jobs can start out of order; material history stays intact', async t => {
  const {dir,store}=await setup(t);
  const a=(await store.create(validateTicket(details,foamFiles),'a')).ticket;
  const b=(await store.create(validateTicket(details,foamFiles),'b')).ticket;
  const p=(await store.create(validateTicket({...details,machine:'printer',paperType:'Glossy'},[{originalName:'a.pdf',storedName:'a.pdf'}]),'p')).ticket;
  assert.equal(p.paperType,''); assert.equal(publicQueue(store.list())[1].waiting,0);
  assert.equal(publicQueue(store.list())[1].inReview,2);
  assert.deepEqual(publicQueue(store.list())[1].tickets.map(t=>t.position),[null,null]);
  assert.equal(publicQueue(store.list())[1].tickets[0].customerName,'Private Name');
  await assert.rejects(store.update(b.id,'in-progress',1,true),/workflow/);
  for(const ticket of [a,b,p]) await store.review(ticket.id,{decision:'approve',operator:'Admin'},1);
  await store.update(b.id,'in-progress',2,true);
  await store.update(a.id,'in-progress',2,true);
  await store.update(p.id,'in-progress',2,true);
  await assert.rejects(store.update(a.id,'ready',3,true),/material/);
  await store.recordUsage(a.id,input,3); await store.recordUsage(a.id,input,3);
  await assert.rejects(store.recordUsage(a.id,{...input,used:7},4),/different values/);
  await store.update(a.id,'ready',4,true);
  assert.equal(publicQueue(store.list())[1].tickets.find(t=>t.ticketNumber===b.ticketNumber).position,1);
  await store.update(a.id,'collected',5,true);
  const archived=await store.update(a.id,'archived',6,true,'','Archive volunteer');
  assert.equal(archived.status,'archived');
  assert.equal(archived.history.at(-1).operator,'Archive volunteer');
  await assert.rejects(store.update(a.id,'queued',7,true),/workflow/);
  assert.equal((await createStore(dir)).list()[0].usage[0].used,6);
  assert.match(usageCsv(store.list()),/Foam 2 in/);
});
test('review accepts an exact calendar deadline while preserving legacy timing values', async t => {
  const {store}=await setup(t);
  const {ticket}=await store.create(validateTicket({...details,neededBy:'2099-12-31'},foamFiles),'calendar');
  const reviewed=await store.review(ticket.id,{decision:'save',operator:'Admin',fields:{neededBy:'2099-11-30'}},1);
  assert.equal(reviewed.neededBy,'2099-11-30');
  await assert.rejects(store.review(reviewed.id,{decision:'save',operator:'Admin',fields:{neededBy:'2099-02-29'}},2),/valid requested deadline/i);
});
test('simultaneous usage saves cannot double-count or overwrite another volunteer', async t => {
  const {store}=await setup(t); const {ticket}=await store.create(validateTicket(details,foamFiles),'a');
  await store.review(ticket.id,{decision:'approve',operator:'Admin'},1);
  await store.update(ticket.id,'in-progress',2,true);
  const results=await Promise.allSettled([store.recordUsage(ticket.id,input,3),store.recordUsage(ticket.id,{...input,requestKey:'usage-request-0002'},3)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  for (const patch of [{used:-1},{waste:'bad'},{used:0,waste:0},{operator:''},{note:''}]) await assert.rejects(store.recordUsage(ticket.id,{...input,requestKey:'usage-request-0003',...patch},3));
});
const source=await fs.readFile(new URL('../integrations/google-sheets.gs',import.meta.url),'utf8');
function googleHarness() {
  let rows=[],locks=0,immediateTelegram=[];
  const ctx=vm.createContext({console, PropertiesService:{getScriptProperties:()=>({getProperty:k=>k==='WORKSHOP_SHARED_SECRET'?'s'.repeat(32):null})}, SpreadsheetApp:{flush:()=>{}}, LockService:{getScriptLock:()=>({waitLock:()=>locks++,hasLock:()=>true,releaseLock:()=>locks--})}});
  vm.runInContext(source,ctx);
  ctx.processTelegramTicketNotifications_=ticketId=>{immediateTelegram.push(ticketId);return {configured:true,sent:1};};
  ctx.jsonResponse_=v=>JSON.parse(JSON.stringify(v));
  ctx.openBook_=()=>({});
  ctx.ensureTicketSheet_=()=>({getLastRow:()=>rows.length+1,getRange:(r,c,n=1,w=1)=>({getValues:()=>rows.slice(r-2,r-2+n).map(row=>row.slice(c-1,c-1+w)),setValues:values=>{values.forEach((v,i)=>rows[r-2+i]=v);}})});
  const make=(id,num,machine,created)=>[id,num,machine,'Private Name','Events','Secret design','Private phone',1,'Glossy',24,36,2,'Today','queued','Private notes','poster.pdf: https://drive.google.com/file/d/abcdefghijklmnop/view',created,created,1,'SECRET12','private-key','GitHub Pages','','','','','','[]','[]','',''];
  // Physical row order is reversed, as happens when staff sort the Sheet.
  rows=[make('b','F-0002','Foam cutting','2026-10-22T10:01:00Z'),make('a','F-0001','Foam cutting machine','2026-10-22T10:00:00Z'),make('p','P-0001','24-inch roll printer','2026-10-22T10:00:00Z')];
  ctx.publicQueueRows_=()=>rows.map(row=>row.slice(0,17));
  const call=(action,body={},secret='s'.repeat(32))=>ctx.doPost({postData:{contents:JSON.stringify({action,secret,...body})}});
  return {ctx,call,getRows:()=>rows,getImmediateTelegram:()=>immediateTelegram};
}
test('Google staff operations authenticate, allow flexible order, save usage once, and preserve existing receipt fields',()=>{
  const {ctx,call,getRows,getImmediateTelegram}=googleHarness();
  assert.equal(call('staffList',{},'bad').status,401);
  for (const action of ['staffList', 'staffUpdate', 'staffUsage', 'adminReview']) {
    const response = ctx.doPost({ postData: { contents: JSON.stringify({ action, publicStaff: true }) } });
    assert.equal(response.status, 401, `${action} requires the server secret`);
  }
  const list=call('staffList'); assert.equal(list.tickets.length,3);
  assert.equal(list.tickets.find(ticket=>ticket.id==='a').machine,'foam');
  assert.equal(list.tickets.find(ticket=>ticket.id==='p').machine,'printer');
  assert.equal(list.tickets[0].files[0].url,'https://drive.google.com/file/d/abcdefghijklmnop/view');
  assert.equal(call('staffUpdate',{id:'b',status:'in-progress',expectedRevision:1}).ok,true);
  assert.equal(call('staffUpdate',{id:'a',status:'in-progress',expectedRevision:1}).ok,true);
  assert.equal(call('staffUpdate',{id:'p',status:'in-progress',expectedRevision:1}).ok,true);
  assert.equal(call('staffUpdate',{id:'a',status:'ready',expectedRevision:2}).status,409);
  assert.equal(call('staffUsage',{id:'a',input,expectedRevision:2}).ticket.usage.length,1);
  assert.equal(call('staffUsage',{id:'a',input,expectedRevision:2}).ticket.usage.length,1);
  assert.equal(call('staffUsage',{id:'a',input:{...input,used:9},expectedRevision:3}).status,409);
  assert.equal(call('staffUpdate',{id:'a',status:'ready',expectedRevision:3}).ok,true);
  assert.deepEqual(getImmediateTelegram(),['a']);
  assert.equal(getRows()[1][19],'SECRET12'); assert.equal(getRows()[1][20],'private-key');
  assert.equal(call('staffUpdate',{id:'a',status:'collected',expectedRevision:3}).status,409);
  assert.equal(call('staffUpdate',{id:'a',status:'collected',expectedRevision:4}).ok,true);
  const archived=call('staffUpdate',{id:'a',status:'archived',operator:'Archive volunteer',expectedRevision:5});
  assert.equal(archived.ticket.status,'archived');
  assert.equal(archived.ticket.history.at(-1).operator,'Archive volunteer');
  assert.equal(getRows()[1][13],'archived');
  assert.equal(ctx.publicWorkshopQueue_().machines[1].tickets[0].ticketNumber,'F-0002');
});
test('Google public queue and private tracker agree after Sheet sorting and expose no personal data',()=>{
  const {ctx,getRows}=googleHarness();
  assert.equal(ctx.activePosition_(ctx.ensureTicketSheet_(),2,'Foam cutting','queued'),2);
  // A malformed private-history cell must not take down the lightweight public queue.
  getRows()[0][28]='not-json';
  const queue=ctx.publicWorkshopQueue_();
  assert.equal(queue.machines[1].tickets[0].ticketNumber,'F-0001');
  const json=JSON.stringify(queue); for(const value of ['Private phone','Private notes','Secret design','SECRET12','private-key','drive.google']) assert.ok(!json.includes(value));
});
test('Google adapter keeps authentication server-side and fails closed instead of creating local jobs',async()=>{
  const url='https://script.google.com/macros/s/test/exec',secret='x'.repeat(32);
  const adapter=createGoogleWorkshop({url,secret,fetcher:async(u,opts)=>{assert.equal(u,url);const body=JSON.parse(opts.body);assert.equal(body.secret,secret);return {ok:true,json:async()=>body.action==='publicQueue'?{ok:true,machines:[],updatedAt:'2026-10-26T00:00:00Z'}:{ok:true,tickets:[]}};}});
  assert.deepEqual(await adapter.list(),[]);
  assert.deepEqual((await adapter.queue()).machines,[]);
  await assert.rejects(createGoogleWorkshop({url,secret,fetcher:async()=>{throw new Error('offline');}}).list(),/No local replacement/);
  await assert.rejects(createGoogleWorkshop({url,secret,fetcher:async()=>({ok:true,json:async()=>({ok:false,status:409,error:'conflict'})})}).update('a','ready',1),e=>e.status===409);
});

test('Google review edits details with revision protection, decline reasons and no public leakage',()=>{
  const {ctx,call,getRows,getImmediateTelegram}=googleHarness(); const row=getRows()[0]; row[13]='pending-review'; row[8]=''; row[29]='yes'; row[6]='+13025550123';
  assert.equal(ctx.publicWorkshopQueue_().machines[1].waiting,1);
  const pending=ctx.publicWorkshopQueue_().machines[1].tickets.find(t=>t.ticketNumber==='F-0002');
  assert.equal(pending.status,'pending-review');assert.equal(pending.position,null);
  assert.equal(ctx.publicWorkshopQueue_().machines[1].inReview,1);
  assert.equal(call('staffUpdate',{id:'b',status:'in-progress',expectedRevision:1}).status,409);
  assert.equal(call('adminReview',{id:'b',expectedRevision:1,input:{decision:'approve',operator:'Admin',fields:{machine:'printer',width:25}}}).status,400);
  const result=call('adminReview',{id:'b',expectedRevision:1,input:{decision:'save',operator:'Admin',fields:{customerName:'Corrected name',width:'',length:'',notes:'Reviewed'}}});
  assert.equal(result.ticket.customerName,'Corrected name'); assert.equal(result.ticket.status,'pending-review');
  assert.equal(result.ticket.width,0); assert.equal(result.ticket.length,0);
  assert.ok(result.ticket.history[0].changes.some(c=>c.field==='width'));
  assert.equal(call('adminReview',{id:'b',expectedRevision:1,input:{decision:'approve',operator:'Admin'}}).status,409);
  assert.equal(call('adminReview',{id:'b',expectedRevision:2,input:{decision:'decline',operator:'Admin'}}).status,400);
  const declined=call('adminReview',{id:'b',expectedRevision:2,input:{decision:'decline',operator:'Admin',reason:'Please send sharper artwork'}});
  assert.equal(declined.ticket.status,'declined'); assert.equal('notification' in declined.ticket.history[1],false);
  assert.deepEqual(getImmediateTelegram(),['b']);
  assert.equal(getRows()[0][19],'SECRET12'); assert.equal(getRows()[0][30],'Please send sharper artwork');
  assert.ok(!JSON.stringify(ctx.publicWorkshopQueue_()).includes('Private phone'));
});
test('Google review can approve a ticket before the requester finishes Telegram linking',()=>{
  const {call,getRows}=googleHarness();
  getRows()[0][13]='pending-review';
  const approved=call('adminReview',{id:'b',expectedRevision:1,input:{decision:'approve',operator:'Admin'}});
  assert.equal(approved.ticket.status,'queued');
  assert.equal(getRows()[0][13],'queued');
});
test('review cannot replace local file paths, mutate identifiers, or reuse numbers after moving machines',async t=>{
  const {store}=await setup(t); const a=(await store.create(validateTicket(details,foamFiles),'a')).ticket;
  await assert.rejects(store.review(a.id,{decision:'approve',operator:'Admin',fields:{files:[{storedName:'../../private',originalName:'design.pdf'}]}},1),/belong/);
  await store.review(a.id,{decision:'save',operator:'Admin',fields:{machine:'printer',id:'changed',paperType:'Glossy',files:[{originalName:'new.pdf',url:'https://drive.google.com/file/d/abc123/view'}]}},1);
  const second=(await store.create(validateTicket(details,foamFiles),'b')).ticket;
  assert.equal(second.ticketNumber,'F-0002'); assert.equal(store.list()[0].id,a.id);
});

test('rollout holds only unreviewed queued backlog and is repeatable',()=>{
  const {ctx,getRows}=googleHarness();const rows=getRows();
  rows[1][13]='in-progress';
  rows[2][28]=JSON.stringify([{status:'queued',operator:'Admin',changes:[],at:'2026-10-23T01:00:00Z'}]);
  ctx.holdUnreviewedQueueForAdminReview();
  assert.equal(rows[0][13],'pending-review');assert.equal(rows[0][18],2);
  assert.equal(rows[1][13],'in-progress');assert.equal(rows[2][13],'queued');
  ctx.holdUnreviewedQueueForAdminReview();assert.equal(rows[0][18],2);
});
