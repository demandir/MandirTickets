import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../integrations/google-sheets.gs', import.meta.url), 'utf8');
const context = vm.createContext({ console });
vm.runInContext(source, context, { filename: 'google-sheets.gs' });

const loadContext = (globals = {}) => {
  const isolated = vm.createContext({ console, ...globals });
  vm.runInContext(source, isolated, { filename: 'google-sheets.gs' });
  return isolated;
};

const propertiesStore = initial => {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getProperty: key => values.get(key) ?? null,
    getProperties: () => Object.fromEntries(values),
    setProperty: (key, value) => values.set(key, String(value)),
    deleteProperty: key => values.delete(key),
  };
};

const blob = bytes => ({
  getBytes: () => Array.from(bytes),
  getDataAsString: charset => Buffer.from(bytes).toString(String(charset).toUpperCase() === 'UTF-8' ? 'utf8' : 'latin1'),
});

const digestBytes = value => Array.from(crypto.createHash('sha256').update(String(value)).digest(), byte => byte > 127 ? byte - 256 : byte);

const baseTicket = () => ({
  action: 'createTicket',
  requestKey: '0123456789abcdef0123456789abcdef',
  telegramDeviceKey: 'fedcba9876543210fedcba9876543210',
  startedAt: Date.now() - 2000,
  website: '',
  machine: 'foam',
  customerName: 'Test Person',
  department: 'Events',
  purpose: 'Stage letters',
  phone: '',
  notes: '',
  quantity: '2',
  width: '20',
  length: '36',
  thickness: '2',
  neededBy: 'This week',
  files: [{ name: 'cut.svg', type: 'image/svg+xml', size: 4, data: 'PHN2Zz4=' }],
});

test('Apps Script backend validates a complete foam ticket', () => {
  const ticket = context.validatePublicTicket_(baseTicket());
  assert.equal(ticket.machine, 'foam');
  assert.equal(ticket.quantity, 2);
  assert.equal(ticket.thickness, 2);
  assert.equal(ticket.telegramDeviceKey, 'fedcba9876543210fedcba9876543210');
  assert.throws(() => context.validatePublicTicket_({ ...baseTicket(), telegramDeviceKey: '' }), /Telegram is required/i);
});

test('Apps Script accepts a ticket without hidden phone or finished size fields', () => {
  const request = baseTicket();
  delete request.phone;
  delete request.width;
  delete request.length;
  const ticket = context.validatePublicTicket_(request);
  assert.equal(ticket.phone, '');
  assert.equal(ticket.width, '');
  assert.equal(ticket.length, '');
});

test('request-key tracking distinguishes a pending save from a permanent backend failure', () => {
  const requestKey = 'd'.repeat(32);
  const properties = propertiesStore({});
  const sheet = {};
  const isolated = loadContext({ PropertiesService: { getScriptProperties: () => properties } });
  isolated.openBook_ = () => ({});
  isolated.ensureTicketSheet_ = () => sheet;
  isolated.findRow_ = () => 0;

  assert.deepEqual(
    JSON.parse(JSON.stringify(isolated.trackTicket_({ requestKey }))),
    { ok: false, pending: true, error: 'The ticket is still being saved.' },
  );

  isolated.rememberTicketFailure_(requestKey, new Error('The destination Sheet rejected the row.'));
  assert.deepEqual(
    JSON.parse(JSON.stringify(isolated.trackTicket_({ requestKey }))),
    { ok: false, pending: false, error: 'The destination Sheet rejected the row.' },
  );

  const committedRow = Array(32).fill('');
  committedRow[1] = 'P-0001';
  committedRow[2] = 'Poster printing';
  committedRow[13] = 'pending-review';
  committedRow[16] = '2026-10-27T08:00:00.000Z';
  committedRow[19] = 'ABCD2345';
  sheet.getRange = () => ({ getValues: () => [committedRow] });
  isolated.findRow_ = () => 2;
  isolated.activePosition_ = () => null;
  assert.deepEqual(
    JSON.parse(JSON.stringify(isolated.trackTicket_({ requestKey }))),
    {
      ok: true,
      ticket: {
        ticketNumber: 'P-0001',
        trackingCode: 'ABCD2345',
        machineName: 'Poster printing',
        status: 'pending-review',
        position: null,
        reason: '',
        createdAt: '2026-10-27T08:00:00.000Z',
      },
    },
  );

  isolated.clearTicketFailure_(requestKey);
  assert.equal(properties.getProperty(`FAILED_${requestKey}`), null);
});

test('Telegram commands and requester push copy stay scoped to ticket updates', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(context.parseTelegramCommand_('/status@DelMandirDesignbot P-0042'))), { command: 'status', argument: 'P-0042' });
  assert.deepEqual(JSON.parse(JSON.stringify(context.parseTelegramCommand_('/stop'))), { command: 'stop', argument: '' });
  assert.deepEqual(JSON.parse(JSON.stringify(context.parseTelegramCommand_('/pickup P-0042'))), { command: 'pickup', argument: 'P-0042' });
  assert.equal(context.parseTelegramCommand_('what is my status?'), null);
  assert.equal(context.telegramStatusLabel_('pending-review'), 'Awaiting review');
  assert.equal(context.telegramStatusLabel_('in-progress'), 'In progress');
  const poster = {
    ticketNumber: 'P-0042', machine: 'printer', quantity: 3, width: 24, length: 36, purpose: 'Diwali stage backdrop', phone: '+13025550123',
    files: [{ originalName: 'backdrop.pdf', url: 'https://drive.google.com/file/d/abc123456789/view' }],
  };
  const ready = context.telegramPushMessage_(poster, 'ready');
  assert.match(ready, /^P-0042 is ready for pickup\.\n📋 Poster printing · Qty 3 · 24 × 36 in\nFor: Diwali stage backdrop\n📎 File: backdrop\.pdf\n/);
  assert.match(ready, /\/pickup P-0042/);
  assert.match(context.telegramPushMessage_({ ...poster, ticketNumber: 'F-0011', machine: 'foam', thickness: 2 }, 'declined', 'Please upload a sharper PDF.'), /^F-0011 was declined\.\n📋 Foam cutting · Qty 3 · 24 × 36 in · 2 in thick\n[\s\S]*Reason: Please upload a sharper PDF\.$/);
  assert.equal(context.telegramPushMessage_(poster, 'queued'), '');
  assert.match(context.telegramPushMessage_(poster, 'collected'), /closed.*Pickup has been recorded/i);
  assert.doesNotMatch(ready, /phone|contact|https?:|@|\+1302/i);
});

