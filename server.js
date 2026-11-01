import 'dotenv/config';
import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform, pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { createStore, validateTicket, publicQueue, machines, papers, deadlines, statuses, fail } from './lib/store.js';
import { createSheetsSync, csv } from './lib/sheets.js';
import { validateFilename, validateUpload, createMalwareScanner } from './lib/uploads.js';
import { createGoogleWorkshop } from './lib/google-workshop.js';
import { createNotifications } from './lib/notifications.js';
import { usageCsv } from './lib/workflow.js';
import { acquireProcessLock } from './lib/process-lock.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(here, 'data');
const uploadDir = path.join(dataDir, 'uploads');
const legacyUploads = path.join(here, 'uploads');
const production = process.env.NODE_ENV === 'production';
const googleMode = Boolean(process.env.WORKSHOP_GOOGLE_SCRIPT_URL);
const scanner = createMalwareScanner(process.env.CLAMSCAN_PATH);
const requestSite = process.env.PUBLIC_REQUEST_URL || '';
if (requestSite && !/^https:\/\//.test(requestSite)) throw new Error('PUBLIC_REQUEST_URL must use HTTPS.');
const appOrigin = process.env.APP_ORIGIN ? new URL(process.env.APP_ORIGIN).origin : null;
function positiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}
const maxUploadBytes = positiveInteger(process.env.MAX_UPLOAD_BYTES, 200 * 1024 * 1024, 'MAX_UPLOAD_BYTES');
const maxUploadFiles = positiveInteger(process.env.MAX_UPLOAD_FILES, 10, 'MAX_UPLOAD_FILES');
const maxUploadTotalBytes = positiveInteger(process.env.MAX_UPLOAD_TOTAL_BYTES, 200 * 1024 * 1024, 'MAX_UPLOAD_TOTAL_BYTES');
const uploadRequestTimeoutMs = positiveInteger(process.env.UPLOAD_REQUEST_TIMEOUT_MS, 15 * 60 * 1000, 'UPLOAD_REQUEST_TIMEOUT_MS');
if (production && ((!googleMode && !scanner) || !appOrigin?.startsWith('https://') || process.env.COOKIE_SECURE !== 'true' || !process.env.ADMIN_PASSWORD)) {
  throw new Error('Production requires CLAMSCAN_PATH for local uploads, an HTTPS APP_ORIGIN, COOKIE_SECURE=true, and a configured ADMIN_PASSWORD.');
}
if (process.env.STAFF_PASSWORD && process.env.STAFF_PASSWORD === process.env.ADMIN_PASSWORD) throw new Error('Staff and admin passwords must differ.');
await fs.mkdir(uploadDir, { recursive: true });
const releaseLock = acquireProcessLock(dataDir);
process.once('exit', releaseLock);
const store = await createStore(dataDir);
const sheets = createSheetsSync(store, { url: process.env.SHEETS_WEBHOOK_URL, secret: process.env.SHEETS_SHARED_SECRET });
const googleWorkshop = process.env.WORKSHOP_GOOGLE_SCRIPT_URL ? createGoogleWorkshop({ url: process.env.WORKSHOP_GOOGLE_SCRIPT_URL, secret: process.env.WORKSHOP_SHARED_SECRET }) : null;
if (googleWorkshop && process.env.SHEETS_WEBHOOK_URL) throw new Error('Use Google as the source of truth OR a local mirror, never both.');
const notifications = await createNotifications({directory:dataDir,apiKey:process.env.TEXTBEE_API_KEY,deviceId:process.env.TEXTBEE_DEVICE_ID});
const workshop = googleWorkshop || { review: (...args) => store.review(...args), list: async () => store.list(), queue: async () => ({ machines: publicQueue(store.list()), updatedAt: new Date().toISOString() }), update: (id, status, revision, reason, operator) => store.update(id, status, revision, true, reason, operator), recordUsage: (...args) => store.recordUsage(...args) };
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  const ownOrigin = `${req.protocol}://${req.get('host')}`;
  let requestOrigin = null;
  try { requestOrigin = req.get('origin') ? new URL(req.get('origin')).origin : null; }
  catch { return res.status(403).json({ error: 'Invalid origin.' }); }
  const allowedOrigin = requestOrigin && (requestOrigin === ownOrigin || requestOrigin === appOrigin);
  if (requestOrigin && requestOrigin === appOrigin && requestOrigin !== ownOrigin) {
    res.set({
      'Access-Control-Allow-Origin': requestOrigin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, PATCH, DELETE, OPTIONS',
      Vary: 'Origin',
    });
  }
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self' https://script.google.com https://script.googleusercontent.com; img-src 'self' data:; connect-src 'self' https://script.google.com https://script.googleusercontent.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" });
  if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return allowedOrigin ? res.sendStatus(204) : res.sendStatus(403);
  // Browsers may only mutate data from this server or the configured frontend origin.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (requestOrigin && !allowedOrigin) return res.status(403).json({ error: 'Use this website to submit requests.' });
    if (req.get('sec-fetch-site') === 'cross-site' && requestOrigin !== appOrigin) return res.status(403).json({ error: 'Use this website to submit requests.' });
  }
  next();
});
app.use(express.json({ limit: '32kb' }));
const sessions = new Map();
const attempts = new Map();
const authCleanup = setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) if (session.expires <= now) sessions.delete(token);
  for (const [ip, times] of attempts) if (times.every(at => now - at >= 600000)) attempts.delete(ip);
}, 60000);
authCleanup.unref();
function sessionToken(req) { return /(?:^|;\s*)desk_session=([a-f0-9]{64})(?:;|$)/.exec(req.get('cookie') || '')?.[1]; }
function sessionCookie(req) {
  const ownOrigin = `${req.protocol}://${req.get('host')}`;
  const crossSite = Boolean(appOrigin && appOrigin !== ownOrigin);
  return { httpOnly: true, sameSite: crossSite ? 'none' : 'strict', secure: crossSite || process.env.COOKIE_SECURE === 'true' };
}
function requireStaff(req, res, next) {
  const session = sessions.get(sessionToken(req));
  if (session && session.expires > Date.now()) { req.role = session.role; return next(); }
  res.status(401).json({ error: 'Sign in to the staff desk.' });
}
function requireAdmin(req,res,next) { requireStaff(req,res,() => req.role === 'admin' ? next() : res.status(403).json({error:'Admin access is required to review requests.'})); }
const sameSecret = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());
app.post('/api/session', (req, res) => {
  if (!process.env.ADMIN_PASSWORD) return res.status(503).json({ error: 'Set ADMIN_PASSWORD in the local configuration before staff sign-in.' });
  const key = req.ip;
  const recent = (attempts.get(key) || []).filter(t => Date.now() - t < 600000);
  if (recent.length >= 10) return res.status(429).json({ error: 'Too many sign-in attempts. Try again in ten minutes.' });
  if (!req.body || Array.isArray(req.body) || typeof req.body !== 'object') return res.status(400).json({ error: 'Send a JSON sign-in request.' });
  if (!attempts.has(key) && attempts.size >= 10000) return res.status(429).json({ error: 'Sign-in is busy. Try again later.' });
  const validInput = typeof req.body.password === 'string' && typeof req.body.username === 'string';
  const role = !validInput ? null : sameSecret(req.body.username, process.env.ADMIN_USERNAME || 'admin') && sameSecret(req.body.password,process.env.ADMIN_PASSWORD) ? 'admin' : process.env.STAFF_PASSWORD && sameSecret(req.body.username,process.env.STAFF_USERNAME || 'workshop') && sameSecret(req.body.password,process.env.STAFF_PASSWORD) ? 'staff' : null;
  if (!role) {
    attempts.set(key, [...recent, Date.now()]); return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  attempts.delete(key);
  for (const [token, session] of sessions) if (session.expires <= Date.now()) sessions.delete(token);
  sessions.delete(sessionToken(req));
  if (sessions.size >= 1000) return res.status(503).json({ error: 'Too many active staff sessions. Try again later.' });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {expires:Date.now() + 8 * 3600000,role});
  res.cookie('desk_session', token, { ...sessionCookie(req), maxAge: 8 * 3600000 });
  res.json({ ok: true, role });
});
app.delete('/api/session', (req, res) => { sessions.delete(sessionToken(req)); res.clearCookie('desk_session', sessionCookie(req)); res.json({ ok: true }); });
app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/api/config', (_req, res) => res.json({ machines, paperTypes: papers, turnaroundOptions: deadlines, statuses,
  uploads: { maxFiles: maxUploadFiles, maxFileBytes: maxUploadBytes, maxTotalBytes: maxUploadTotalBytes } }));
