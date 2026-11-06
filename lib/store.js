import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fifoCompare, assertTransition, validateUsage, validateReview, normalizePhone, notificationEvent } from './workflow.js';

export const machines = { printer: 'Poster printing', foam: 'Foam cutting' };
export const papers = ['Polypropylene', 'Adhesive', 'Canvas', 'Glossy', 'Standard'];
export const statuses = ['pending-review', 'declined', 'queued', 'in-progress', 'ready', 'collected', 'cancelled', 'archived'];
export const deadlines = ['Today', 'Tomorrow', 'This week', 'No rush'];
export const active = ticket => ['queued', 'in-progress'].includes(ticket.status);
export function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
export function validNeededBy(value) {
  if (deadlines.includes(value)) return true;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}
function text(value, label, max, required = false) {
  if (value !== undefined && typeof value !== 'string') fail(`${label} must be text.`);
  const result = (value || '').trim();
  if ((required && !result) || result.length > max) fail(`${label} is ${!result ? 'required' : `limited to ${max} characters`}.`);
  return result;
}
function number(value, label, max = 100000) {
  if (!['string', 'number'].includes(typeof value) || !/^(?:\d+\.?\d*|\.\d+)$/.test(String(value).trim())) fail(`Enter a decimal number for ${label}.`);
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0.01 || result > max) fail(`Enter a valid ${label} between 0.01 and ${max}.`);
  return result;
}
function optionalNumber(value, label, max = 100000) {
  if (value === undefined || (typeof value === 'string' && value.trim() === '')) return 0;
  return number(value, label, max);
}
export function validateTicket(body, files) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(files)) fail('Invalid ticket request.');
  if (typeof body.machine !== 'string' || !Object.hasOwn(machines, body.machine)) fail('Choose a machine.');
  if (!files.length) fail('Attach at least one artwork file to submit a ticket.');
  const filePattern = body.machine === 'printer' ? /\.(pdf|jpg|jpeg|jpe|jfif|png|apng|gif|webp|bmp|dib|tif|tiff|avif|heic|heif|hif|ico|jxl)$/i : /\.(svg|dxf)$/i;
  if (files.some(file => !filePattern.test(String(file?.originalName || '')))) {
    fail(body.machine === 'printer' ? 'Poster printing accepts PDF or common image files only.' : 'Foam cutting accepts SVG or DXF files only.');
  }
  if (body.unit !== undefined && body.unit !== 'in') fail('Enter dimensions in inches.');
  const quantity = number(body.quantity, 'quantity', 10000);
  if (!Number.isInteger(quantity)) fail('Quantity must be a whole number.');
  const neededBy = body.neededBy === undefined ? 'No rush' : body.neededBy;
  if (!validNeededBy(neededBy)) fail('Choose a valid needed-by date.');
  const ticket = {
    machine: body.machine, customerName: text(body.customerName, 'Name', 100, true),
    department: text(body.department, 'Department', 100, true), purpose: text(body.purpose, 'Purpose', 2000, true),
    smsConsent: body.smsConsent === true || body.smsConsent === 'true' || body.smsConsent === 'on', phone: text(body.phone, 'Phone', 40), notes: text(body.notes, 'Notes', 4000), quantity,
    neededBy, width: optionalNumber(body.width, 'width', body.machine === 'printer' ? 24 : 10000),
    length: optionalNumber(body.length, 'length'), unit: 'in', files,
  };
  if (body.machine === 'printer') {
    ticket.paperType = '';
  } else {
    ticket.thickness = number(body.thickness, 'foam thickness', 1000);
  }
  ticket.phone = normalizePhone(ticket.phone, ticket.smsConsent);
  return ticket;
}