test('a requester Telegram pickup confirmation closes a ready ticket with history', () => {
  const row = Array(32).fill('');
  row[0] = 'ticket-ready';
  row[1] = 'P-0042';
  row[2] = 'Poster printing';
  row[3] = 'Requester';
  row[4] = 'Events';
  row[5] = 'Poster';
  row[7] = 1;
  row[12] = 'No rush';
  row[13] = 'ready';
  row[16] = '2026-10-30T12:00:00.000Z';
  row[17] = '2026-10-30T13:00:00.000Z';
  row[18] = 3;
  row[27] = JSON.stringify([{ used: 2, waste: 0 }]);
  row[28] = JSON.stringify([{ status: 'ready', at: row[17] }]);
  const sheet = {
    getRange() {
      return {
        getValues: () => [row.slice()],
        setValues(values) { values[0].forEach((value, index) => { row[index] = value; }); },
      };
    },
  };
  const isolated = loadContext({ SpreadsheetApp: { flush() {} } });
  isolated.ensureTicketSheet_ = () => sheet;
  isolated.findRow_ = () => 2;

  const result = isolated.telegramMarkPickedUp_({}, 'ticket-ready');
  assert.equal(result.ok, true);
  assert.equal(result.ticket.status, 'collected');
  assert.equal(row[13], 'collected');
  assert.equal(row[18], 4);
  const history = JSON.parse(row[28]);
  assert.equal(history.at(-1).operator, 'Requester via Telegram');
  assert.equal(history.at(-1).source, 'requester-telegram');

  const duplicate = isolated.telegramMarkPickedUp_({}, 'ticket-ready');
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.unchanged, true);
  assert.equal(row[18], 4);
});

test('Telegram staff group receives the complete formatted submission without requester opt-in', () => {
  const ticket = {
    id: 'ticket-1',
    ticketNumber: 'P-0042',
    machine: 'printer',
    status: 'pending-review',
    createdAt: '2026-10-30T12:00:00.000Z',
    files: [
      { originalName: 'main poster.pdf', url: 'https://drive.google.com/file/d/abc123456789/view' },
      { originalName: 'alternate poster.pdf', url: 'https://drive.google.com/file/d/xyz987654321/view' },
    ],
    history: [],
    customerName: 'Private Requester',
    department: 'Events',
    phone: '+13025550123',
    purpose: 'Private event',
    quantity: 3,
    width: 24,
    length: 36,
    neededBy: 'Tomorrow',
    notes: 'Use the approved blue and gold artwork.',
  };
  const records = [];
  const isolated = loadContext();
  isolated.telegramTicketMap_ = () => ({ tickets: [ticket], byId: new Map([[ticket.id, ticket]]), byNumber: new Map([[ticket.ticketNumber, ticket]]) });
  isolated.telegramSheetRows_ = sheet => sheet.rows;
  isolated.sha256Hex_ = value => `event-${value}`;
  isolated.appendTelegramOutbox_ = (_outbox, record, existingIds) => {
    if (existingIds.has(record.eventId)) return false;
    existingIds.add(record.eventId);
    records.push(record);
    return true;
  };
  const properties = propertiesStore({
    TELEGRAM_STAFF_CHAT_ID: '-1001234567890',
    TELEGRAM_STAFF_REGISTERED_AT: '2026-10-30T11:00:00.000Z',
  });

  assert.equal(isolated.reconcileTelegramEvents_({}, { rows: [] }, { rows: [] }, properties), 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].audience, 'staff');
  assert.equal(records[0].status, 'new');
  assert.match(records[0].message, /^🆕 P-0042 · Poster printing · Private Requester\nNEW WORKSHOP TICKET · Awaiting review/);
  assert.match(records[0].message, /Name: Private Requester/);
  assert.match(records[0].message, /Department: Events/);
  assert.doesNotMatch(records[0].message, /Phone|\+13025550123/);
  assert.match(records[0].message, /Purpose:\nPrivate event/);
  assert.match(records[0].message, /Quantity: 3/);
  assert.match(records[0].message, /Finished size: 24 × 36 in/);
  assert.match(records[0].message, /🔴 Needed by: Tomorrow/);
  assert.match(records[0].message, /ADDITIONAL NOTES\nUse the approved blue and gold artwork/);
  assert.match(records[0].message, /1\. main poster\.pdf\n   https:\/\/drive\.google\.com\/file\/d\/abc123456789\/view/);
  assert.match(records[0].message, /2\. alternate poster\.pdf\n   https:\/\/drive\.google\.com\/file\/d\/xyz987654321\/view/);
});

test('Telegram needed-by line hides no-rush tickets and flags close deadlines', () => {
  const now = new Date('2026-11-02T15:00:00.000Z');
  assert.equal(context.telegramNeededBy_('No rush', now), '');
  assert.equal(context.telegramNeededBy_('', now), '');
  assert.equal(context.telegramNeededBy_('This week', now), 'Needed by: This week');
  assert.equal(context.telegramNeededBy_('2026-11-03', now), '🔴 Needed by: Tue, 03 Nov 2026');
  assert.equal(context.telegramNeededBy_('2026-11-20', now), 'Needed by: Fri, 20 Nov 2026');
  const message = context.telegramStaffNewTicketMessage_({ ticketNumber: 'P-0050', machine: 'printer', neededBy: 'No rush', notes: '', files: [] });
  assert.doesNotMatch(message, /Needed by|ADDITIONAL NOTES|Phone/);
});

test('long Telegram staff submissions are split without dropping submitted details', () => {
  const purposeEnd = 'PURPOSE-END-9f21';
  const notesEnd = 'NOTES-END-7c42';
  const messages = context.telegramStaffNewTicketMessages_({
    ticketNumber: 'F-0099',
    machine: 'foam',
    createdAt: '2026-10-30T12:00:00.000Z',
    customerName: 'Long Form Requester',
    department: 'Decorations',
    phone: '',
    purpose: `${'Purpose detail '.repeat(160)}${purposeEnd}`,
    quantity: 2,
    width: 48,
    length: 96,
    thickness: 2,
    neededBy: 'This week',
    notes: `${'Finishing note '.repeat(260)}${notesEnd}`,
    files: [{ originalName: 'large-layout.dxf', url: 'https://drive.google.com/file/d/longfile123456/view' }],
  });
  const combined = messages.join('\n');
  assert.ok(messages.length > 1);
  messages.forEach(message => assert.ok(message.length <= 4096, `Telegram message is ${message.length} characters`));
  assert.match(combined, new RegExp(purposeEnd));
  assert.match(combined, new RegExp(notesEnd));
  assert.match(combined, /large-layout\.dxf/);
  assert.match(messages[1], /F-0099 continued · Part 2/);
});

