import { fail, validNeededBy } from './store.js';
export const fifoCompare = (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.sequence || Number(a.ticketNumber?.slice(2))) - (b.sequence || Number(b.ticketNumber?.slice(2))) || a.id.localeCompare(b.id);
export function assertTransition(tickets, ticket, status) {
  if (ticket.status === status) return;
  const allowed = { queued: ['in-progress', 'cancelled'], 'in-progress': ['ready', 'cancelled'], ready: ['collected', 'cancelled'], declined: ['archived'], collected: ['archived'], cancelled: ['archived'], archived: [] };
  if (!allowed[ticket.status]?.includes(status)) fail('Use the next workflow step for this ticket.', 409);
  if (status === 'ready' && !(ticket.usage || []).length) fail('Record material used before marking this job ready.', 409);
}
export function validateUsage(ticket, input) {
  if (!input || typeof input !== 'object' || !/^[a-zA-Z0-9-]{16,100}$/.test(input.requestKey || '')) fail('Refresh the material form and try again.');
  const used = Number(input.used), waste = Number(input.waste);
  if (input.used === '' || input.used == null || input.waste === '' || input.waste == null || !Number.isFinite(used) || !Number.isFinite(waste) || used < 0 || waste < 0 || used + waste <= 0 || used + waste > 100000) fail('Enter valid material quantities, including zero waste when there is none.');
  const operator = typeof input.operator === 'string' ? input.operator.trim() : '';
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (!operator || operator.length > 100 || !note || note.length > 500) fail('Add your name and a short usage note (up to 500 characters).');
  return { requestKey: input.requestKey, used, waste, operator, note, material: ticket.machine === 'printer' ? 'Poster printing' : `Foam ${ticket.thickness} in`, unit: ticket.machine === 'printer' ? 'linear ft' : 'sq ft' };
}
export function usageCsv(tickets) {
  const cell = v => '"' + String(v ?? '').replace(/^[\s]*[=+@-]/, "'$&").replaceAll('"', '""') + '"';
  const rows = [['Ticket', 'Machine', 'Department', 'Material', 'Unit', 'Used', 'Waste', 'Total consumed', 'Operator', 'Note', 'Recorded at']];
  for (const t of tickets) for (const u of t.usage || []) rows.push([t.ticketNumber, t.machine, t.department, u.material, u.unit, u.used, u.waste, u.used + u.waste, u.operator, u.note, u.at]);
  return '\uFEFF' + rows.map(r => r.map(cell).join(',')).join('\r\n');
}

export function normalizePhone(phone, consent) {
  if (!consent) return phone;
  let number = phone.replace(/[\s().-]/g, '');
  if (/^\d{10}$/.test(number)) number = '+1' + number;
  if (/^1\d{10}$/.test(number)) number = '+' + number;
  if (!/^\+[1-9]\d{7,14}$/.test(number)) fail('Enter a valid mobile number with country code for text updates.');
  return number;
}
export function notificationEvent(ticket, status, reason = '') {
  if (!['ready', 'cancelled', 'declined'].includes(status) || !ticket.smsConsent) return {};
  return { notification: { phone: ticket.phone, ticketNumber: ticket.ticketNumber, status, reason } };
}
// Review edits are explicit: no client-controlled identifiers, timestamps, or stored paths.
export function validateReview(ticket, input) {
  if (!input || !['save', 'approve', 'decline'].includes(input.decision)) fail('Choose a review action.');
  if (ticket.status !== 'pending-review') fail('Only requests awaiting review can be edited.', 409);
  const fields = input.fields || {};
  const str = (key, max, required = false) => {
    const v = fields[key] === undefined ? ticket[key] || '' : fields[key];
    if (typeof v !== 'string' || v.length > max || (required && !v.trim())) fail('Check ' + key + '.');
    return v.trim();
  };
  const num = (key, max, optional = false) => {
    const raw = fields[key] === undefined ? ticket[key] : fields[key];
    if (optional && (raw === undefined || raw === 0 || (typeof raw === 'string' && raw.trim() === ''))) return 0;
    if (!['number','string'].includes(typeof raw) || !/^(?:\d+\.?\d*|\.\d+)$/.test(String(raw).trim())) fail('Check ' + key + '.');
    const v = Number(raw); if (!Number.isFinite(v) || v < .01 || v > max) fail('Check ' + key + '.'); return v;
  };
  const machine = str('machine', 10, true);
  if (!['printer','foam'].includes(machine)) fail('Choose a machine.');
  const neededBy = str('neededBy', 30, true);
  if (!validNeededBy(neededBy)) fail('Choose a valid requested deadline.');
  const quantity = num('quantity',10000); if (!Number.isInteger(quantity)) fail('Quantity must be a whole number.');
  const paperType = machine === 'printer' ? str('paperType',50) : '';
  if (paperType && !['Polypropylene','Adhesive','Canvas','Glossy','Standard'].includes(paperType)) fail('Choose a paper material.');
  let files = fields.files === undefined ? ticket.files : fields.files;
  if (!Array.isArray(files) || files.length > 10) fail('Attach up to ten artwork files.');
  files = files.map(f => {
    if (!f || typeof f.originalName !== 'string' || !f.originalName.trim() || f.originalName.length > 180 || /[\r\n]/.test(f.originalName)) fail('Check the artwork filename.');
    if (f.storedName) {
      const original = ticket.files.find(old => old.storedName === f.storedName);
      if (!original) fail('This stored file does not belong to the ticket.');
      return { ...original, originalName: f.originalName.trim() };
    }
    if (typeof f.url !== 'string' || !/^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]+\/view$/.test(f.url)) fail('Use a Google Drive file link ending in /view.');
    return { originalName: f.originalName.trim(), url: f.url };
  });
  if (input.decision === 'approve' && machine === 'printer' && !files.length) fail('Attach artwork before approving a print.');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length > 1000 || (input.decision === 'decline' && !reason)) fail('Give a decline reason (up to 1000 characters).');
  const operator = typeof input.operator === 'string' ? input.operator.trim() : '';
  if (!operator || operator.length > 100) fail('Enter the reviewing admin name.');
  const phone = normalizePhone(str('phone',40), ticket.smsConsent === true);
  const edits = { machine, neededBy, quantity, paperType, files, phone, customerName: str('customerName',100,true), department: str('department',100,true), purpose: str('purpose',2000,true), notes: str('notes',4000), width: num('width',machine === 'printer' ? 24 : 10000,true), length:num('length',100000,true), thickness:machine === 'foam' ? num('thickness',1000) : 0 };
  const changes = Object.keys(edits).filter(k => JSON.stringify(ticket[k]) !== JSON.stringify(edits[k])).map(k => ({ field:k, before:ticket[k] ?? null, after:edits[k] }));
  return { edits, changes, reason, operator, status: input.decision === 'approve' ? 'queued' : input.decision === 'decline' ? 'declined' : 'pending-review' };
}