app.get('/api/queue', async (_req, res) => res.json(await workshop.queue()));
app.get('/api/track/:number', async (req, res) => {
  const records = await workshop.list();
  const ticket = records.find(t => t.ticketNumber.toUpperCase() === req.params.number.toUpperCase());
  if (!ticket) return res.status(404).json({ error: 'Ticket not found. Check the number on your receipt.' });
  const queue = publicQueue(records).find(m => m.id === ticket.machine);
  res.json({ ticketNumber: ticket.ticketNumber, machine: ticket.machine, machineName: machines[ticket.machine], status: ticket.status,
    reason: ticket.trackingCode && req.query.code === ticket.trackingCode ? ticket.reason || '' : '',
    position: queue.tickets.find(t => t.ticketNumber === ticket.ticketNumber)?.position || null });
});
const uploadStorage = {
  _handleFile(req, file, cb) {
    const filename = crypto.randomUUID() + path.extname(file.originalname).slice(0, 12);
    const location = path.join(uploadDir, filename);
    const output = createWriteStream(location, { flags: 'wx' });
    let size = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, done) {
        const nextTotal = (req.uploadedFileBytes || 0) + chunk.length;
        if (nextTotal > maxUploadTotalBytes) {
          const error = new Error(`Attachments must total no more than ${Math.ceil(maxUploadTotalBytes / 1024 / 1024)} MB.`);
          error.status = 400;
          done(error);
          return;
        }
        req.uploadedFileBytes = nextTotal;
        size += chunk.length;
        done(null, chunk);
      },
    });
    pipeline(file.stream, limiter, output, error => {
      if (error) {
        fs.unlink(location).catch(() => {}).finally(() => cb(error));
        return;
      }
      cb(null, { destination: uploadDir, filename, path: location, size });
    });
  },
  _removeFile(_req, file, cb) {
    fs.unlink(file.path).then(() => cb(), error => cb(error.code === 'ENOENT' ? null : error));
  },
};
const upload = multer({ limits: { fields: 20, fieldSize: 16384, files: maxUploadFiles, fileSize: maxUploadBytes }, storage: uploadStorage, fileFilter: (_req, file, cb) => {
  try { validateFilename(file.originalname); cb(null, true); } catch (error) { cb(error); }
} });
const cleanup = files => Promise.all((files || []).map(file => fs.unlink(file.path).catch(() => {})));
let activeUploads = 0;
app.post('/api/tickets', (req, res, next) => {
  if (googleWorkshop) return res.status(409).json({ error: 'Use the live Google-connected request form to submit this ticket.' });
  if (!/^[a-zA-Z0-9-]{16,100}$/.test(req.get('idempotency-key') || '')) return next(Object.assign(new Error('Refresh the form and submit again.'), { status: 400 }));
  if (!req.is('multipart/form-data')) return next(Object.assign(new Error('Submit tickets using the upload form.'), { status: 415 }));
  if (activeUploads >= 4) return res.status(429).json({ error: 'The upload service is busy. Try again shortly.' });
  activeUploads++;
  let released = false;
  let uploadTimer;
  const release = () => {
    if (!released) {
      released = true;
      clearTimeout(uploadTimer);
      activeUploads--;
    }
  };
  req.releaseUploadSlot = release;
  uploadTimer = setTimeout(() => {
    if (released) return;
    res.set('Connection', 'close');
    res.once('finish', () => req.destroy());
    res.status(408).json({ error: 'The upload took too long. Check your connection and try again.' });
    release();
  }, uploadRequestTimeoutMs);
  uploadTimer.unref();
  res.once('close', () => { if (!req.processingUpload) release(); });
  res.once('finish', release);
  next();
}, (req, res, next) => upload.array('files')(req, res, async error => {
  if (!error) return next();
  await cleanup(req.files);
  next(error);
}), async (req, res, next) => {
  req.processingUpload = true;
  let committed = false;
  try {
    const key = req.get('idempotency-key');
    const totalBytes = (req.files || []).reduce((total, file) => total + file.size, 0);
    if (totalBytes > maxUploadTotalBytes) fail(`Attachments must total no more than ${Math.ceil(maxUploadTotalBytes / 1024 / 1024)} MB.`);
    const files = [];
    for (const file of req.files || []) files.push(await validateUpload(file, { scanner, requireScanner: production }));
    const details = validateTicket(req.body, files);
    const { ticket, duplicate } = await store.create(details, key);
    committed = !duplicate;
    if (duplicate) await cleanup(req.files);
    void sheets.sync();
    res.status(duplicate ? 200 : 201).json({ ticket: { ticketNumber: ticket.ticketNumber, machine: ticket.machine, status: ticket.status,
      createdAt: ticket.createdAt, department: ticket.department, trackingCode: ticket.trackingCode,
      position: publicQueue(store.list()).find(m => m.id === ticket.machine).tickets.find(t => t.ticketNumber === ticket.ticketNumber)?.position || null } });
  } catch (error) { if (!committed) await cleanup(req.files); next(error); }
  finally { req.releaseUploadSlot(); }
});
const visibleToStaff = t => !['pending-review','declined'].includes(t.status);
app.get('/api/tickets', requireStaff, async (req,res) => res.json({tickets:(await workshop.list()).filter(visibleToStaff).map(notifications.decorate),role:req.role,source:googleWorkshop?'google':'local',sheets:sheets.state(),updatedAt:new Date().toISOString()}));
app.get('/api/admin/requests', requireAdmin, async (_req,res) => res.json({tickets:(await workshop.list()).map(notifications.decorate)}));
app.post('/api/admin/requests/:id/review', requireAdmin, async (req,res) => {
  if (!Number.isSafeInteger(req.body?.expectedRevision)) fail('Refresh before reviewing.');
  const ticket = await workshop.review(req.params.id,req.body,req.body.expectedRevision);
  void notifications.reconcile(await workshop.list()).catch(e=>console.error('Notification processing failed:',e.message));
  void sheets.sync(); res.json({ticket:notifications.decorate(ticket)});
});
app.post('/api/tickets/:id/notifications/:notificationId/retry', requireStaff, async(req,res) => {
  const ticket=(await workshop.list()).find(t=>t.id===req.params.id);
  if (!ticket || (req.role !== 'admin' && !visibleToStaff(ticket))) fail('Ticket not found.',404);
  res.json({ticket:await notifications.retry(req.params.notificationId,ticket)});
});
app.patch('/api/tickets/:id', requireStaff, async (req, res) => {
  if (!req.body || !Number.isSafeInteger(req.body.expectedRevision) || req.body.expectedRevision < 1) fail('Refresh the ticket before changing its status.');
  if (!['in-progress','ready','collected','cancelled','archived'].includes(req.body.status)) fail('Use an approved production workflow step.',409);
  const ticket = await workshop.update(req.params.id, req.body.status, req.body.expectedRevision, req.body.reason, req.body.operator);
  void notifications.reconcile(await workshop.list()).catch(e=>console.error('Notification processing failed:',e.message));
  void sheets.sync();
  res.json({ ticket });
});
app.get('/api/tickets/:id/files/:name', requireStaff, async (req, res) => {
  const ticket = store.list().find(t => t.id === req.params.id);
  if (ticket && req.role !== 'admin' && !visibleToStaff(ticket)) return res.sendStatus(404);
  const file = ticket?.files?.find(f => f.storedName === req.params.name);
  if (!file || path.basename(file.storedName) !== file.storedName) return res.sendStatus(404);
  if (production && (file.validation !== 'screened-v1' || file.scan !== 'clean')) return res.status(409).json({ error: 'This legacy file needs staff safety review before downloading in production.' });
  let location = path.join(uploadDir, file.storedName);
  try { await fs.access(location); } catch (error) { if (error.code !== 'ENOENT') throw error; location = path.join(legacyUploads, file.storedName); }
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Security-Policy': "sandbox; default-src 'none'" });
  res.download(location, file.originalName);
});
app.get('/api/export', requireAdmin, async (_req, res) => {
  res.set('Content-Type', 'text/csv; charset=utf-8').attachment('mandir-tickets.csv').send(csv(await workshop.list()));
});
app.post('/api/sheets/sync', requireAdmin, async (_req, res) => res.json({ sheets: await sheets.sync() }));
app.post('/api/tickets/:id/usage', requireStaff, async (req, res) => {
  if (!Number.isSafeInteger(req.body?.expectedRevision) || req.body.expectedRevision < 1) fail('Refresh the ticket before recording usage.');
  const ticket = await workshop.recordUsage(req.params.id, req.body, req.body.expectedRevision);
  res.json({ ticket });
});
app.get('/api/usage/export', requireStaff, async (_req, res) => res.type('text/csv').attachment('mandir-material-usage.csv').send(usageCsv(await workshop.list())));
// Build staff-dashboard with PUBLIC_URL=/staff; both apps share this origin and session.
const staffBuild = process.env.STAFF_BUILD_DIR || path.join(here, 'staff-dashboard/build');
app.use('/staff', express.static(staffBuild));
if (googleMode) app.get('/', (_req, res) => res.redirect(requestSite || '/staff/'));
app.use(express.static(path.join(here, 'dist')));
app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error instanceof multer.MulterError ? 400 : error.status || 500;
  if (status === 500) console.error('Ticket operation failed:', error.message);
  const uploadMessage = error instanceof multer.MulterError && ({ LIMIT_FILE_SIZE: `Each file must be no larger than ${Math.ceil(maxUploadBytes / 1024 / 1024)} MB.`,
    LIMIT_FILE_COUNT: `Attach no more than ${maxUploadFiles} files.`, LIMIT_UNEXPECTED_FILE: `Attach no more than ${maxUploadFiles} files.` })[error.code];
  res.status(status).json({ error: uploadMessage || (error.type === 'entity.parse.failed' ? 'Invalid JSON request.' : status === 500 ? 'Could not save this request. Please try again.' : error.message) });
});
async function background() { await sheets.sync(); try { await notifications.reconcile(await workshop.list()); } catch(e) { console.error('Notification processing failed:',e.message); } }
const interval = setInterval(() => void background(), 30000);
interval.unref();
void background();
const server = app.listen(Number(process.env.PORT || 3000), process.env.HOST || '0.0.0.0', () => console.log('Mandir Ticket Desk ready on port ' + server.address().port));
server.requestTimeout = uploadRequestTimeoutMs;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  clearInterval(interval); clearInterval(authCleanup);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 30000).unref();
});