test('a browser that already linked Telegram reuses its chat for the next ticket', () => {
  const key = 'a'.repeat(32);
  const linked = Array(11).fill('');
  linked[0] = 'old-ticket';
  linked[2] = '7654321';
  linked[3] = '111';
  linked[4] = 'enabled';
  linked[10] = `hash-${key}`;
  const writes = [];
  const sheet = rows => ({ rows, getLastRow: () => rows.length + 1, getRange: rowNumber => ({ setValues: values => writes.push({ rowNumber, row: values[0] }) }) });
  const run = rows => {
    const isolated = loadContext();
    const records = [];
    isolated.LockService = { getScriptLock: () => ({ waitLock() {}, hasLock: () => false, releaseLock() {} }) };
    isolated.SpreadsheetApp = { flush() {} };
    isolated.ensureTelegramSheets_ = () => ({ subscriptions: sheet(rows), outbox: {} });
    isolated.telegramSheetRows_ = target => target.rows;
    isolated.sha256Hex_ = value => `hash-${value}`;
    isolated.appendTelegramOutbox_ = (_outbox, record) => { records.push(record); return true; };
    return { isolated, records };
  };
  const ticket = { id: 'new-ticket', ticketNumber: 'P-0044', machine: 'printer', quantity: 1, purpose: 'Sabha banner', files: [] };

  const match = run([linked]);
  assert.equal(match.isolated.telegramAttachDevice_({}, ticket, key), true);
  const written = writes.pop();
  assert.equal(written.rowNumber, 3);
  assert.equal(written.row[2], '7654321');
  assert.equal(written.row[4], 'enabled');
  assert.equal(written.row[10], `hash-${key}`);
  assert.equal(match.records[0].chatId, '7654321');
  assert.match(match.records[0].message, /^🔗 P-0044 was added[\s\S]*\/stop/);

  const stopped = [...linked];
  stopped[4] = 'disabled';
  stopped[2] = '';
  const afterStop = run([stopped]);
  assert.equal(afterStop.isolated.telegramAttachDevice_({}, ticket, key), false);
  assert.equal(writes.pop().row[4], '');
  assert.equal(afterStop.records.length, 0);

  const other = run([linked]);
  assert.equal(other.isolated.telegramAttachDevice_({}, ticket, 'b'.repeat(32)), false);
  assert.equal(other.records.length, 0);
  assert.equal(other.isolated.telegramAttachDevice_({}, ticket, 'not-a-key'), false);
  assert.equal(other.isolated.telegramAttachDevice_({}, ticket, undefined), false);
});

test('Telegram decline notifications include the saved reason for requester and staff', () => {
  const declineReason = 'Please upload a higher-resolution PDF.';
  const ticket = {
    id: 'ticket-2',
    ticketNumber: 'P-0043',
    machine: 'printer',
    status: 'declined',
    createdAt: '2026-10-30T08:00:00.000Z',
    files: [],
    reason: declineReason,
    customerName: 'Asha Patel',
    department: 'Events',
    quantity: 1,
    purpose: 'Sabha banner',
    history: [{ status: 'declined', at: '2026-10-30T12:30:00.000Z', reason: declineReason, operator: 'Karan' }],
  };
  const subscription = Array(10).fill('');
  subscription[0] = ticket.id;
  subscription[2] = '7654321';
  subscription[4] = 'enabled';
  subscription[5] = '2026-10-30T11:00:00.000Z';
  const records = [];
  const isolated = loadContext();
  isolated.telegramTicketMap_ = () => ({ tickets: [ticket], byId: new Map([[ticket.id, ticket]]), byNumber: new Map([[ticket.ticketNumber, ticket]]) });
  isolated.telegramSheetRows_ = sheet => sheet.rows;
  isolated.sha256Hex_ = value => `event-${value}`;
  isolated.appendTelegramOutbox_ = (_outbox, record, existingIds) => {
    if (existingIds.has(record.eventId)) return false;
    existingIds.add(record.eventId);
    records.push(record);
    return true;
  };
  const properties = propertiesStore({
    TELEGRAM_STAFF_CHAT_ID: '-1001234567890',
    TELEGRAM_STAFF_REGISTERED_AT: '2026-10-30T10:00:00.000Z',
  });

  assert.equal(isolated.reconcileTelegramEvents_({}, { rows: [subscription] }, { rows: [] }, properties), 2);
  assert.deepEqual(records.map(record => record.audience).sort(), ['requester', 'staff']);
  const requester = records.find(record => record.audience === 'requester');
  const staff = records.find(record => record.audience === 'staff');
  assert.equal(requester.message, `P-0043 was declined.\n📋 Poster printing · Qty 1\nFor: Sabha banner\nReason: ${declineReason}`);
  assert.equal(staff.message, `❌ DECLINED · P-0043\nDeclined by: Karan\n👤 Asha Patel · Events\n📋 Poster printing · Qty 1\nFor: Sabha banner\nReason: ${declineReason}\n\n📱 Requester notified on Telegram`);
});

test('Telegram delivery outcomes retry only definite transient failures', () => {
  const sent = context.telegramDeliveryOutcome_({ ok: true, result: { message_id: 81 } }, 1, 1000);
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), { state: 'sent', messageId: '81', nextAttempt: '', detail: 'Accepted by Telegram.' });

  const limited = context.telegramDeliveryOutcome_({ ok: false, httpCode: 429, parameters: { retry_after: 12 } }, 1, 1000);
  assert.equal(limited.state, 'pending');
  assert.equal(new Date(limited.nextAttempt).getTime(), 13000);

  const unavailable = context.telegramDeliveryOutcome_({ ok: false, httpCode: 503 }, 2, 1000);
  assert.equal(unavailable.state, 'pending');
  const rejected = context.telegramDeliveryOutcome_({ ok: false, httpCode: 403, description: 'bot was blocked by the user' }, 1, 1000);
  assert.equal(rejected.state, 'failed');
  assert.match(rejected.detail, /blocked/i);
});

test('Telegram transport errors do not expose token-bearing URLs', () => {
  const isolated = loadContext({
    UrlFetchApp: {
      fetch() { throw new Error('Request failed for https://api.telegram.org/botsecret-token/getMe'); },
    },
  });
  assert.throws(
    () => isolated.telegramApiRequest_('getMe', {}, 'secret-token'),
    error => {
      assert.equal(error.message, 'Telegram could not be reached. Try again shortly.');
      assert.doesNotMatch(error.message, /secret-token|api\.telegram\.org/i);
      return true;
    },
  );
});

test('Telegram staff test posts a minimal message to the registered group', () => {
  const properties = propertiesStore({
    TELEGRAM_BOT_TOKEN: `123456789:${'A'.repeat(35)}`,
    TELEGRAM_STAFF_CHAT_ID: '-1001234567890',
  });
  let payload;
  let alert = '';
  const isolated = loadContext({
    PropertiesService: { getScriptProperties: () => properties },
    SpreadsheetApp: { getUi: () => ({ alert(message) { alert = message; } }) },
    UrlFetchApp: {
      fetch(_url, options) {
        payload = JSON.parse(options.payload);
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ ok: true, result: { message_id: 91 } }),
        };
      },
    },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(isolated.sendTelegramStaffTest())), { ok: true, messageId: '91' });
  assert.equal(payload.chat_id, '-1001234567890');
  assert.equal(payload.text, 'Telegram staff notifications are connected.');
  assert.doesNotMatch(payload.text, /phone|contact|artwork|purpose/i);
  assert.match(alert, /test sent/i);
});