// All read-modify-write operations run through one queue. Atomic rename keeps the
// last complete file intact if a write is interrupted. Run one app process.
export async function createStore(directory) {
  await fs.mkdir(directory, { recursive: true });
  const filename = path.join(directory, 'tickets.json');
  let records;
  try { records = JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; records = []; }
  if (!Array.isArray(records)) throw new Error('Ticket data must be an array.');
  records = records.map(ticket => ({ ...ticket, machine: ticket.machine || 'printer',
    status: ({ new: 'queued', printing: 'in-progress', done: 'ready' })[ticket.status] || ticket.status,
    department: ticket.department || 'Not recorded', purpose: ticket.purpose || ticket.notes || 'Legacy print request',
    files: Array.isArray(ticket.files) ? ticket.files : [], history: Array.isArray(ticket.history) ? ticket.history : [],
    revision: ticket.revision || 1, syncedRevision: ticket.syncedRevision || 0,
  }));
  const save = async next => {
    const temp = `${filename}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flush: true });
      await fs.rename(temp, filename);
    } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
    records = next;
  };
  await save(records);
  let tail = Promise.resolve();
  function mutate(fn) {
    const operation = tail.then(async () => {
      const next = structuredClone(records);
      const result = fn(next);
      await save(next);
      return structuredClone(result);
    });
    tail = operation.catch(() => {});
    return operation;
  }
  return {
    list: () => structuredClone(records),
    create: (details, requestKey) => mutate(tickets => {
      const existing = tickets.find(t => t.requestKey === requestKey);
      // Stored filenames are random; fingerprints use the actual design bytes and request fields.
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ ...details,
        files: details.files.map(({ originalName, size, sha256 }) => ({ originalName, size, sha256 })) })).digest('hex');
      if (existing) {
        if (existing.fingerprint !== fingerprint) fail(`This request was already saved as ${existing.ticketNumber}. Track that ticket, or reload the page to start a different request.`, 409);
        return { ticket: existing, duplicate: true };
      }
      const sequence = tickets.reduce((max, t) => t.ticketNumber?.startsWith(details.machine === 'printer' ? 'P-' : 'F-')
        ? Math.max(max, t.sequence || Number(/^[PF]-(\d+)$/.exec(t.ticketNumber || '')?.[1]) || 0) : max, 0) + 1;
      if (!Number.isSafeInteger(sequence)) fail('Queue numbering is exhausted. Contact staff.', 503);
      const ticket = { ...details, id: crypto.randomUUID(), sequence,
        ticketNumber: `${details.machine === 'printer' ? 'P' : 'F'}-${String(sequence).padStart(4, '0')}`,
        requestKey, fingerprint, trackingCode: crypto.randomBytes(8).toString('hex').toUpperCase(), status: 'pending-review', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        revision: 1, syncedRevision: 0, history: [{ status: 'pending-review', at: new Date().toISOString() }] };
      tickets.push(ticket);
      return { ticket, duplicate: false };
    }),
    update: (id, status, expectedRevision, enforceWorkflow = false, reason = '', operator = '') => mutate(tickets => {
      if (!statuses.includes(status)) fail('Choose a valid status.');
      const ticket = tickets.find(t => t.id === id);
      if (!ticket) fail('Ticket not found.', 404);
      if (expectedRevision !== undefined && expectedRevision !== ticket.revision) fail('This ticket changed in another staff session. Refresh and try again.', 409);
      if (enforceWorkflow) assertTransition(tickets, ticket, status);
      if (ticket.status !== status) {
        if (typeof reason !== 'string' || reason.length > 1000 || (status === 'cancelled' && !reason.trim())) fail('Give a cancellation reason (up to 1000 characters).');
        if (typeof operator !== 'string' || operator.length > 100) fail('Check the staff name.');
        const historyReason = status === 'archived' ? '' : reason.trim();
        ticket.status = status; if (status !== 'archived') ticket.reason = historyReason; ticket.updatedAt = new Date().toISOString(); ticket.revision++;
        ticket.completedAt = status === 'ready' ? ticket.updatedAt : status === 'collected' || status === 'archived' ? ticket.completedAt || null : null;
        (ticket.history ||= []).push({ status, at: ticket.updatedAt, reason: historyReason, ...(operator.trim() ? { operator: operator.trim() } : {}), ...notificationEvent(ticket, status, historyReason) });
      }
      return ticket;
    }),
    review: (id, input, expectedRevision) => mutate(tickets => {
      const ticket = tickets.find(t => t.id === id);
      if (!ticket) fail('Ticket not found.',404);
      if (ticket.revision !== expectedRevision) fail('This request changed. Refresh and review the latest version.',409);
      const result = validateReview(ticket,input);
      Object.assign(ticket,result.edits,{status:result.status,reason:result.reason,updatedAt:new Date().toISOString(),revision:ticket.revision+1});
      ticket.history.push({status:ticket.status,at:ticket.updatedAt,operator:result.operator,reason:result.reason,changes:result.changes,...notificationEvent(ticket,ticket.status,result.reason)});
      return ticket;
    }),
    recordUsage: (id, input, expectedRevision) => mutate(tickets => {
      const ticket = tickets.find(t => t.id === id);
      if (!ticket) fail('Ticket not found.', 404);
      const entry = validateUsage(ticket, input);
      const prior = (ticket.usage || []).find(u => u.requestKey === entry.requestKey);
      if (prior) {
        if (Object.keys(entry).some(k => entry[k] !== prior[k])) fail('This usage entry was already saved with different values.', 409);
        return ticket;
      }
      if (ticket.revision !== expectedRevision) fail('This ticket changed. Refresh before recording usage.', 409);
      if (!['in-progress', 'ready'].includes(ticket.status)) fail('Start the job before recording material usage.', 409);
      ticket.updatedAt = new Date().toISOString(); ticket.revision++;
      (ticket.usage ||= []).push({ ...entry, at: ticket.updatedAt });
      return ticket;
    }),
    markSynced: (id, revision) => mutate(tickets => {
      const ticket = tickets.find(t => t.id === id);
      if (ticket) { ticket.syncedRevision = Math.max(ticket.syncedRevision, revision); ticket.syncedAt = new Date().toISOString(); }
      return ticket;
    }),
  };
}

export function publicQueue(tickets) {
  return Object.entries(machines).map(([id, name]) => {
    const jobs = tickets.filter(t => t.machine === id).sort(fifoCompare);
    const waiting = jobs.filter(active);
    const positions = new Map(waiting.map((ticket, index) => [ticket.id, index + 1]));
    return { id, name, waiting: waiting.length, inReview: jobs.filter(t => t.status === 'pending-review').length,
      tickets: jobs.filter(t => active(t) || t.status === 'ready' || t.status === 'pending-review').map(t => ({
        ticketNumber: t.ticketNumber, customerName: t.customerName || '', status: t.status, position: active(t) ? positions.get(t.id) : null,
      })) };
  });
}
