import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.cwd());
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const ticketFile = path.join(dataDir, 'tickets.json');
const uploadDirs = [path.join(dataDir, 'uploads'), path.join(root, 'uploads')];
const statuses = new Set(['pending-review', 'declined', 'queued', 'in-progress', 'ready', 'collected', 'cancelled', 'archived']);
const machines = new Set(['printer', 'foam']);
const errors = [];
const warnings = [];

let tickets = [];
try {
  tickets = JSON.parse(await fs.readFile(ticketFile, 'utf8'));
} catch (error) {
  if (error.code === 'ENOENT') {
    console.log(JSON.stringify({ ok: true, tickets: 0, files: 0, warnings: ['No ticket database exists yet.'] }, null, 2));
    process.exit(0);
  }
  errors.push(`tickets.json could not be parsed: ${error.message}`);
}

if (!Array.isArray(tickets)) {
  errors.push('tickets.json must contain an array.');
  tickets = [];
}

const seenIds = new Set();
const seenNumbers = new Set();
const referencedFiles = new Set();
let fileCount = 0;

for (const [index, ticket] of tickets.entries()) {
  const label = `record ${index + 1}`;
  if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) {
    errors.push(`${label} is not an object.`);
    continue;
  }
  if (typeof ticket.id !== 'string' || !ticket.id) errors.push(`${label} has no ID.`);
  else if (seenIds.has(ticket.id)) errors.push(`${label} duplicates a ticket ID.`);
  else seenIds.add(ticket.id);
  if (typeof ticket.ticketNumber !== 'string' || !/^[PF]-\d{4,}$/.test(ticket.ticketNumber)) errors.push(`${label} has an invalid queue number.`);
  else if (seenNumbers.has(ticket.ticketNumber)) errors.push(`${label} duplicates a queue number.`);
  else seenNumbers.add(ticket.ticketNumber);
  if (!machines.has(ticket.machine)) errors.push(`${label} has an invalid machine.`);
  if ((ticket.machine === 'printer' ? 'P' : 'F') !== ticket.ticketNumber?.[0]) errors.push(`${label} has a queue prefix that does not match its machine.`);
  if (!statuses.has(ticket.status)) errors.push(`${label} has an invalid status.`);
  if (!Number.isSafeInteger(ticket.revision) || ticket.revision < 1) errors.push(`${label} has an invalid revision.`);
  if (!Number.isSafeInteger(ticket.syncedRevision) || ticket.syncedRevision < 0 || ticket.syncedRevision > ticket.revision) errors.push(`${label} has an invalid synced revision.`);
  if (!Array.isArray(ticket.history)) errors.push(`${label} has no status history array.`);
  else if (ticket.history.some(entry => !statuses.has(entry?.status) || Number.isNaN(Date.parse(entry?.at)))) errors.push(`${label} contains an invalid history entry.`);
  if (Number.isNaN(Date.parse(ticket.createdAt))) errors.push(`${label} has an invalid creation time.`);
  if (!Array.isArray(ticket.files)) errors.push(`${label} has no file array.`);
  else for (const file of ticket.files) {
    fileCount++;
    if (!file || typeof file.storedName !== 'string' || path.basename(file.storedName) !== file.storedName) {
      errors.push(`${label} contains an unsafe stored filename.`);
      continue;
    }
    referencedFiles.add(file.storedName);
    const found = await Promise.any(uploadDirs.map(directory => fs.access(path.join(directory, file.storedName)))).then(() => true).catch(() => false);
    if (!found) errors.push(`${label} references a missing upload.`);
  }
}

let storedFiles = [];
for (const directory of uploadDirs) {
  try { storedFiles.push(...await fs.readdir(directory)); }
  catch (error) { if (error.code !== 'ENOENT') errors.push(`Could not inspect ${directory}: ${error.message}`); }
}
const orphaned = storedFiles.filter(filename => !referencedFiles.has(filename));
if (orphaned.length) warnings.push(`${orphaned.length} stored upload(s) are not referenced by a ticket.`);

const result = { ok: errors.length === 0, tickets: tickets.length, files: fileCount, orphanedFiles: orphaned.length, errors, warnings };
console.log(JSON.stringify(result, null, 2));
if (errors.length) process.exitCode = 1;