test('Telegram receipt links use one-time hashed tokens and stop rotating after linkage', () => {
  const properties = propertiesStore({
    TELEGRAM_BOT_TOKEN: `123456789:${'A'.repeat(35)}`,
    TELEGRAM_BOT_USERNAME: 'DelMandirDesignbot',
  });
  const rows = [];
  const subscriptions = {
    getLastRow: () => rows.length + 1,
    getRange(_row, column) {
      return {
        getValues: () => [rows[_row - 2]],
        setValues(values) { rows[_row - 2] = values[0].slice(); },
        createTextFinder(value) {
          return {
            matchEntireCell() { return this; },
            findNext() {
              const index = rows.findIndex(row => String(row[column - 1]) === String(value));
              return index < 0 ? null : { getRow: () => index + 2 };
            },
          };
        },
      };
    },
  };
  const lock = { locked: false, waitLock() { this.locked = true; }, hasLock() { return this.locked; }, releaseLock() { this.locked = false; } };
  const isolated = loadContext({
    PropertiesService: { getScriptProperties: () => properties },
    LockService: { getScriptLock: () => lock },
    SpreadsheetApp: { flush() {} },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (_algorithm, value) => digestBytes(value),
      getUuid: () => '00112233-4455-6677-8899-aabbccddeeff',
    },
  });
  isolated.ensureTelegramSheets_ = () => ({ subscriptions });

  const link = isolated.telegramLinkForTicket_({}, { id: 'ticket-1', ticketNumber: 'P-0042' });
  assert.equal(link.url, 'https://t.me/DelMandirDesignbot?start=00112233445566778899aabbccddeeff');
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0][7], '00112233445566778899aabbccddeeff');
  assert.equal(rows[0][7], crypto.createHash('sha256').update('00112233445566778899aabbccddeeff').digest('hex'));

  rows[0][2] = "'-100123456";
  rows[0][4] = 'enabled';
  assert.deepEqual(JSON.parse(JSON.stringify(isolated.telegramLinkForTicket_({}, { id: 'ticket-1', ticketNumber: 'P-0042' }))), { linked: true });
});

test('a transient request-key tracking read failure remains retryable', () => {
  const isolated = loadContext();
  isolated.trackTicket_ = () => { throw new Error('temporary Sheet read failure'); };
  isolated.javascriptResponse_ = (_callback, value) => value;

  assert.deepEqual(
    JSON.parse(JSON.stringify(isolated.doGet({ parameter: {
      callback: 'receiveTicket',
      action: 'track',
      requestKey: 'f'.repeat(32),
    } }))),
    { ok: false, pending: true, error: 'temporary Sheet read failure' },
  );
});

test('the old GitHub Pages JSONP request cannot read staff tickets', () => {
  const isolated = loadContext();
  isolated.javascriptResponse_ = (_callback, value) => value;

  assert.deepEqual(
    JSON.parse(JSON.stringify(isolated.doGet({ parameter: {
      callback: 'receiveStaffTickets',
      action: 'staffList',
      publicStaff: 'true',
    } }))),
    { ok: false, error: 'Unsupported action.' },
  );
});

test('Apps Script backend accepts calendar deadlines and removes the legacy notes marker', () => {
  const ticket = context.validatePublicTicket_({ ...baseTicket(), neededByDate: '2099-12-31', notes: 'Needed by date: 2099-12-31\nBlue logo' });
  assert.equal(ticket.neededBy, '2099-12-31');
  assert.equal(ticket.notes, 'Blue logo');
  assert.equal(context.validatePublicTicket_({ ...baseTicket(), neededBy: undefined }).neededBy, 'No rush');
  assert.throws(() => context.validatePublicTicket_({ ...baseTicket(), neededBy: false }), /needed-by date/i);
  assert.throws(() => context.validatePublicTicket_({ ...baseTicket(), neededByDate: '2099-02-29' }), /valid needed-by date/i);
});

test('Apps Script review approves print work without staff-only phone, deadline, or paper inputs', () => {
  const ticket = {
    status: 'pending-review',
    machine: 'printer',
    customerName: 'Requester',
    department: 'Events',
    purpose: 'Poster',
    phone: '',
    smsConsent: false,
    neededBy: 'No rush',
    quantity: 1,
    width: 24,
    length: 36,
    thickness: 0,
    paperType: '',
    notes: '',
    files: [{ originalName: 'poster.pdf', url: 'https://drive.google.com/file/d/abc123/view' }],
  };
  const result = context.validateReview(ticket, { decision: 'approve', operator: 'Admin', fields: {} });
  assert.equal(result.status, 'queued');
  assert.equal(result.edits.paperType, '');
  assert.equal(result.edits.phone, '');
  assert.equal(result.edits.neededBy, 'No rush');
});

test('Apps Script backend requires artwork for every ticket and rejects bot submissions', () => {
  for (const machine of ['printer', 'foam']) {
    assert.throws(() => context.validatePublicTicket_({ ...baseTicket(), machine, files: [] }), /at least one artwork file/i);
  }
  assert.throws(() => context.validatePublicTicket_({ ...baseTicket(), website: 'spam' }), /Unable to accept/i);
  const ticket = context.validatePublicTicket_({
    ...baseTicket(),
    machine: 'printer',
    paperType: 'Canvas',
    files: [{ name: 'art.pdf', type: 'application/pdf', size: 4, data: 'JVBERg==' }],
  });
  assert.equal(ticket.files[0].name, 'art.pdf');
});

test('Apps Script backend enforces machine-specific file formats', () => {
  assert.doesNotThrow(() => context.validatePublicTicket_({
    ...baseTicket(),
    machine: 'printer',
    files: [{ name: 'cut.ai', type: 'application/postscript', size: 4, data: 'QUlGSQ==' }],
  }));
  assert.throws(() => context.validatePublicTicket_({
    ...baseTicket(),
    files: [{ name: 'photo.jpg', type: 'image/jpeg', size: 4, data: '/9j/2Q==' }],
  }), /SVG or DXF/i);
  assert.doesNotThrow(() => context.validatePublicTicket_({
    ...baseTicket(),
    machine: 'printer',
    files: [
      { name: 'art.webp', type: 'image/webp', size: 4, data: 'AAAAAA==' },
      { name: 'phone.heic', type: 'image/heic', size: 4, data: 'AAAAAA==' },
    ],
  }));
});

test('Apps Script backend accepts private Drive receipts up to 200 MB total', () => {
  const ticket = context.validatePublicTicket_({
    ...baseTicket(),
    machine: 'printer',
    paperType: 'Standard',
    files: [{ id: 'drive_file_12345', index: 0, name: 'large-poster.pdf', type: 'application/pdf', size: 200 * 1024 * 1024, md5Checksum: '0123456789abcdef0123456789abcdef' }],
  });
  assert.equal(ticket.files[0].id, 'drive_file_12345');
  assert.equal(ticket.files[0].md5Checksum, '0123456789abcdef0123456789abcdef');
  assert.throws(() => context.validatePublicTicket_({
    ...baseTicket(),
    machine: 'printer',
    paperType: 'Standard',
    files: [
      { id: 'drive_file_12345', index: 0, name: 'one.pdf', type: 'application/pdf', size: 150 * 1024 * 1024, md5Checksum: '0123456789abcdef0123456789abcdef' },
      { id: 'drive_file_67890', index: 1, name: 'two.pdf', type: 'application/pdf', size: 51 * 1024 * 1024, md5Checksum: 'abcdef0123456789abcdef0123456789' },
    ],
  }), /200 MB/i);
});

test('Apps Script backend requires a valid Drive checksum on every direct-upload receipt', () => {
  const request = {
    ...baseTicket(),
    machine: 'printer',
    paperType: 'Standard',
    files: [{ id: 'drive_file_12345', index: 0, name: 'poster.pdf', type: 'application/pdf', size: 4096 }],
  };
  assert.throws(() => context.validatePublicTicket_(request), /integrity check/i);
  assert.throws(() => context.validatePublicTicket_({
    ...request,
    files: [{ ...request.files[0], md5Checksum: 'not-an-md5' }],
  }), /integrity check/i);
});

test('Apps Script backend rejects invalid dimensions, deadlines, keys, and attachments', () => {
  assert.throws(() => context.validatePublicTicket_({ ...baseTicket(), width: '0' }), /valid width/i);
  assert.throws(() => context.validatePublicTicket_({ ...baseTicket(), width: null }), /valid width/i);
  assert.throws(() => context.validatePublicTicket_({ ...baseTicket(), neededBy: 'Eventually' }), /needed/i);
  assert.throws(() => context.validatePublicTicket_({ ...baseTicket(), requestKey: 'short' }), /Refresh/i);
  assert.throws(() => context.validatePublicTicket_({ ...baseTicket(), files: [{ name: 'bad.exe', size: 4, data: 'AAAAAA==' }] }), /SVG or DXF/i);
  assert.throws(() => context.validatePublicTicket_({
    ...baseTicket(),
    files: [{ id: 'drive_file_12345', index: 0, name: 'huge.svg', type: 'image/svg+xml', size: 10 * 1024 * 1024 + 1, md5Checksum: '0123456789abcdef0123456789abcdef' }],
  }), /10 MB/i);
});

test('public queue reads only public columns, caches snapshots, and survives cache failures', () => {
  let reads = 0;
  let cached = null;
  let cacheSeconds = null;
  let failCacheWrites = false;
  const cache = {
    get: () => cached,
    put: (_key, value, seconds) => {
      if (failCacheWrites) throw new Error('cache full');
      cached = value;
      cacheSeconds = seconds;
    },
    remove: () => { cached = null; },
  };
  const isolated = loadContext({ CacheService: { getScriptCache: () => cache } });
  const row = ['id-1', 'P-0001', 'Poster printing', 'Queue Name', '', '', '', 1, '', 24, 36, '', 'Today', 'queued', '', '', '2026-10-26T12:00:00Z'];
  isolated.publicQueueRows_ = () => { reads++; return [row]; };

  assert.equal(isolated.publicWorkshopQueue_().machines[0].tickets[0].ticketNumber, 'P-0001');
  assert.equal(isolated.publicWorkshopQueue_().machines[0].tickets[0].ticketNumber, 'P-0001');
  assert.equal(reads, 1);
  assert.equal(cacheSeconds, 60);

  isolated.invalidatePublicQueueCache_();
  failCacheWrites = true;
  assert.doesNotThrow(() => isolated.publicWorkshopQueue_());
  assert.equal(reads, 2);
  assert.doesNotThrow(() => isolated.invalidatePublicQueueCache_());
});

test('a cold queue fill rechecks the cache under the mutation lock', () => {
  let cached = null;
  let reads = 0;
  const fresh = { ok: true, machines: [{ id: 'printer', tickets: [{ ticketNumber: 'P-0002' }] }] };
  const cache = {
    get: () => cached,
    put: (_key, value) => { cached = value; },
    remove: () => { cached = null; },
  };
  const lock = {
    locked: false,
    waitLock() {
      this.locked = true;
      // A mutation completed after the first cache miss but before this read.
      cached = JSON.stringify(fresh);
    },
    hasLock() { return this.locked; },
    releaseLock() { this.locked = false; },
  };
  const isolated = loadContext({
    CacheService: { getScriptCache: () => cache },
    LockService: { getScriptLock: () => lock },
  });
  isolated.publicQueueRows_ = () => { reads++; return []; };

  assert.deepEqual(JSON.parse(JSON.stringify(isolated.publicWorkshopQueue_())), fresh);
  assert.equal(reads, 0, 'the stale pre-mutation Sheet snapshot must not overwrite the fresh cache');
  assert.equal(lock.locked, false);
});

test('Apps Script re-reads Drive bytes and validates direct print-image and vector uploads', () => {
  const makeContext = content => loadContext({
    ScriptApp: { getOAuthToken: () => 'oauth-token' },
    Utilities: { newBlob: bytes => blob(bytes) },
    UrlFetchApp: {
      fetch(_url, options) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
        assert.ok(match);
        const start = Number(match[1]);
        const end = Number(match[2]);
        return {
          getResponseCode: () => 206,
          getAllHeaders: () => ({ 'Content-Range': `bytes ${start}-${end}/${content.length}` }),
          getBlob: () => blob(content.subarray(start, end + 1)),
        };
      },
    },
  });
  const validPdf = Buffer.from('%PDF-1.7\nbody\n%%EOF\n');
  const valid = makeContext(validPdf);
  assert.doesNotThrow(() => valid.inspectDriveFile_(
    { id: 'drive_file_valid', name: 'poster.pdf' },
    { size: String(validPdf.length) },
    {},
  ));

  const disguised = Buffer.from('not really a pdf');
  const invalid = makeContext(disguised);
  assert.throws(() => invalid.inspectDriveFile_(
    { id: 'drive_file_fake', name: 'poster.pdf' },
    { size: String(disguised.length) },
    {},
  ), /not a valid PDF/i);

  const validJpg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]);
  const image = makeContext(validJpg);
  assert.doesNotThrow(() => image.inspectDriveFile_(
    { id: 'drive_file_image', name: 'photo.jpg' },
    { size: String(validJpg.length) },
    {},
  ));

  const validPng = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex');
  const png = makeContext(validPng);
  assert.doesNotThrow(() => png.inspectDriveFile_(
    { id: 'drive_file_png', name: 'logo.png' },
    { size: String(validPng.length) },
    {},
  ));

  const validTiff = Buffer.from('49492a0008000000', 'hex');
  const tiff = makeContext(validTiff);
  assert.doesNotThrow(() => tiff.inspectDriveFile_(
    { id: 'drive_file_tiff', name: 'photo.tiff' },
    { size: String(validTiff.length) },
    {},
  ));

  const validWebp = Buffer.alloc(20); validWebp.write('RIFF'); validWebp.writeUInt32LE(validWebp.length - 8, 4); validWebp.write('WEBP', 8); validWebp.write('VP8 ', 12);
  const validBmp = Buffer.alloc(26); validBmp.write('BM'); validBmp.writeUInt32LE(validBmp.length, 2); validBmp.writeUInt32LE(12, 14);
  const validDib = Buffer.alloc(12); validDib.writeUInt32LE(12);
  const validIco = Buffer.alloc(22); validIco.writeUInt16LE(1, 2); validIco.writeUInt16LE(1, 4);
  const addedImages = [
    ['animation.gif', Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')],
    ['art.webp', validWebp],
    ['bitmap.bmp', validBmp],
    ['bitmap.dib', validDib],
    ['modern.avif', Buffer.from('0000001466747970617669660000000061766966', 'hex')],
    ['phone.heic', Buffer.from('0000001466747970686569630000000068656963', 'hex')],
    ['phone.heif', Buffer.from('00000014667479706d696631000000006d696631', 'hex')],
    ['icon.ico', validIco],
    ['wide-gamut.jxl', Buffer.from('0000000c4a584c200d0a870a', 'hex')],
  ];
  addedImages.forEach(([name, content]) => {
    const imageContext = makeContext(content);
    assert.doesNotThrow(() => imageContext.inspectDriveFile_(
      { id: `drive_file_${name}`, name },
      { size: String(content.length) },
      {},
    ), name);
  });

  const benignSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="24" height="24" fill="url(#g)"/></svg>');
  const svg = makeContext(benignSvg);
  assert.doesNotThrow(() => svg.inspectDriveFile_(
    { id: 'drive_file_svg', name: 'design.svg' },
    { size: String(benignSvg.length) },
    { getBlob: () => blob(benignSvg) },
  ));

  const benignDxf = Buffer.from('0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n0\n20\n0\n11\n24\n21\n12\n0\nENDSEC\n0\nEOF\n');
  const dxf = makeContext(benignDxf);
  assert.doesNotThrow(() => dxf.inspectDriveFile_(
    { id: 'drive_file_dxf', name: 'design.dxf' },
    { size: String(benignDxf.length) },
    { getBlob: () => blob(benignDxf) },
  ));

  const activeSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const vector = makeContext(activeSvg);
  assert.doesNotThrow(() => vector.inspectDriveFile_(
    { id: 'drive_file_svg', name: 'design.svg' },
    { size: String(activeSvg.length) },
    { getBlob: () => blob(activeSvg) },
  ));

  const remoteSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" fill="url(https://example.invalid/a)"/></svg>');
  const remote = makeContext(remoteSvg);
  assert.doesNotThrow(() => remote.inspectDriveFile_(
    { id: 'drive_file_remote_svg', name: 'design.svg' },
    { size: String(remoteSvg.length) },
    { getBlob: () => blob(remoteSvg) },
  ));
});

test('legacy file inspection matches direct-upload envelopes and accepts arbitrary SVG contents', () => {
  const isolated = loadContext({ Utilities: { newBlob: bytes => blob(bytes) } });
  assert.throws(() => isolated.inspectFile_('fake.pdf', [...Buffer.from('%PDF-EVIL\n%%EOF\n')]), /valid PDF/i);
  assert.throws(() => isolated.inspectFile_('fake.jpg', [0xff, 0xd8, 0x00, 0xff, 0xd9]), /valid JPG/i);
  assert.throws(() => isolated.inspectFile_('cut.png', [...Buffer.from('89504e470d0a1a0a', 'hex')]), /valid PNG/i);
  assert.throws(() => isolated.inspectFile_('fake.tif', [0x49, 0x49, 0, 0]), /valid TIFF/i);
  assert.throws(() => isolated.inspectFile_('fake.gif', [...Buffer.from('GIF89a;')]), /valid GIF/i);
  assert.throws(() => isolated.inspectFile_('fake.webp', [...Buffer.from('RIFFbad WEBP')]), /valid WebP/i);
  assert.throws(() => isolated.inspectFile_('fake.avif', [...Buffer.from('not an avif')]), /valid AVIF/i);
  assert.throws(() => isolated.inspectFile_('fake.heic', [...Buffer.from('not a heic')]), /valid HEIC/i);
  assert.throws(() => isolated.inspectFile_('fake.ico', [0, 0, 1, 0, 1, 0]), /valid ICO/i);
  assert.throws(() => isolated.inspectFile_('fake.jxl', [0xff, 0x0a]), /valid JPEG XL/i);

  const exportedSvg = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!-- Generator: a vector editor -->\n'
    + '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
  assert.doesNotThrow(() => isolated.inspectFile_('exported.svg', [...Buffer.from(exportedSvg)]));

  const invalidSvg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" width="2"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><text>&custom;</text></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 < 1"/></svg>',
    '<?xml-stylesheet href="https://example.invalid/a.css"?><svg xmlns="http://www.w3.org/2000/svg"/>',
    '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><![CDATA[unparsed text]]></svg>',
    '<!-- broken -- comment --><svg xmlns="http://www.w3.org/2000/svg"/>',
  ];
  invalidSvg.forEach(value => assert.doesNotThrow(
    () => isolated.inspectFile_('accepted.svg', [...Buffer.from(value)]),
  ));
});

test('inline DXF artwork is validated and written to the configured private Drive folder', () => {
  const contents = Buffer.from('0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n0\n20\n0\n11\n24\n21\n12\n0\nENDSEC\n0\nEOF\n');
  const created = [];
  const isolated = loadContext({
    Utilities: {
      base64Decode: value => Array.from(Buffer.from(value, 'base64')),
      newBlob: (bytes, type, name) => ({ ...blob(bytes), type, name }),
    },
    DriveApp: {
      getFolderById: id => ({
        createFile(fileBlob) {
          created.push({ folderId: id, fileBlob });
          return {
            getName: () => fileBlob.name,
            getUrl: () => 'https://drive.google.com/file/d/inline_dxf_file/view',
            setTrashed() {},
          };
        },
      }),
    },
  });
  const transaction = [];
  const links = isolated.saveFiles_([{
    name: 'foam-layout.dxf',
    type: 'image/vnd.dxf',
    size: contents.length,
    data: contents.toString('base64'),
  }], 'F-0046', '6'.repeat(32), propertiesStore({ UPLOAD_FOLDER_ID: 'private-folder' }), transaction);

  assert.deepEqual([...links], ['F-0046-1-foam-layout.dxf — https://drive.google.com/file/d/inline_dxf_file/view']);
  assert.equal(created.length, 1);
  assert.equal(created[0].folderId, 'private-folder');
  assert.equal(created[0].fileBlob.name, 'F-0046-1-foam-layout.dxf');
  assert.equal(transaction.length, 1, 'the new Drive file must participate in ticket rollback');
});

test('upload reservation retries charge daily bytes exactly once per request file', () => {
  const properties = propertiesStore({});
  const isolated = loadContext({
    Utilities: { formatDate: () => '2026-10-18' },
    Session: { getScriptTimeZone: () => 'America/New_York' },
  });
  const requestKey = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const size = 38 * 1024 * 1024;

  const first = isolated.checkUploadReservation_(properties, requestKey, 0, size);
  isolated.commitUploadReservation_(properties, first, 0, size);
  assert.equal(properties.getProperty('DAILY_UPLOAD_BYTES'), `2026-10-18:${size}`);

  const retry = isolated.checkUploadReservation_(properties, requestKey, 0, size);
  isolated.commitUploadReservation_(properties, retry, 0, size);
  assert.equal(properties.getProperty('DAILY_UPLOAD_BYTES'), `2026-10-18:${size}`, 'retrying the same file must not consume the quota twice');

  const secondFile = isolated.checkUploadReservation_(properties, requestKey, 1, 1024);
  isolated.commitUploadReservation_(properties, secondFile, 1, 1024);
  assert.equal(properties.getProperty('DAILY_UPLOAD_BYTES'), `2026-10-18:${size + 1024}`);
});

test('inline vector uploads use the same idempotent daily byte ledger', () => {
  const requestKey = '8'.repeat(32);
  const properties = propertiesStore({});
  const isolated = loadContext({
    Utilities: { formatDate: () => '2026-10-27' },
    Session: { getScriptTimeZone: () => 'America/New_York' },
  });
  const request = {
    requestKey,
    files: [
      { name: 'one.dxf', size: 2048, data: 'AA==' },
      { id: 'drive_file_large', name: 'large.dxf', size: 4096 },
      { name: 'two.svg', size: 1024, data: 'AA==' },
    ],
  };

  isolated.reserveInlineUploads_(properties, request);
  assert.equal(properties.getProperty('DAILY_UPLOAD_BYTES'), '2026-10-27:3072');
  isolated.reserveInlineUploads_(properties, request);
  assert.equal(properties.getProperty('DAILY_UPLOAD_BYTES'), '2026-10-27:3072', 'retrying must not consume the quota twice');
});

test('abandoned upload cleanup trashes only expired pending files and removes stale reservations', () => {
  const now = Date.now();
  const oldKey = `UPLOAD_${'a'.repeat(32)}`;
  const freshKey = `UPLOAD_${'b'.repeat(32)}`;
  const oldFailureKey = `FAILED_${'c'.repeat(32)}`;
  const freshFailureKey = `FAILED_${'d'.repeat(32)}`;
  const properties = propertiesStore({
    UPLOAD_FOLDER_ID: 'private-folder',
    [oldKey]: JSON.stringify({ created: now - 25 * 60 * 60 * 1000, files: { 0: 10 } }),
    [freshKey]: JSON.stringify({ created: now - 60 * 60 * 1000, files: { 0: 10 } }),
    [oldFailureKey]: JSON.stringify({ at: now - 25 * 60 * 60 * 1000, error: 'old' }),
    [freshFailureKey]: JSON.stringify({ at: now - 60 * 60 * 1000, error: 'fresh' }),
  });
  const files = [
    { name: `.mandir-pending-${'a'.repeat(32)}-0-old.pdf`, created: now - 25 * 60 * 60 * 1000, trashed: false },
    { name: `.mandir-pending-${'b'.repeat(32)}-0-new.pdf`, created: now - 60 * 60 * 1000, trashed: false },
    { name: 'P-0001-1-poster.pdf', created: now - 25 * 60 * 60 * 1000, trashed: false },
  ].map(record => ({
    record,
    getName: () => record.name,
    getDateCreated: () => new Date(record.created),
    setTrashed: value => { record.trashed = value; },
  }));
  let index = 0;
  const isolated = loadContext({
    console: { ...console, log() {} },
    PropertiesService: { getScriptProperties: () => properties },
    DriveApp: { getFolderById: () => ({ getFiles: () => ({ hasNext: () => index < files.length, next: () => files[index++] }) }) },
  });

  assert.equal(isolated.cleanupAbandonedUploads(), 1);
  assert.equal(files[0].record.trashed, true);
  assert.equal(files[1].record.trashed, false);
  assert.equal(files[2].record.trashed, false);
  assert.equal(properties.getProperty(oldKey), null);
  assert.notEqual(properties.getProperty(freshKey), null);
  assert.equal(properties.getProperty(oldFailureKey), null);
  assert.notEqual(properties.getProperty(freshFailureKey), null);
});

test('beginUpload binds Drive ownership metadata and requests an MD5 receipt', () => {
  const properties = propertiesStore({ UPLOAD_FOLDER_ID: 'private-folder' });
  let driveRequest;
  const lock = {
    waitLock() {},
    hasLock: () => true,
    releaseLock() {},
  };
  const isolated = loadContext({
    PropertiesService: { getScriptProperties: () => properties },
    LockService: { getScriptLock: () => lock },
    Utilities: { formatDate: () => '2026-10-18' },
    Session: { getScriptTimeZone: () => 'America/New_York' },
    ScriptApp: { getOAuthToken: () => 'oauth-token' },
    UrlFetchApp: {
      fetch(url, options) {
        driveRequest = { url, options };
        return {
          getResponseCode: () => 200,
          getAllHeaders: () => ({ Location: 'https://www.googleapis.com/upload/session-id' }),
        };
      },
    },
  });
  const requestKey = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  const upload = {
    requestKey,
    startedAt: Date.now() - 2000,
    machine: 'printer',
    index: '0',
    name: 'poster.pdf',
    type: 'application/pdf',
    size: '4096',
    origin: 'https://demandir.github.io',
  };
  assert.throws(() => isolated.beginUpload_({ ...upload, origin: 'https://shailp08.github.io' }), /open the ticket form/i);
  assert.equal(driveRequest, undefined);
  const result = isolated.beginUpload_(upload);

  assert.equal(result.sessionUrl, 'https://www.googleapis.com/upload/session-id');
  assert.match(driveRequest.url, /fields=.*md5Checksum/i);
  assert.deepEqual(JSON.parse(driveRequest.options.payload).appProperties, {
    mandirRequestKey: requestKey,
    mandirIndex: '0',
  });
});

test('Drive file verification checks ownership, byte count, and checksum and remains retryable after rename', () => {
  const requestKey = 'cccccccccccccccccccccccccccccccc';
  const checksum = 'abcdef0123456789abcdef0123456789';
  const metadata = {
    id: 'drive_file_12345',
    name: 'already-renamed.pdf',
    size: '4096',
    parents: ['private-folder'],
    trashed: false,
    md5Checksum: checksum,
    appProperties: { mandirRequestKey: requestKey, mandirIndex: '0' },
  };
  const names = [];
  const uploaded = {
    name: metadata.name,
    setName(name) { this.name = name; names.push(name); },
    getName() { return this.name; },
    getUrl: () => 'https://drive.example/file',
  };
  const isolated = loadContext({
    ScriptApp: { getOAuthToken: () => 'oauth-token' },
    UrlFetchApp: {
      fetch: () => ({
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify(metadata),
      }),
    },
    DriveApp: {
      getFolderById: () => ({ createFile() { throw new Error('legacy upload was not expected'); } }),
      getFileById: () => uploaded,
    },
  });
  let inspections = 0;
  isolated.inspectDriveFile_ = () => { inspections++; };
  const properties = propertiesStore({ UPLOAD_FOLDER_ID: 'private-folder' });
  const receipt = [{
    id: metadata.id,
    index: 0,
    name: 'poster.pdf',
    type: 'application/pdf',
    size: 4096,
    md5Checksum: checksum,
  }];

  const first = isolated.saveFiles_(receipt, 'P-0001', requestKey, properties);
  const retry = isolated.saveFiles_(receipt, 'P-0001', requestKey, properties);
  assert.deepEqual([...first], ['P-0001-1-poster.pdf — https://drive.example/file']);
  assert.deepEqual([...retry], first);
  assert.deepEqual(names, ['P-0001-1-poster.pdf', 'P-0001-1-poster.pdf']);
  assert.equal(inspections, 2);

  assert.throws(() => isolated.saveFiles_([{ ...receipt[0], md5Checksum: '00000000000000000000000000000000' }], 'P-0001', requestKey, properties), /integrity check/i);
});

test('all Drive receipts are verified before any pending file is renamed', () => {
  const requestKey = 'e'.repeat(32);
  const checksum = 'abcdef0123456789abcdef0123456789';
  const renamed = [];
  const metadata = {
    drive_file_first: { name: '.mandir-pending-first.pdf', size: '100', md5Checksum: checksum, appProperties: { mandirRequestKey: requestKey, mandirIndex: '0' } },
    drive_file_second: { name: '.mandir-pending-second.pdf', size: '100', md5Checksum: '00000000000000000000000000000000', appProperties: { mandirRequestKey: requestKey, mandirIndex: '1' } },
  };
  const isolated = loadContext({
    ScriptApp: { getOAuthToken: () => 'oauth-token' },
    UrlFetchApp: { fetch: url => {
      const id = /files\/([^?]+)/.exec(url)[1];
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ...metadata[id], parents: ['private-folder'], trashed: false }) };
    } },
    DriveApp: {
      getFolderById: () => ({}),
      getFileById: id => ({ setName: name => renamed.push([id, name]), getName: () => metadata[id].name, getUrl: () => `https://drive.example/${id}` }),
    },
  });
  isolated.inspectDriveFile_ = () => {};
  const files = ['first', 'second'].map((name, index) => ({
    id: `drive_file_${name}`,
    index,
    name: `${name}.pdf`,
    type: 'application/pdf',
    size: 100,
    md5Checksum: checksum,
  }));

  assert.throws(() => isolated.saveFiles_(files, 'P-0001', requestKey, propertiesStore({ UPLOAD_FOLDER_ID: 'private-folder' })), /integrity check/i);
  assert.deepEqual(renamed, []);
});

test('duplicate createTicket requests write one Sheet row and reuse the first ticket', () => {
  const properties = propertiesStore({
    TELEGRAM_BOT_TOKEN: `123456:${'a'.repeat(30)}`,
    TELEGRAM_BOT_USERNAME: 'DelMandirDesignbot',
  });
  let rowWritten = false;
  let fileSaves = 0;
  let dailyIncrements = 0;
  const writtenRows = [];
  const statusValidations = [];
  const lock = {
    locked: false,
    waitLock() { this.locked = true; },
    hasLock() { return this.locked; },
    releaseLock() { this.locked = false; },
  };
  const sheet = {
    getLastRow: () => rowWritten ? 2 : 1,
    getRange: (_row, column) => ({
      setValues(rows) {
        rowWritten = true;
        writtenRows.push(...rows);
      },
      getDisplayValue: () => column === 32 ? writtenRows[0]?.[31] || '' : '',
      setValue(value) { if (column === 32 && writtenRows[0]) writtenRows[0][31] = value; },
      setDataValidation(value) { if (column === 14) statusValidations.push(value); },
    }),
  };
  const isolated = loadContext({
    console: { ...console, error() {} },
    LockService: { getScriptLock: () => lock },
    PropertiesService: { getScriptProperties: () => properties },
    SpreadsheetApp: {
      flush() {},
      newDataValidation: () => ({
        requireValueInList() { return this; },
        setAllowInvalid() { return this; },
        build() { return 'current-status-validation'; },
      }),
    },
    Utilities: { getUuid: () => 'ticket-uuid' },
  });
  isolated.validatePublicTicket_ = input => ({ ...baseTicket(), ...input, machine: 'foam', files: [] });
  isolated.requestFingerprint_ = request => JSON.stringify({ customerName: request.customerName, files: request.files });
  isolated.ensureTicketSheet_ = () => sheet;
  isolated.openBook_ = () => ({});
  isolated.findRow_ = () => rowWritten ? 2 : 0;
  isolated.enforceDailyLimit_ = () => {};
  isolated.nextTicketNumber_ = () => 'F-0001';
  isolated.randomCode_ = () => 'ABCD2345';
  isolated.saveFiles_ = () => { fileSaves++; return []; };
  isolated.incrementDailyCount_ = () => { dailyIncrements++; };
  isolated.escapeCell_ = value => value;
  isolated.jsonResponse_ = value => value;

  const event = { postData: { contents: JSON.stringify(baseTicket()) } };
  const first = isolated.doPost(event);
  const duplicate = isolated.doPost(event);
  const mismatch = isolated.doPost({ postData: { contents: JSON.stringify({ ...baseTicket(), customerName: 'Changed Person' }) } });

  assert.equal(first.ok, true);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /different details or files/i);
  assert.equal(writtenRows.length, 1);
  assert.equal(writtenRows[0][13], 'pending-review');
  assert.equal(writtenRows[0].length, 32);
  assert.equal(writtenRows[0].slice(22, 27).join(','), ',,,,');
  assert.equal(writtenRows[0][27], '[]');
  assert.equal(writtenRows[0][28], '[]');
  assert.deepEqual(statusValidations, ['current-status-validation']);
  assert.equal(fileSaves, 1);
  assert.equal(dailyIncrements, 1);
});
