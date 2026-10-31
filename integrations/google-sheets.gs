// Mandir Workshop Tickets — Google Sheets + Drive backend for GitHub Pages.
// Bind this script to a private Google Sheet, run setupMandirTicketSystem once,
// then deploy it as a web app that executes as you and is reachable by Anyone.

var TICKET_SHEET = 'Tickets';
var TELEGRAM_SUBSCRIPTIONS_SHEET = 'Telegram Subscriptions';
var TELEGRAM_OUTBOX_SHEET = 'Telegram Outbox';
var HEADERS = [
  'Ticket ID', 'Queue number', 'Machine', 'Name', 'Department', 'Purpose', 'Phone',
  'Quantity', 'Paper', 'Width (in)', 'Length (in)', 'Thickness (in)', 'Needed by',
  'Status', 'Notes', 'Files', 'Created', 'Updated', 'Revision',
  'Tracking code', 'Request key', 'Source', 'Customer email', 'Last notified status',
  'Approx. cost (USD)', 'Cost basis', 'Cost estimate version',
  'Material usage', 'Staff history', 'SMS consent', 'Review reason', 'Request fingerprint'
];
var TELEGRAM_SUBSCRIPTION_HEADERS = [
  'Ticket ID', 'Ticket number', 'Chat ID', 'User ID', 'State',
  'Linked at', 'Disabled at', 'Link token hash', 'Link token expires', 'Link issued at'
];
var TELEGRAM_OUTBOX_HEADERS = [
  'Event ID', 'Ticket ID', 'Ticket number', 'Audience', 'Chat ID', 'Status',
  'Message', 'State', 'Attempts', 'Next attempt', 'Created', 'Updated',
  'Telegram message ID', 'Detail'
];
var TELEGRAM_SUB = { TICKET_ID: 0, TICKET_NUMBER: 1, CHAT_ID: 2, USER_ID: 3, STATE: 4, LINKED_AT: 5, DISABLED_AT: 6, TOKEN_HASH: 7, TOKEN_EXPIRES: 8, TOKEN_ISSUED: 9 };
var TELEGRAM_OUT = { EVENT_ID: 0, TICKET_ID: 1, TICKET_NUMBER: 2, AUDIENCE: 3, CHAT_ID: 4, STATUS: 5, MESSAGE: 6, STATE: 7, ATTEMPTS: 8, NEXT_ATTEMPT: 9, CREATED: 10, UPDATED: 11, MESSAGE_ID: 12, DETAIL: 13 };
var STATUSES = ['pending-review', 'declined', 'queued', 'in-progress', 'ready', 'collected', 'cancelled'];
var TELEGRAM_PUSH_STATUSES = ['ready', 'declined'];
var MACHINES = { printer: 'Poster printing', foam: 'Foam cutting' };
var PAPER_TYPES = ['Polypropylene', 'Adhesive', 'Canvas', 'Glossy', 'Standard'];
var DEADLINES = ['Today', 'Tomorrow', 'This week', 'No rush'];
var MAX_FILES = 5;
var MAX_FILE_BYTES = 200 * 1024 * 1024;
var MAX_TOTAL_BYTES = 200 * 1024 * 1024;
var MAX_VECTOR_FILE_BYTES = 10 * 1024 * 1024;
var LEGACY_MAX_FILE_BYTES = 5 * 1024 * 1024;
var LEGACY_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
var DEFAULT_DAILY_LIMIT = 250;
var DEFAULT_DAILY_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
var PUBLIC_QUEUE_CACHE_KEY = 'PUBLIC_QUEUE_V2';
var PUBLIC_QUEUE_CACHE_SECONDS = 60;
var FAILED_REQUEST_PREFIX = 'FAILED_';
var FAILED_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
var TELEGRAM_LINK_TTL_MS = 24 * 60 * 60 * 1000;
var TELEGRAM_STALE_SEND_MS = 5 * 60 * 1000;
var TELEGRAM_SEND_BATCH_SIZE = 20;
var TELEGRAM_STAFF_MESSAGE_CHUNK = 3700;
var DEFAULT_UPLOAD_ORIGINS = [
  'https://shailp08.github.io',
  'http://127.0.0.1:4177',
  'http://localhost:4177',
  'http://localhost:5173'
];

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Ticket system')
    .addItem('Set up backend', 'setupMandirTicketSystem')
    .addItem('Set up Telegram notifications', 'setupTelegramNotifications')
    .addItem('Show Telegram setup status', 'showTelegramSetupStatus')
    .addItem('Send Telegram staff test', 'sendTelegramStaffTest')
    .addItem('Refresh sheet formatting', 'formatTicketSheet')
    .addItem('Audit ticket files', 'showTicketPipelineAudit')
    .addItem('Clean abandoned uploads', 'cleanupAbandonedUploads')
    .addToUi();
}

function setupMandirTicketSystem() {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  if (!book) throw new Error('Open this script from the Google Sheet before running setup.');
  var properties = PropertiesService.getScriptProperties();
  properties.setProperty('SPREADSHEET_ID', book.getId());
  if (!properties.getProperty('UPLOAD_FOLDER_ID')) {
    properties.setProperty('UPLOAD_FOLDER_ID', DriveApp.createFolder('Mandir Workshop Ticket Files').getId());
  }
  ensureTicketSheet_(book);
  ensureTelegramSheets_(book);
  authorizeLargeFileUploads();
  formatTicketSheet();
  SpreadsheetApp.getUi().alert('The private ticket sheet and Drive upload folder are ready. Deploy this script as a web app next.');
}

function setupTelegramNotifications() {
  var properties = PropertiesService.getScriptProperties();
  var token = String(properties.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!/^\d{6,15}:[A-Za-z0-9_-]{30,}$/.test(token)) {
    throw new Error('Add a fresh TELEGRAM_BOT_TOKEN in Apps Script Properties first. Never store it in the Sheet or source code.');
  }
  var identity = telegramApiRequest_('getMe', {}, token);
  if (!identity.ok || !identity.result || !identity.result.username) throw new Error('Telegram could not verify this bot token. Revoke it in BotFather and add the replacement token to Script Properties.');
  var username = String(identity.result.username).replace(/^@/, '');
  properties.setProperty('TELEGRAM_BOT_USERNAME', username);
  ensureTelegramSheets_(openBook_());

  var webhook = telegramApiRequest_('deleteWebhook', { drop_pending_updates: false }, token);
  if (!webhook.ok) throw new Error('Telegram could not switch the bot to polling mode. Check the token and try again.');
  var commands = telegramApiRequest_('setMyCommands', { commands: [
    { command: 'status', description: 'Show linked ticket status' },
    { command: 'stop', description: 'Turn off ticket notifications' },
    { command: 'help', description: 'Show bot help' }
  ] }, token);
  if (!commands.ok) throw new Error('Telegram could not configure the bot commands. Check the token and try again.');

  var code = randomCode_(10);
  properties.setProperty('TELEGRAM_STAFF_REGISTRATION_CODE', code);
  properties.setProperty('TELEGRAM_STAFF_REGISTRATION_EXPIRES', String(Date.now() + TELEGRAM_LINK_TTL_MS));
  var hasTrigger = ScriptApp.getProjectTriggers().some(function(trigger) {
    return trigger.getHandlerFunction() === 'processTelegramNotifications';
  });
  if (!hasTrigger) ScriptApp.newTrigger('processTelegramNotifications').timeBased().everyMinutes(1).create();

  SpreadsheetApp.getUi().alert(
    'Telegram polling is enabled for @' + username + '.\n\n' +
    'Add the bot to the private staff group, then send this command in that group within 24 hours:\n\n' +
    '/registerstaff ' + code + '\n\n' +
    'The bot token stays in Script Properties and is never written to the Sheet.'
  );
  return { ok: true, username: username, staffRegistered: Boolean(properties.getProperty('TELEGRAM_STAFF_CHAT_ID')) };
}

function showTelegramSetupStatus() {
  var properties = PropertiesService.getScriptProperties();
  var username = telegramBotUsername_(properties);
  var hasTrigger = ScriptApp.getProjectTriggers().some(function(trigger) {
    return trigger.getHandlerFunction() === 'processTelegramNotifications';
  });
  var latest = 'none recorded';
  try {
    var outbox = openBook_().getSheetByName(TELEGRAM_OUTBOX_SHEET);
    var staffRows = outbox ? telegramSheetRows_(outbox, TELEGRAM_OUTBOX_HEADERS.length).filter(function(row) {
      return String(row[TELEGRAM_OUT.AUDIENCE]) === 'staff';
    }) : [];
    if (staffRows.length) {
      var row = staffRows[staffRows.length - 1];
      latest = [telegramText_(row[TELEGRAM_OUT.TICKET_NUMBER]) || 'setup message', String(row[TELEGRAM_OUT.STATUS]), String(row[TELEGRAM_OUT.STATE])].filter(Boolean).join(' · ');
      if (row[TELEGRAM_OUT.DETAIL]) latest += ' · ' + String(row[TELEGRAM_OUT.DETAIL]);
    }
  } catch (_error) { latest = 'could not read delivery journal'; }
  var lines = [
    'Bot: ' + (username ? '@' + username : 'not configured'),
    'Polling trigger: ' + (hasTrigger ? 'installed' : 'not installed'),
    'Private staff group: ' + (properties.getProperty('TELEGRAM_STAFF_CHAT_ID') ? 'registered' : 'not registered'),
    'Latest staff delivery: ' + latest
  ];
  SpreadsheetApp.getUi().alert(lines.join('\n'));
  return { configured: Boolean(username && properties.getProperty('TELEGRAM_BOT_TOKEN')), trigger: hasTrigger, staffRegistered: Boolean(properties.getProperty('TELEGRAM_STAFF_CHAT_ID')), latestStaffDelivery: latest };
}

function sendTelegramStaffTest() {
  var properties = PropertiesService.getScriptProperties();
  var token = String(properties.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  var chatId = String(properties.getProperty('TELEGRAM_STAFF_CHAT_ID') || '').trim();
  if (!/^\d{6,15}:[A-Za-z0-9_-]{30,}$/.test(token)) throw new Error('Telegram is not configured. Add the fresh bot token to Apps Script Properties and run Telegram setup.');
  if (!/^-?\d+$/.test(chatId)) throw new Error('The private staff group is not registered. Run Telegram setup and send the one-time registration command in the group.');
  var response = telegramApiRequest_('sendMessage', {
    chat_id: chatId,
    text: 'Telegram staff notifications are connected.',
    disable_web_page_preview: true
  }, token);
  if (!response.ok) {
    var detail = String(response.description || 'Telegram rejected the test message.').replace(/\s+/g, ' ').trim().slice(0, 220);
    throw new Error('The bot could not post to the registered staff group: ' + detail + ' Check the group permissions or register the group again.');
  }
  SpreadsheetApp.getUi().alert('Telegram test sent to the registered private staff group.');
  return { ok: true, messageId: String(response.result && response.result.message_id || '') };
}

function authorizeLargeFileUploads() {
  var response = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files%28id%29', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) throw new Error('Google Drive upload authorization failed with status ' + response.getResponseCode() + '.');
  return true;
}

function auditTicketPipeline() {
  var sheet = ensureTicketSheet_(openBook_());
  var folderId = PropertiesService.getScriptProperties().getProperty('UPLOAD_FOLDER_ID');
  if (!folderId) throw new Error('The upload folder is not configured. Run setup again.');
  var rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).getDisplayValues() : [];
  var report = { ok: true, tickets: rows.length, files: 0, verifiedBytes: 0, verifiedChecksums: 0, errors: [] };
  rows.forEach(function(row, rowIndex) {
    var ticketNumber = String(row[1] || 'row ' + (rowIndex + 2));
    String(row[15] || '').split('\n').filter(String).forEach(function(entry) {
      report.files++;
      var match = /\/d\/([A-Za-z0-9_-]{10,200})/.exec(entry);
      if (!match) {
        report.errors.push(ticketNumber + ': invalid Drive link');
        return;
      }
      try {
        var metadata = getDriveFileMetadata_(match[1]);
        if (metadata.trashed || metadata.parents.indexOf(folderId) === -1) report.errors.push(ticketNumber + ': file is outside the private upload folder');
        if (!Number(metadata.size) || !/^[a-f0-9]{32}$/i.test(String(metadata.md5Checksum || ''))) report.errors.push(ticketNumber + ': file is empty or missing its Drive checksum');
        else {
          report.verifiedBytes += Number(metadata.size);
          report.verifiedChecksums++;
        }
        if (String(metadata.name || '').indexOf(ticketNumber + '-') !== 0) report.errors.push(ticketNumber + ': file name does not match the ticket');
      } catch (_error) {
        report.errors.push(ticketNumber + ': Drive file could not be read');
      }
    });
  });
  report.ok = report.errors.length === 0;
  console.log(JSON.stringify(report));
  return report;
}

function showTicketPipelineAudit() {
  var report = auditTicketPipeline();
  var message = report.ok
    ? 'Audit passed: ' + report.tickets + ' tickets and ' + report.files + ' files are linked correctly.'
    : 'Audit found ' + report.errors.length + ' problem(s):\n\n' + report.errors.slice(0, 20).join('\n');
  SpreadsheetApp.getUi().alert(message);
}

function formatTicketSheet() {
  var book = openBook_();
  var sheet = ensureTicketSheet_(book);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, HEADERS.length)
    .setFontWeight('bold')
    .setBackground('#1d3a29')
    .setFontColor('#ffffff');
  sheet.setColumnWidths(1, HEADERS.length, 120);
  sheet.setColumnWidth(2, 105);
  sheet.setColumnWidth(4, 150);
  sheet.setColumnWidth(6, 260);
  sheet.setColumnWidth(15, 260);
  sheet.setColumnWidth(16, 260);
  sheet.hideColumns(1);
  sheet.hideColumns(20, 2);
  sheet.hideColumns(32);
  sheet.getRange(2, 14, Math.max(sheet.getMaxRows() - 1, 1), 1).setDataValidation(ticketStatusValidation_());
  return true;
}

function doPost(event) {
  var lock = LockService.getScriptLock();
  var input = {};
  var fileChanges = [];
  var rowCommitted = false;
  try {
    var raw = event && event.postData ? event.postData.contents : '';
    input = JSON.parse(raw || (event && event.parameter && event.parameter.payload) || '{}');

    if (input.action === 'publicQueue') return jsonResponse_(publicWorkshopQueue_());
    if (['staffList', 'staffUpdate', 'staffUsage', 'adminReview'].indexOf(input.action) !== -1) {
      input._telegramStatusCommitted = false;
      var staffResponse = staffAction_(input, lock, input.publicStaff === true);
      if (lock.hasLock()) lock.releaseLock();
      if (input._telegramStatusCommitted) {
        try { processTelegramTicketNotifications_(input.id); }
        catch (telegramError) { console.error('Immediate Telegram delivery failed: ' + safeError_(telegramError)); }
      }
      return staffResponse;
    }
    // Preserve compatibility with the optional Node server's authenticated Sheets mirror.
    if (Array.isArray(input.row)) return syncServerRow_(input, lock);
    if (input.action !== 'createTicket') return jsonResponse_({ ok: false, error: 'Unsupported action.' });

    clearTicketFailure_(input.requestKey);
    var request = validatePublicTicket_(input);
    var requestFingerprint = requestFingerprint_(request);
    lock.waitLock(20000);
    var properties = PropertiesService.getScriptProperties();
    var sheet = ensureTicketSheet_(openBook_());
    var existing = findRow_(sheet, 21, request.requestKey);
    if (existing) {
      var existingFingerprint = String(sheet.getRange(existing, 32).getDisplayValue() || '');
      if (existingFingerprint && existingFingerprint !== requestFingerprint) throw new Error('This request was already saved with different details or files. Reload the form to start a new request.');
      if (!existingFingerprint) sheet.getRange(existing, 32).setValue(requestFingerprint);
      properties.deleteProperty(uploadReservationKey_(request.requestKey));
      properties.deleteProperty(requestFailureKey_(request.requestKey));
      return jsonResponse_({ ok: true, duplicate: true });
    }
    enforceDailyLimit_(properties);
    reserveInlineUploads_(properties, request);

    var ticketNumber = nextTicketNumber_(sheet, request.machine);
    var trackingCode = randomCode_(8);
    var createdAt = new Date();
    var uploadedFiles = saveFiles_(request.files, ticketNumber, request.requestKey, properties, fileChanges);
    var row = [
      Utilities.getUuid(), ticketNumber, MACHINES[request.machine], request.customerName,
      request.department, request.purpose, request.phone, request.quantity,
      request.paperType, request.width, request.length, request.thickness,
      request.neededBy, 'pending-review', request.notes, uploadedFiles.join('\n'),
      createdAt, createdAt, 1, trackingCode, request.requestKey, 'GitHub Pages',
      '', '', '', '', '', '[]', '[]', request.smsConsent ? 'yes' : '', '', requestFingerprint
    ];
    var targetRow = sheet.getLastRow() + 1;
    // A deployed backend can add statuses before the bound Sheet is reformatted.
    // Refresh the destination cell's validation so an old rule cannot reject the row.
    sheet.getRange(targetRow, 14).setDataValidation(ticketStatusValidation_());
    sheet.getRange(targetRow, 1, 1, HEADERS.length).setValues([row.map(escapeCell_)]);
    rowCommitted = true;
    SpreadsheetApp.flush();
    invalidatePublicQueueCache_();
    incrementDailyCount_(properties);
    properties.deleteProperty(uploadReservationKey_(request.requestKey));
    properties.deleteProperty(requestFailureKey_(request.requestKey));
    var createResponse = jsonResponse_({ ok: true });
    if (lock.hasLock()) lock.releaseLock();
    try { processTelegramTicketNotifications_(String(row[0])); }
    catch (telegramError) { console.error('Immediate Telegram delivery failed: ' + safeError_(telegramError)); }
    return createResponse;
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    if (!rowCommitted) rollbackSavedFiles_(fileChanges);
    rememberTicketFailure_(input && input.requestKey, error);
    return jsonResponse_({ ok: false, error: safeError_(error) });
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function doGet(event) {
  var callback = String(event && event.parameter && event.parameter.callback || '');
  if (!/^[A-Za-z_$][\w$]{0,80}$/.test(callback)) return jsonResponse_({ ok: false, error: 'A valid callback is required.' });
  var params = event.parameter || {};
  try {
    if (params.action === 'queue') return javascriptResponse_(callback, publicWorkshopQueue_());
    if (params.action === 'health') return javascriptResponse_(callback, { ok: true, service: 'Mandir Workshop Tickets' });
    if (params.action === 'staffList' && params.publicStaff === 'true') return javascriptResponse_(callback, publicStaffList_());
    if (params.action === 'beginUpload') return javascriptResponse_(callback, beginUpload_(params));
    if (params.action !== 'track') return javascriptResponse_(callback, { ok: false, error: 'Unsupported action.' });
    return javascriptResponse_(callback, trackTicket_(params));
  } catch (error) {
    var retryableRequestKey = params.action === 'track' && /^[a-f0-9]{32}$/.test(String(params.requestKey || '').toLowerCase());
    return javascriptResponse_(callback, { ok: false, pending: retryableRequestKey || undefined, error: safeError_(error) });
  }
}

function trackTicket_(params) {
  var book = openBook_();
  var sheet = ensureTicketSheet_(book);
  var rowNumber = 0;
  var byRequestKey = String(params.requestKey || '').toLowerCase();
  if (/^[a-f0-9]{32}$/.test(byRequestKey)) {
    rowNumber = findRow_(sheet, 21, byRequestKey);
    if (!rowNumber) {
      var failure = readTicketFailure_(byRequestKey);
      if (failure) return { ok: false, pending: false, error: failure.error };
      return { ok: false, pending: true, error: 'The ticket is still being saved.' };
    }
  } else {
    var number = String(params.ticket || '').trim().toUpperCase();
    var code = String(params.code || '').trim().toUpperCase();
    if (!/^[PF]-\d{4,8}$/.test(number) || !/^[A-Z2-9]{8}$/.test(code)) throw new Error('Enter the ticket number and tracking code from the receipt.');
    rowNumber = findRow_(sheet, 2, number);
    if (!rowNumber) throw new Error('Ticket not found. Check the number on the receipt.');
    if (String(sheet.getRange(rowNumber, 20).getDisplayValue()).toUpperCase() !== code) throw new Error('Ticket not found. Check the number and tracking code.');
  }
  var row = sheet.getRange(rowNumber, 1, 1, HEADERS.length).getValues()[0];
  var status = String(row[13] || '').toLowerCase();
  var position = activePosition_(sheet, rowNumber, String(row[2]), status);
  var ticket = {
    ticketNumber: String(row[1]),
    trackingCode: String(row[19]),
    machineName: String(row[2]),
    status: status,
    position: position,
    reason: String(row[30] || ''),
    createdAt: row[16] instanceof Date ? row[16].toISOString() : String(row[16])
  };
  var telegram = telegramLinkForTicket_(book, { id: String(row[0]), ticketNumber: ticket.ticketNumber });
  if (telegram) {
    ticket.telegramLinked = telegram.linked;
    if (telegram.url) ticket.telegramLink = telegram.url;
  }
  return { ok: true, ticket: ticket };
}

function ticketStatusValidation_() {
  return SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).setAllowInvalid(false).build();
}

function requestFailureKey_(requestKey) {
  return FAILED_REQUEST_PREFIX + String(requestKey || '').toLowerCase();
}

function clearTicketFailure_(requestKey) {
  var normalized = String(requestKey || '').toLowerCase();
  if (/^[a-f0-9]{32}$/.test(normalized)) PropertiesService.getScriptProperties().deleteProperty(requestFailureKey_(normalized));
}

function rememberTicketFailure_(requestKey, error) {
  var normalized = String(requestKey || '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(normalized)) return;
  PropertiesService.getScriptProperties().setProperty(requestFailureKey_(normalized), JSON.stringify({
    at: Date.now(),
    error: safeError_(error)
  }));
}

function readTicketFailure_(requestKey) {
  var properties = PropertiesService.getScriptProperties();
  var key = requestFailureKey_(requestKey);
  var failure;
  try { failure = JSON.parse(properties.getProperty(key) || 'null'); } catch (_error) { failure = null; }
  if (!failure || !Number.isFinite(Number(failure.at)) || Date.now() - Number(failure.at) > FAILED_REQUEST_TTL_MS) {
    properties.deleteProperty(key);
    return null;
  }
  return { error: String(failure.error || 'The ticket could not be saved.') };
}

function validatePublicTicket_(input) {
  if (input.website) throw new Error('Unable to accept this request.');
  validateRequestWindow_(input.startedAt);
  var machine = requiredChoice_(input.machine, MACHINES, 'Choose a machine.');
  var notesInput = String(input.notes || '');
  if (input.neededByDate) {
    var compatibilityPrefix = 'Needed by date: ' + String(input.neededByDate);
    if (notesInput.indexOf(compatibilityPrefix) === 0) notesInput = notesInput.slice(compatibilityPrefix.length).replace(/^\n/, '');
  }
  var requestKey = String(input.requestKey || '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(requestKey)) throw new Error('Refresh the form and submit again.');
  var request = {
    requestKey: requestKey,
    machine: machine,
    customerName: cleanText_(input.customerName, 'Name', 100, true),
    department: cleanText_(input.department, 'Department', 100, true),
    purpose: cleanText_(input.purpose, 'Purpose', 2000, true),
    phone: cleanText_(input.phone === undefined ? '' : input.phone, 'Phone', 40, false),
    smsConsent: input.smsConsent === true || input.smsConsent === 'true' || input.smsConsent === 'on',
    notes: cleanText_(notesInput, 'Notes', 4000, false),
    quantity: positiveNumber_(input.quantity, 'Quantity', 10000, true),
    width: optionalPositiveNumber_(input.width, 'Width', machine === 'printer' ? 24 : 10000),
    length: optionalPositiveNumber_(input.length, 'Length', 100000),
    neededBy: neededByDate_(input.neededByDate || (input.neededBy === undefined ? 'No rush' : input.neededBy)),
    paperType: '',
    thickness: '',
    files: validateFiles_(input.files || [], machine)
  };
  if (!request.files.length) throw new Error('Attach at least one artwork file to submit a ticket.');
  if (machine === 'foam') {
    request.thickness = positiveNumber_(input.thickness, 'Foam thickness', 1000, false);
  }
  request.phone = normalizePhone(request.phone, request.smsConsent);
  return request;
}

function requestFingerprint_(request) {
  var canonical = JSON.stringify({
    machine: request.machine,
    customerName: request.customerName,
    department: request.department,
    purpose: request.purpose,
    phone: request.phone,
    smsConsent: request.smsConsent,
    notes: request.notes,
    quantity: request.quantity,
    width: request.width,
    length: request.length,
    thickness: request.thickness,
    neededBy: request.neededBy,
    paperType: request.paperType,
    files: request.files.map(function(file) {
      return file.id
        ? { id: file.id, index: file.index, name: file.name, type: file.type, size: file.size, md5Checksum: file.md5Checksum }
        : { name: file.name, type: file.type, size: file.size, data: file.data };
    })
  });
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, canonical, Utilities.Charset.UTF_8);
  return digest.map(function(value) { return (value + 256).toString(16).slice(-2); }).join('');
}

function neededByDate_(value) {
  var text = String(value || '').trim();
  if (DEADLINES.indexOf(text) !== -1) return text;
  var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new Error('Choose a valid needed-by date.');
  var date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== text) throw new Error('Choose a valid needed-by date.');
  return text;
}

function validateFiles_(files, machine) {
  if (!Array.isArray(files) || files.length > MAX_FILES) throw new Error('Attach no more than ' + MAX_FILES + ' files.');
  var format = machine === 'printer'
    ? { pattern: /\.(pdf|png|jpe?g|tiff?)$/i, message: 'Poster printing accepts PDF, JPG, PNG, or TIFF files only.' }
    : machine === 'foam'
      ? { pattern: /\.(svg|dxf)$/i, message: 'Foam cutting accepts SVG or DXF files only.' }
      : null;
  if (!format) throw new Error('Choose a machine.');
  var total = 0;
  var legacyTotal = 0;
  return files.map(function(file, index) {
    var name = String(file && file.name || '');
    var type = String(file && file.type || 'application/octet-stream').slice(0, 100);
    var size = Number(file && file.size);
    if (!name || name.length > 180 || /[\\/\u0000-\u001f]/.test(name)) throw new Error('Use a safe filename under 180 characters.');
    if (!format.pattern.test(name)) throw new Error(format.message);
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES) throw new Error('Each file must be 200 MB or smaller.');
    if (/\.(svg|dxf)$/i.test(name) && size > MAX_VECTOR_FILE_BYTES) throw new Error('SVG and DXF files must be 10 MB or smaller so their full contents can be checked.');
    total += size;
    if (total > MAX_TOTAL_BYTES) throw new Error('Attachments must total 200 MB or less.');
    var id = String(file && file.id || '');
    if (id) {
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(id) || Number(file.index) !== index) throw new Error('An uploaded file could not be verified.');
      var md5Checksum = String(file && file.md5Checksum || '').toLowerCase();
      if (!/^[a-f0-9]{32}$/.test(md5Checksum)) throw new Error('An uploaded file is missing its integrity check.');
      return { id: id, index: index, name: name, type: type, size: size, md5Checksum: md5Checksum };
    }
    var data = String(file && file.data || '');
    legacyTotal += size;
    if (size > LEGACY_MAX_FILE_BYTES || legacyTotal > LEGACY_MAX_TOTAL_BYTES) throw new Error('Refresh the page before attaching large files.');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || Math.abs(Math.floor(data.replace(/=/g, '').length * 3 / 4) - size) > 2) throw new Error('An attachment could not be verified.');
    return { name: name, type: type, size: size, data: data };
  });
}

function saveFiles_(files, ticketNumber, requestKey, properties, transaction) {
  if (!files.length) return [];
  var folderId = properties.getProperty('UPLOAD_FOLDER_ID');
  if (!folderId) throw new Error('The upload folder is not configured. Run setup again.');
  var folder = DriveApp.getFolderById(folderId);
  // Validate every receipt and every byte envelope before changing any Drive
  // object. Otherwise a bad later receipt can strand an earlier renamed file.
  var prepared = files.map(function(file, index) {
    var safeName = file.name.replace(/[^A-Za-z0-9._ -]/g, '_');
    if (file.id) {
      var metadata = getDriveFileMetadata_(file.id);
      var appProperties = metadata.appProperties || {};
      var ownedByRequest = appProperties.mandirRequestKey === requestKey && String(appProperties.mandirIndex) === String(index);
      var legacyPendingName = String(metadata.name || '').indexOf(pendingFilePrefix_(requestKey, index)) === 0;
      if (metadata.trashed || metadata.parents.indexOf(folderId) === -1 || Number(metadata.size) !== file.size || (!ownedByRequest && !legacyPendingName)) throw new Error('An uploaded file could not be verified.');
      if (String(metadata.md5Checksum || '').toLowerCase() !== file.md5Checksum) throw new Error('An uploaded file failed its integrity check.');
      var uploaded = DriveApp.getFileById(file.id);
      inspectDriveFile_(file, metadata, uploaded);
      return { file: uploaded, finalName: ticketNumber + '-' + (index + 1) + '-' + safeName, previousName: uploaded.getName() };
    }
    var bytes = Utilities.base64Decode(file.data);
    inspectFile_(file.name, bytes);
    return { folder: folder, blob: Utilities.newBlob(bytes, file.type, ticketNumber + '-' + (index + 1) + '-' + safeName) };
  });

  var changes = [];
  try {
    var links = prepared.map(function(item) {
      if (item.file) {
        item.file.setName(item.finalName);
        changes.push({ file: item.file, previousName: item.previousName });
        return item.finalName + ' — ' + item.file.getUrl();
      }
      var saved = item.folder.createFile(item.blob);
      changes.push({ file: saved, trash: true });
      return saved.getName() + ' — ' + saved.getUrl();
    });
    if (Array.isArray(transaction)) Array.prototype.push.apply(transaction, changes);
    return links;
  } catch (error) {
    rollbackSavedFiles_(changes);
    throw error;
  }
}

function rollbackSavedFiles_(changes) {
  (changes || []).slice().reverse().forEach(function(change) {
    try {
      if (change.trash) change.file.setTrashed(true);
      else change.file.setName(change.previousName);
    } catch (error) {
      console.error('Could not roll back an uncommitted upload: ' + safeError_(error));
    }
  });
}

function getDriveFileMetadata_(fileId) {
  var response = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?fields=id%2Cname%2Csize%2Cparents%2Ctrashed%2Cmd5Checksum%2CappProperties', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) throw new Error('Google Drive could not verify an uploaded file.');
  var metadata = JSON.parse(response.getContentText() || '{}');
  metadata.parents = Array.isArray(metadata.parents) ? metadata.parents : [];
  return metadata;
}

function responseHeader_(response, wanted) {
  var headers = response.getAllHeaders ? response.getAllHeaders() : {};
  var value = '';
  Object.keys(headers).some(function(key) {
    if (key.toLowerCase() === wanted.toLowerCase()) {
      value = String(headers[key]);
      return true;
    }
    return false;
  });
  return value;
}

function readDriveRange_(fileId, start, end, size) {
  var response = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media', {
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      Range: 'bytes=' + start + '-' + end
    },
    muteHttpExceptions: true
  });
  var code = response.getResponseCode();
  if (code !== 206 && !(code === 200 && start === 0 && end === size - 1)) throw new Error('Google Drive could not verify the uploaded file contents.');
  if (code === 206 && responseHeader_(response, 'Content-Range') !== 'bytes ' + start + '-' + end + '/' + size) throw new Error('Google Drive returned an incomplete file range.');
  var bytes = response.getBlob().getBytes();
  if (bytes.length !== end - start + 1) throw new Error('Google Drive returned an incomplete file range.');
  return bytes;
}

function byte_(value) {
  return value < 0 ? value + 256 : value;
}

function isPngEnvelope_(prefix, suffix) {
  var signature = [137, 80, 78, 71, 13, 10, 26, 10];
  var ending = [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130];
  return signature.every(function(value, index) { return byte_(prefix[index]) === value; })
    && ending.every(function(value, index) { return byte_(suffix[suffix.length - ending.length + index]) === value; });
}

function isTiffHeader_(bytes) {
  var header = [byte_(bytes[0]), byte_(bytes[1]), byte_(bytes[2]), byte_(bytes[3])].join(',');
  return ['73,73,42,0', '77,77,0,42', '73,73,43,0', '77,77,0,43'].indexOf(header) !== -1;
}

function inspectDriveFile_(file, metadata, uploaded) {
  var lower = file.name.toLowerCase();
  var size = Number(metadata.size);
  if (/\.(svg|dxf)$/.test(lower)) {
    var vectorBytes = uploaded.getBlob().getBytes();
    if (vectorBytes.length !== size) throw new Error('Google Drive returned incomplete vector artwork.');
    inspectFile_(file.name, vectorBytes);
    return;
  }
  var prefix = readDriveRange_(file.id, 0, Math.min(size - 1, 15), size);
  var suffix = readDriveRange_(file.id, Math.max(0, size - 2048), size - 1, size);
  if (lower.endsWith('.pdf')) {
    var header = Utilities.newBlob(prefix).getDataAsString('ISO-8859-1');
    var footer = Utilities.newBlob(suffix).getDataAsString('ISO-8859-1');
    if (!/^%PDF-(1\.[0-7]|2\.0)[\r\n ]/.test(header) || !/%%EOF\s*$/.test(footer)) throw new Error('A PDF attachment is incomplete or is not a valid PDF.');
    return;
  }
  if (/\.jpe?g$/.test(lower) && !(byte_(prefix[0]) === 255 && byte_(prefix[1]) === 216 && byte_(prefix[2]) === 255 && byte_(suffix[suffix.length - 2]) === 255 && byte_(suffix[suffix.length - 1]) === 217)) {
    throw new Error('A JPG attachment is not a valid JPG.');
  }
  if (lower.endsWith('.png') && !isPngEnvelope_(prefix, suffix)) throw new Error('A PNG attachment is incomplete or is not a valid PNG.');
  if (/\.tiff?$/.test(lower) && !isTiffHeader_(prefix)) throw new Error('A TIFF attachment is not a valid TIFF.');
}

function beginUpload_(params) {
  validateRequestWindow_(params.startedAt);
  var machine = requiredChoice_(params.machine, MACHINES, 'Choose a machine.');
  var requestKey = String(params.requestKey || '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(requestKey)) throw new Error('Refresh the form and submit again.');
  var index = Number(params.index);
  if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_FILES) throw new Error('Attach no more than ' + MAX_FILES + ' files.');
  var metadata = validateFiles_([{
    name: params.name,
    type: params.type,
    size: Number(params.size),
    id: 'pendingfile',
    index: 0,
    md5Checksum: '00000000000000000000000000000000'
  }], machine)[0];
  var properties = PropertiesService.getScriptProperties();
  var origin = String(params.origin || '');
  var configuredOrigins = String(properties.getProperty('UPLOAD_ORIGINS') || '').split(',').map(function(value) { return value.trim(); }).filter(String);
  var allowedOrigins = configuredOrigins.length ? configuredOrigins : DEFAULT_UPLOAD_ORIGINS;
  if (allowedOrigins.indexOf(origin) === -1) throw new Error('Open the ticket form from the workshop website.');
  var folderId = properties.getProperty('UPLOAD_FOLDER_ID');
  if (!folderId) throw new Error('The upload folder is not configured. Run setup again.');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    enforceDailyLimit_(properties);
    var reservation = checkUploadReservation_(properties, requestKey, index, metadata.size);
    var pendingName = pendingFilePrefix_(requestKey, index) + metadata.name.replace(/[^A-Za-z0-9._ -]/g, '_');
    var response = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id%2Cname%2CmimeType%2Csize%2Cmd5Checksum', {
      method: 'post',
      contentType: 'application/json; charset=UTF-8',
      payload: JSON.stringify({
        name: pendingName,
        parents: [folderId],
        description: 'Pending Mandir workshop ticket upload',
        appProperties: { mandirRequestKey: requestKey, mandirIndex: String(index) }
      }),
      headers: {
        Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
        Origin: origin,
        'X-Upload-Content-Type': metadata.type,
        'X-Upload-Content-Length': String(metadata.size)
      },
      followRedirects: false,
      muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) throw new Error('Google Drive could not start the file upload.');
    var headers = response.getAllHeaders();
    var sessionUrl = '';
    Object.keys(headers).some(function(key) {
      if (key.toLowerCase() === 'location') {
        sessionUrl = String(headers[key]);
        return true;
      }
      return false;
    });
    if (!/^https:\/\/www\.googleapis\.com\/upload\//.test(sessionUrl)) throw new Error('Google Drive did not return an upload session.');
    commitUploadReservation_(properties, reservation, index, metadata.size);
    return { ok: true, sessionUrl: sessionUrl };
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function validateRequestWindow_(value) {
  var startedAt = Number(value);
  if (!Number.isFinite(startedAt) || Date.now() - startedAt < 800 || Date.now() - startedAt > 24 * 60 * 60 * 1000) throw new Error('Refresh the page and submit the request again.');
}

function pendingFilePrefix_(requestKey, index) {
  return '.mandir-pending-' + requestKey + '-' + index + '-';
}

function uploadReservationKey_(requestKey) {
  return 'UPLOAD_' + requestKey;
}

function cleanupAbandonedUploads() {
  var properties = PropertiesService.getScriptProperties();
  var folderId = properties.getProperty('UPLOAD_FOLDER_ID');
  if (!folderId) throw new Error('The upload folder is not configured. Run setup again.');
  var cutoff = Date.now() - 24 * 60 * 60 * 1000;
  var removedReservations = 0;
  var allProperties = properties.getProperties();
  Object.keys(allProperties).forEach(function(key) {
    var state;
    try { state = JSON.parse(allProperties[key]); } catch (_error) { state = null; }
    if (/^FAILED_[a-f0-9]{32}$/.test(key)) {
      if (!state || !Number.isFinite(Number(state.at)) || Number(state.at) < cutoff) {
        properties.deleteProperty(key);
        removedReservations++;
      }
      return;
    }
    if (!/^UPLOAD_[a-f0-9]{32}$/.test(key)) return;
    if (!state || !Number.isFinite(Number(state.created)) || Number(state.created) < cutoff) {
      properties.deleteProperty(key);
      removedReservations++;
    }
  });
  var files = DriveApp.getFolderById(folderId).getFiles();
  var removed = 0;
  while (files.hasNext()) {
    var file = files.next();
    if (/^\.mandir-pending-[a-f0-9]{32}-\d+-/.test(file.getName()) && file.getDateCreated().getTime() < cutoff) {
      file.setTrashed(true);
      removed++;
    }
  }
  console.log('Removed ' + removed + ' abandoned upload(s) and ' + removedReservations + ' stale reservation(s).');
  return removed;
}

function checkUploadReservation_(properties, requestKey, index, size) {
  var propertyKey = uploadReservationKey_(requestKey);
  var state;
  try { state = JSON.parse(properties.getProperty(propertyKey) || '{}'); } catch (_error) { state = {}; }
  if (!state.created || Date.now() - Number(state.created) > 24 * 60 * 60 * 1000) state = { created: Date.now(), files: {} };
  if (!state.files || typeof state.files !== 'object') state.files = {};
  var projectedFiles = Object.assign({}, state.files);
  var previouslyReserved = Number(projectedFiles[index] || 0);
  projectedFiles[index] = size;
  var indexes = Object.keys(projectedFiles);
  var total = indexes.reduce(function(sum, key) { return sum + Number(projectedFiles[key] || 0); }, 0);
  if (indexes.length > MAX_FILES || total > MAX_TOTAL_BYTES) throw new Error('Attachments must total 200 MB or less.');

  var dateKey = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var daily = String(properties.getProperty('DAILY_UPLOAD_BYTES') || '').split(':');
  var used = daily[0] === dateKey ? Number(daily[1] || 0) : 0;
  var limit = Number(properties.getProperty('MAX_DAILY_UPLOAD_BYTES') || DEFAULT_DAILY_UPLOAD_BYTES);
  if (!Number.isSafeInteger(limit) || limit < MAX_FILE_BYTES) limit = DEFAULT_DAILY_UPLOAD_BYTES;
  var additionalBytes = Math.max(0, size - previouslyReserved);
  if (used + additionalBytes > limit) throw new Error('The workshop has reached today’s file upload limit. Please contact the desk.');
  return { propertyKey: propertyKey, state: state, files: projectedFiles, dateKey: dateKey, used: used, additionalBytes: additionalBytes };
}

function commitUploadReservation_(properties, reservation, index, size) {
  reservation.state.files = reservation.files;
  properties.setProperty(reservation.propertyKey, JSON.stringify(reservation.state));
  properties.setProperty('DAILY_UPLOAD_BYTES', reservation.dateKey + ':' + (reservation.used + reservation.additionalBytes));
}

function reserveInlineUploads_(properties, request) {
  request.files.forEach(function(file, index) {
    if (file.id) return;
    var reservation = checkUploadReservation_(properties, request.requestKey, index, file.size);
    commitUploadReservation_(properties, reservation, index, file.size);
  });
}

function inspectFile_(name, bytes) {
  var lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) {
    var header = Utilities.newBlob(bytes.slice(0, 16)).getDataAsString('ISO-8859-1');
    var footer = Utilities.newBlob(bytes.slice(-2048)).getDataAsString('ISO-8859-1');
    if (!/^%PDF-(1\.[0-7]|2\.0)[\r\n ]/.test(header) || !/%%EOF\s*$/.test(footer)) throw new Error('A PDF attachment is incomplete or is not a valid PDF.');
  }
  if (lower.endsWith('.png') && !isPngEnvelope_(bytes, bytes)) throw new Error('A PNG attachment is incomplete or is not a valid PNG.');
  if (/\.jpe?g$/.test(lower) && !(byte_(bytes[0]) === 255 && byte_(bytes[1]) === 216 && byte_(bytes[2]) === 255 && byte_(bytes[bytes.length - 2]) === 255 && byte_(bytes[bytes.length - 1]) === 217)) throw new Error('A JPG attachment is not a valid JPG.');
  if (/\.tiff?$/.test(lower) && !isTiffHeader_(bytes)) throw new Error('A TIFF attachment is not a valid TIFF.');
  if (lower.endsWith('.dxf')) {
    var text = Utilities.newBlob(bytes).getDataAsString('UTF-8');
    if (text.indexOf('\uFFFD') !== -1) throw new Error('ASCII DXF files must use valid UTF-8 text.');
    inspectDxfText_(text);
  }
}

function decodeSvgAttribute_(value) {
  var output = '';
  var position = 0;
  var entity = /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/ig;
  var match;
  while ((match = entity.exec(value))) {
    if (value.slice(position, match.index).indexOf('&') !== -1) throw new Error('SVG contains an invalid entity.');
    output += value.slice(position, match.index);
    var name = match[1].toLowerCase();
    var code = name === 'amp' ? 38 : name === 'lt' ? 60 : name === 'gt' ? 62 : name === 'quot' ? 34 : name === 'apos' ? 39
      : name.indexOf('#x') === 0 ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    if (!Number.isSafeInteger(code) || code < 1 || code > 0x10ffff) throw new Error('SVG contains an invalid entity.');
    output += String.fromCodePoint(code);
    position = entity.lastIndex;
  }
  if (value.slice(position).indexOf('&') !== -1) throw new Error('SVG contains an invalid entity.');
  return output + value.slice(position);
}

function inspectSvgText_(text) {
  if (text.replace(/&(?:#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/ig, '').indexOf('&') !== -1) throw new Error('SVG contains an invalid entity.');
  var tags = {};
  'svg g defs title desc path rect circle ellipse line polyline polygon text tspan linearGradient radialGradient stop clipPath'.split(' ').forEach(function(name) { tags[name] = true; });
  var attributes = {};
  'id version x y x1 y1 x2 y2 cx cy r rx ry width height viewBox preserveAspectRatio d points transform fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset stroke-opacity opacity clip-path clip-rule font-family font-size font-weight font-style text-anchor dominant-baseline dx dy rotate offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod fx fy fr'.split(' ').forEach(function(name) { attributes[name] = true; });
  var stack = [];
  var rootSeen = false;
  var rootClosed = false;
  var inTag = false;
  var quote = '';
  var token = '';
  var xmlDeclarationSeen = false;

  function processTag(value) {
    if (/^<[!?]/.test(value)) throw new Error('SVG declarations, comments, CDATA and processing instructions are not supported.');
    var closing = /^<\/([A-Za-z][\w.-]*)\s*>$/.exec(value);
    if (closing) {
      if (!stack.length || stack.pop() !== closing[1]) throw new Error('SVG elements are not correctly nested.');
      if (!stack.length) rootClosed = true;
      return;
    }
    var body = value.slice(1, -1);
    var selfClosing = /\/\s*$/.test(body);
    if (selfClosing) body = body.replace(/\/\s*$/, '');
    var nameMatch = /^([A-Za-z][\w.-]*)/.exec(body);
    if (!nameMatch || !tags[nameMatch[1]]) throw new Error('SVG contains unsupported or active elements.');
    var name = nameMatch[1];
    var isRoot = !rootSeen;
    if (isRoot) {
      if (name !== 'svg') throw new Error('The SVG must have an svg root element.');
      rootSeen = true;
    } else if (rootClosed || !stack.length) {
      throw new Error('SVG must contain one root element.');
    }
    var rest = body.slice(name.length);
    var sawNamespace = false;
    var seenAttributes = {};
    while (rest.length) {
      var attribute = /^\s+([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rest);
      if (!attribute) throw new Error('SVG contains malformed or unsupported attributes.');
      var attributeName = attribute[1];
      if (seenAttributes[attributeName]) throw new Error('SVG contains duplicate attributes.');
      seenAttributes[attributeName] = true;
      var rawAttributeValue = attribute[2] === undefined ? attribute[3] : attribute[2];
      if (rawAttributeValue.indexOf('<') !== -1) throw new Error('SVG contains malformed attribute values.');
      var attributeValue = decodeSvgAttribute_(rawAttributeValue);
      var specialAttribute = false;
      if (attributeName === 'xmlns' && attributeValue === 'http://www.w3.org/2000/svg' && name === 'svg') { sawNamespace = true; specialAttribute = true; }
      else if (attributeName === 'xml:space' && (attributeValue === 'default' || attributeValue === 'preserve')) specialAttribute = true;
      else if (attributeName.indexOf(':') !== -1 || !attributes[attributeName]) throw new Error('SVG contains unsupported attributes. Remove scripts, styles and external resources.');
      if (!specialAttribute && /\\|\/\*|(?:https?|data|javascript):/i.test(attributeValue)) throw new Error('SVG escaped styles and external resources are not allowed.');
      if (!specialAttribute && /url\s*\(/i.test(attributeValue) && !/^url\(#[A-Za-z_][\w.-]*\)$/.test(attributeValue)) throw new Error('SVG external resources are not allowed.');
      rest = rest.slice(attribute[0].length);
    }
    if (isRoot && !sawNamespace) throw new Error('SVG must declare the standard SVG namespace.');
    if (!selfClosing) stack.push(name);
    else if (!stack.length) rootClosed = true;
    if (stack.length > 100) throw new Error('SVG nesting is too complex. Export a flattened PDF instead.');
  }

  for (var index = 0; index < text.length; index++) {
    var character = text[index];
    if (!inTag) {
      if (character === '<') {
        if (text.slice(index, index + 4) === '<!--') {
          var commentEnd = text.indexOf('-->', index + 4);
          if (commentEnd === -1 || text.slice(index + 4, commentEnd).indexOf('--') !== -1) throw new Error('SVG contains a malformed comment.');
          index = commentEnd + 2;
          continue;
        }
        if (text.slice(index, index + 5).toLowerCase() === '<?xml') {
          var declarationEnd = text.indexOf('?>', index + 5);
          var declaration = declarationEnd === -1 ? '' : text.slice(index, declarationEnd + 2);
          if (rootSeen || xmlDeclarationSeen || !/^<\?xml\s+version\s*=\s*(["'])1\.0\1(?:\s+encoding\s*=\s*(["'])utf-8\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\3)?\s*\?>$/i.test(declaration)) {
            throw new Error('SVG contains an unsupported XML declaration.');
          }
          xmlDeclarationSeen = true;
          index = declarationEnd + 1;
          continue;
        }
        inTag = true;
        token = '<';
      } else if ((!rootSeen || rootClosed) && !/\s/.test(character)) {
        throw new Error('SVG contains data outside its root element.');
      }
      continue;
    }
    token += character;
    if (token.length > 262144) throw new Error('An SVG element is too complex. Export a flattened PDF instead.');
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '>') {
      processTag(token);
      inTag = false;
      token = '';
    }
  }
  if (inTag || !rootSeen || stack.length || !rootClosed) throw new Error('The SVG is empty, truncated or not well formed.');
}

function inspectDxfText_(text) {
  if (text.indexOf('\u0000') !== -1) throw new Error('Binary DXF is not supported. Export an ASCII DXF.');
  var lines = text.replace(/\r/g, '').split('\n');
  var code = null;
  var section = false;
  var sectionName = false;
  var sawSection = false;
  var eof = false;
  lines.forEach(function(raw) {
    var value = raw.trim();
    if (!value && code === null) return;
    if (eof) {
      if (value) throw new Error('DXF has data after its EOF marker.');
      return;
    }
    if (raw.length > 262144) throw new Error('A DXF record is too long.');
    if (code === null) {
      if (!/^\d{1,4}$/.test(value) || Number(value) > 1071) throw new Error('DXF contains an invalid group code.');
      code = Number(value);
      return;
    }
    var group = code;
    code = null;
    if (sectionName) {
      if (group !== 2 || !/^[A-Z0-9_]+$/.test(value)) throw new Error('DXF section name is missing.');
      sectionName = false;
      return;
    }
    if (group === 0 && value === 'SECTION') {
      if (section) throw new Error('DXF sections cannot be nested.');
      section = true; sectionName = true; sawSection = true;
    } else if (group === 0 && value === 'ENDSEC') {
      if (!section) throw new Error('DXF has an unmatched ENDSEC.');
      section = false;
    } else if (group === 0 && value === 'EOF') {
      if (section || !sawSection) throw new Error('DXF is incomplete.');
      eof = true;
    } else if (!section && group !== 999) throw new Error('DXF data must be inside a section.');
    var numeric = (group >= 10 && group <= 79) || (group >= 110 && group <= 149) || (group >= 160 && group <= 179) || (group >= 210 && group <= 239) || (group >= 270 && group <= 299) || (group >= 370 && group <= 389) || (group >= 400 && group <= 409) || (group >= 420 && group <= 429) || (group >= 440 && group <= 459) || (group >= 460 && group <= 469) || (group >= 1010 && group <= 1071);
    if (numeric && (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value)))) throw new Error('DXF contains a non-finite or invalid numeric value.');
  });
  if (!eof || code !== null || sectionName) throw new Error('DXF is truncated or missing EOF.');
}

function syncServerRow_(input, lock) {
  var properties = PropertiesService.getScriptProperties();
  var secret = properties.getProperty('SHARED_SECRET');
  if (!secret || input.secret !== secret || input.row.length !== 19 || typeof input.row[0] !== 'string' || !Number.isInteger(input.row[18])) return jsonResponse_({ ok: false });
  lock.waitLock(20000);
  var sheet = ensureTicketSheet_(openBook_());
  var match = findRow_(sheet, 1, input.row[0]);
  if (match && Number(sheet.getRange(match, 19).getValue()) >= input.row[18]) return jsonResponse_({ ok: true });
  var target = match || sheet.getLastRow() + 1;
  sheet.getRange(target, 1, 1, 19).setValues([input.row.map(escapeCell_)]);
  sheet.getRange(target, 22).setValue('Node API');
  SpreadsheetApp.flush();
  invalidatePublicQueueCache_();
  return jsonResponse_({ ok: true });
}

function openBook_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('The ticket backend has not been set up.');
  return SpreadsheetApp.openById(id);
}

function ensureTicketSheet_(book) {
  var sheet = book.getSheetByName(TICKET_SHEET) || book.insertSheet(TICKET_SHEET);
  if (!sheet.getLastRow()) sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  if (sheet.getMaxColumns() < HEADERS.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), HEADERS.length - sheet.getMaxColumns());
  var current = sheet.getRange(1, 1, 1, HEADERS.length).getDisplayValues()[0];
  for (var i = 0; i < HEADERS.length; i++) if (!current[i]) sheet.getRange(1, i + 1).setValue(HEADERS[i]);
  return sheet;
}

function ensurePrivateSheet_(book, name, headers) {
  var sheet = book.getSheetByName(name) || book.insertSheet(name);
  var initialize = !sheet.getLastRow();
  if (sheet.getMaxColumns() < headers.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  if (initialize) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  var current = sheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0];
  for (var i = 0; i < headers.length; i++) if (!current[i]) sheet.getRange(1, i + 1).setValue(headers[i]);
  if (initialize) {
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#1d3a29').setFontColor('#ffffff');
    try { if (!sheet.isSheetHidden()) sheet.hideSheet(); } catch (_error) { /* Hiding is a privacy convenience, not a setup requirement. */ }
  }
  return sheet;
}

function ensureTelegramSheets_(book) {
  return {
    subscriptions: ensurePrivateSheet_(book, TELEGRAM_SUBSCRIPTIONS_SHEET, TELEGRAM_SUBSCRIPTION_HEADERS),
    outbox: ensurePrivateSheet_(book, TELEGRAM_OUTBOX_SHEET, TELEGRAM_OUTBOX_HEADERS)
  };
}

function findRow_(sheet, column, value) {
  if (sheet.getLastRow() < 2) return 0;
  var match = sheet.getRange(2, column, sheet.getLastRow() - 1, 1).createTextFinder(String(value)).matchEntireCell(true).findNext();
  return match ? match.getRow() : 0;
}

function nextTicketNumber_(sheet, machine) {
  var prefix = machine === 'printer' ? 'P' : 'F';
  var values = sheet.getLastRow() > 1 ? sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getDisplayValues() : [];
  var highest = values.reduce(function(max, row) {
    var match = new RegExp('^' + prefix + '-(\\d+)$').exec(String(row[0]));
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return prefix + '-' + String(highest + 1).padStart(4, '0');
}

function activePosition_(sheet, rowNumber, machineName, status) {
  if (status !== 'queued' && status !== 'in-progress') return null;
  if (sheet.getLastRow() < 2) return null;
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).getValues();
  var target = String(rows[rowNumber - 2][0]);
  var ordered = rows.map(staffTicket_).filter(function(t) { return MACHINES[t.machine] === machineName && (t.status === 'queued' || t.status === 'in-progress'); }).sort(fifoCompare);
  var index = ordered.findIndex(function(t) { return t.id === target; });
  return index < 0 ? null : index + 1;
}

function enforceDailyLimit_(properties) {
  var key = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var record = String(properties.getProperty('DAILY_TICKET_COUNT') || '').split(':');
  var count = record[0] === key ? Number(record[1] || 0) : 0;
  var limit = Number(properties.getProperty('MAX_DAILY_TICKETS') || DEFAULT_DAILY_LIMIT);
  if (!Number.isSafeInteger(limit) || limit < 1) limit = DEFAULT_DAILY_LIMIT;
  if (count >= limit) throw new Error('The workshop has reached today’s online request limit. Please contact the desk.');
}

function incrementDailyCount_(properties) {
  var key = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var record = String(properties.getProperty('DAILY_TICKET_COUNT') || '').split(':');
  var count = record[0] === key ? Number(record[1] || 0) : 0;
  properties.setProperty('DAILY_TICKET_COUNT', key + ':' + (count + 1));
}

function cleanText_(value, label, maxLength, required) {
  if (typeof value !== 'string') throw new Error(label + ' is invalid.');
  var text = value.replace(/\r\n?/g, '\n').trim();
  if (required && !text) throw new Error(label + ' is required.');
  if (text.length > maxLength) throw new Error(label + ' is too long.');
  return text;
}

function positiveNumber_(value, label, max, integer) {
  var number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > max || (integer && !Number.isInteger(number))) throw new Error('Enter a valid ' + label.toLowerCase() + '.');
  return number;
}

function optionalPositiveNumber_(value, label, max) {
  if (value === undefined || (typeof value === 'string' && value.trim() === '')) return '';
  return positiveNumber_(value, label, max, false);
}

function requiredChoice_(value, choices, message) {
  if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(choices, value)) throw new Error(message);
  return value;
}

function requiredArrayChoice_(value, choices, message) {
  if (typeof value !== 'string' || choices.indexOf(value) === -1) throw new Error(message);
  return value;
}

function escapeCell_(value) {
  return typeof value === 'string' && /^\s*[=+@-]/.test(value) ? "'" + value : value;
}

function randomCode_(length) {
  var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + new Date().getTime());
  var output = '';
  for (var i = 0; i < length; i++) output += alphabet.charAt((bytes[i] + 256) % alphabet.length);
  return output;
}

function safeError_(error) {
  var message = String(error && error.message || 'The ticket could not be saved.');
  return message.length > 180 ? 'The ticket could not be saved. Please try again.' : message;
}

function jsonResponse_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function javascriptResponse_(callback, value) {
  return ContentService.createTextOutput(callback + '(' + JSON.stringify(value) + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
}

// A private server may authenticate with WORKSHOP_SHARED_SECRET. The GitHub
// Pages-only build deliberately uses the publicStaff path instead.
function workshopFail_(message, status) { var error = new Error(message); error.status = status || 400; throw error; }
const fifoCompare = (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.sequence || Number(a.ticketNumber?.slice(2))) - (b.sequence || Number(b.ticketNumber?.slice(2))) || a.id.localeCompare(b.id);
function assertTransition(tickets, ticket, status) {
  if (ticket.status === status) return;
  const allowed = { queued: ['in-progress', 'cancelled'], 'in-progress': ['ready', 'cancelled'], ready: ['collected', 'cancelled'], collected: [], cancelled: [] };
  if (!allowed[ticket.status]?.includes(status)) workshopFail_('Use the next workflow step for this ticket.', 409);
  if (status === 'ready' && !(ticket.usage || []).length) workshopFail_('Record material used before marking this job ready.', 409);
}
function validateUsage(ticket, input) {
  if (!input || typeof input !== 'object' || !/^[a-zA-Z0-9-]{16,100}$/.test(input.requestKey || '')) workshopFail_('Refresh the material form and try again.');
  const used = Number(input.used), waste = Number(input.waste);
  if (input.used === '' || input.used == null || input.waste === '' || input.waste == null || !Number.isFinite(used) || !Number.isFinite(waste) || used < 0 || waste < 0 || used + waste <= 0 || used + waste > 100000) workshopFail_('Enter valid material quantities, including zero waste when there is none.');
  const operator = typeof input.operator === 'string' ? input.operator.trim() : '';
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (!operator || operator.length > 100 || !note || note.length > 500) workshopFail_('Add your name and a short usage note (up to 500 characters).');
  return { requestKey: input.requestKey, used, waste, operator, note, material: ticket.machine === 'printer' ? 'Poster printing' : `Foam ${ticket.thickness} in`, unit: ticket.machine === 'printer' ? 'linear ft' : 'sq ft' };
}
function normalizePhone(phone, consent) {
  if (!consent) return phone;
  let number = phone.replace(/[\s().-]/g, '');
  if (/^\d{10}$/.test(number)) number = '+1' + number;
  if (/^1\d{10}$/.test(number)) number = '+' + number;
  if (!/^\+[1-9]\d{7,14}$/.test(number)) workshopFail_('Enter a valid mobile number with country code for text updates.');
  return number;
}
function machineId_(value) {
  var name = String(value || '').trim().toLowerCase();
  if (['printer', MACHINES.printer.toLowerCase(), '24-inch roll printer', 'hp designjet t210 · 24-inch', 'hp designjet t210 · 24-inch printer'].indexOf(name) !== -1) return 'printer';
  if (['foam', MACHINES.foam.toLowerCase(), 'foam cutting machine', '2525 hot-wire machine', '2525 hot-wire foam cutter'].indexOf(name) !== -1) return 'foam';
  return '';
}
// Review edits are explicit: no client-controlled identifiers, timestamps, or stored paths.
function validateReview(ticket, input) {
  if (!input || !['save', 'approve', 'decline'].includes(input.decision)) workshopFail_('Choose a review action.');
  if (ticket.status !== 'pending-review') workshopFail_('Only requests awaiting review can be edited.', 409);
  const fields = input.fields || {};
  const str = (key, max, required = false) => {
    const v = fields[key] === undefined ? ticket[key] || '' : fields[key];
    if (typeof v !== 'string' || v.length > max || (required && !v.trim())) workshopFail_('Check ' + key + '.');
    return v.trim();
  };
  const num = (key, max, optional) => {
    const raw = fields[key] === undefined ? ticket[key] : fields[key];
    if (optional && (raw === undefined || raw === 0 || (typeof raw === 'string' && raw.trim() === ''))) return 0;
    if (!['number','string'].includes(typeof raw) || !/^(?:\d+\.?\d*|\.\d+)$/.test(String(raw).trim())) workshopFail_('Check ' + key + '.');
    const v = Number(raw); if (!Number.isFinite(v) || v < .01 || v > max) workshopFail_('Check ' + key + '.'); return v;
  };
  const machine = str('machine', 10, true);
  if (!['printer','foam'].includes(machine)) workshopFail_('Choose a machine.');
  const neededBy = str('neededBy', 30, true);
  neededByDate_(neededBy);
  const quantity = num('quantity',10000); if (!Number.isInteger(quantity)) workshopFail_('Quantity must be a whole number.');
  const paperType = machine === 'printer' ? str('paperType',50) : '';
  if (paperType && !['Polypropylene','Adhesive','Canvas','Glossy','Standard'].includes(paperType)) workshopFail_('Choose a paper material.');
  let files = fields.files === undefined ? ticket.files : fields.files;
  if (!Array.isArray(files) || files.length > 10) workshopFail_('Attach up to ten artwork files.');
  files = files.map(f => {
    if (!f || typeof f.originalName !== 'string' || !f.originalName.trim() || f.originalName.length > 180 || /[\r\n]/.test(f.originalName)) workshopFail_('Check the artwork filename.');
    if (f.storedName) {
      const original = ticket.files.find(old => old.storedName === f.storedName);
      if (!original) workshopFail_('This stored file does not belong to the ticket.');
      return { ...original, originalName: f.originalName.trim() };
    }
    if (typeof f.url !== 'string' || !/^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]+\/view$/.test(f.url)) workshopFail_('Use a Google Drive file link ending in /view.');
    return { originalName: f.originalName.trim(), url: f.url };
  });
  if (input.decision === 'approve' && machine === 'printer' && !files.length) workshopFail_('Attach artwork before approving a print.');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length > 1000 || (input.decision === 'decline' && !reason)) workshopFail_('Give a decline reason (up to 1000 characters).');
  const operator = typeof input.operator === 'string' ? input.operator.trim() : '';
  if (!operator || operator.length > 100) workshopFail_('Enter the reviewing admin name.');
  const phone = normalizePhone(str('phone',40), ticket.smsConsent === true);
  const edits = { machine, neededBy, quantity, paperType, files, phone, customerName: str('customerName',100,true), department: str('department',100,true), purpose: str('purpose',2000,true), notes: str('notes',4000), width: num('width',machine === 'printer' ? 24 : 10000,true), length:num('length',100000,true), thickness:machine === 'foam' ? num('thickness',1000) : 0 };
  const changes = Object.keys(edits).filter(k => JSON.stringify(ticket[k]) !== JSON.stringify(edits[k])).map(k => ({ field:k, before:ticket[k] ?? null, after:edits[k] }));
  return { edits, changes, reason, operator, status: input.decision === 'approve' ? 'queued' : input.decision === 'decline' ? 'declined' : 'pending-review' };
}

function staffTicket_(row) {
  var machine = machineId_(row[2]);
  var date = function(v) { return v instanceof Date ? v.toISOString() : String(v || ''); };
  var parsed = function(v) { if (!v) return []; var result = JSON.parse(String(v)); if (!Array.isArray(result)) throw new Error('Invalid staff record.'); return result; };
  return { id: String(row[0]), ticketNumber: String(row[1]), sequence: Number(String(row[1]).slice(2)), machine: machine,
    customerName: String(row[3]), department: String(row[4]), purpose: String(row[5]), phone: String(row[6] || '').replace(/^'(?=\+)/, ''),
    quantity: Number(row[7]), paperType: String(row[8] || ''), width: Number(row[9]), length: Number(row[10]), thickness: Number(row[11]), neededBy: String(row[12]),
    status: String(row[13]).toLowerCase(), notes: String(row[14] || ''),
    files: String(row[15] || '').split('\n').filter(Boolean).map(function(entry) {
      var match = /https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/.exec(entry);
      return match ? { originalName: entry.slice(0, entry.indexOf(match[0])).replace(/[\s—:|-]+$/, '') || 'Artwork', url: 'https://drive.google.com/file/d/' + match[1] + '/view' } : null;
    }).filter(Boolean), createdAt: date(row[16]), updatedAt: date(row[17]), revision: Number(row[18]) || 1,
    usage: parsed(row[27]), history: parsed(row[28]), smsConsent: row[29] === 'yes', reason: String(row[30] || '') };
}
function workshopRows_(sheet) { return sheet.getLastRow() < 2 ? [] : sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).getValues(); }

function publicQueueCache_() {
  try { return typeof CacheService === 'undefined' ? null : CacheService.getScriptCache(); }
  catch (_error) { return null; }
}

function invalidatePublicQueueCache_() {
  var cache = publicQueueCache_();
  if (cache) {
    try { cache.remove(PUBLIC_QUEUE_CACHE_KEY); }
    catch (_error) { /* Cache failures must never block a ticket update. */ }
  }
}

function publicQueueRows_() {
  var sheet = openBook_().getSheetByName(TICKET_SHEET);
  if (!sheet) throw new Error('The ticket backend has not been set up.');
  var lastRow = sheet.getLastRow();
  return lastRow < 2 ? [] : sheet.getRange(2, 1, lastRow - 1, 17).getValues();
}

function publicQueueTicket_(row) {
  var ticketNumber = String(row[1] || '');
  return {
    id: String(row[0] || ticketNumber),
    ticketNumber: ticketNumber,
    sequence: Number(ticketNumber.slice(2)) || 0,
    machine: machineId_(row[2]),
    customerName: String(row[3] || ''),
    status: String(row[13] || '').trim().toLowerCase(),
    createdAt: row[16] instanceof Date ? row[16].toISOString() : String(row[16] || '')
  };
}

function publicWorkshopQueue_() {
  var cache = publicQueueCache_();
  if (cache) {
    try {
      var cached = JSON.parse(cache.get(PUBLIC_QUEUE_CACHE_KEY) || 'null');
      if (cached && Array.isArray(cached.machines)) return cached;
    } catch (_error) {
      try { cache.remove(PUBLIC_QUEUE_CACHE_KEY); }
      catch (_removeError) { /* Continue with a fresh Sheet read. */ }
    }
  }
  var lock = typeof LockService === 'undefined' ? null : LockService.getScriptLock();
  if (lock) lock.waitLock(20000);
  try {
    // A ticket mutation may have populated or invalidated the cache while this
    // cold read waited for the same lock. Never publish a pre-mutation snapshot.
    if (cache) {
      try {
        var refreshed = JSON.parse(cache.get(PUBLIC_QUEUE_CACHE_KEY) || 'null');
        if (refreshed && Array.isArray(refreshed.machines)) return refreshed;
      } catch (_refreshError) { /* Build a fresh snapshot below. */ }
    }
    var visibleStatuses = { 'pending-review': true, queued: true, 'in-progress': true };
    var tickets = publicQueueRows_().map(publicQueueTicket_).filter(function(ticket) {
      return ticket.machine && ticket.ticketNumber && visibleStatuses[ticket.status];
    }).sort(fifoCompare);
    var snapshot = { ok: true, updatedAt: new Date().toISOString(), machines: Object.keys(MACHINES).map(function(id) {
      var visible = tickets.filter(function(ticket) { return ticket.machine === id; });
      var active = visible.filter(function(ticket) { return ticket.status === 'queued' || ticket.status === 'in-progress'; });
      var positions = {};
      active.forEach(function(ticket, index) { positions[ticket.id] = index + 1; });
      return { id: id, name: MACHINES[id], waiting: active.length, inReview: visible.filter(function(ticket) { return ticket.status === 'pending-review'; }).length, tickets: visible.map(function(ticket) {
        return { ticketNumber: ticket.ticketNumber, customerName: ticket.customerName, status: ticket.status, position: ticket.status === 'pending-review' ? null : positions[ticket.id] || null };
      }) };
    }) };
    if (cache) {
      try { cache.put(PUBLIC_QUEUE_CACHE_KEY, JSON.stringify(snapshot), PUBLIC_QUEUE_CACHE_SECONDS); }
      catch (_error) { /* A large or unavailable cache must not break the queue. */ }
    }
    return snapshot;
  } finally {
    if (lock && lock.hasLock()) lock.releaseLock();
  }
}

function decorateTelegramTickets_(book, tickets) {
  if (!book || typeof book.getSheetByName !== 'function') return tickets;
  var subscriptions = book.getSheetByName(TELEGRAM_SUBSCRIPTIONS_SHEET);
  var outbox = book.getSheetByName(TELEGRAM_OUTBOX_SHEET);
  var linked = new Set();
  var deliveries = new Map();
  if (subscriptions) telegramSheetRows_(subscriptions, TELEGRAM_SUBSCRIPTION_HEADERS.length).forEach(function(row) {
    if (row[TELEGRAM_SUB.STATE] === 'enabled') linked.add(String(row[TELEGRAM_SUB.TICKET_ID]));
  });
  if (outbox) telegramSheetRows_(outbox, TELEGRAM_OUTBOX_HEADERS.length).forEach(function(row) {
    var ticketId = String(row[TELEGRAM_OUT.TICKET_ID] || '');
    if (!ticketId) return;
    var list = deliveries.get(ticketId) || [];
    list.push({
      id: String(row[TELEGRAM_OUT.EVENT_ID]),
      audience: String(row[TELEGRAM_OUT.AUDIENCE]),
      status: String(row[TELEGRAM_OUT.STATUS]),
      state: String(row[TELEGRAM_OUT.STATE]),
      updatedAt: row[TELEGRAM_OUT.UPDATED] instanceof Date ? row[TELEGRAM_OUT.UPDATED].toISOString() : String(row[TELEGRAM_OUT.UPDATED] || ''),
      detail: String(row[TELEGRAM_OUT.DETAIL] || '')
    });
    deliveries.set(ticketId, list);
  });
  return tickets.map(function(ticket) {
    var recent = (deliveries.get(ticket.id) || []).sort(function(a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); }).slice(0, 10);
    return { ...ticket, telegram: { linked: linked.has(ticket.id), deliveries: recent } };
  });
}

function publicStaffList_() {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var book = openBook_();
    var sheet = ensureTicketSheet_(book);
    return { ok: true, tickets: decorateTelegramTickets_(book, workshopRows_(sheet).map(staffTicket_)) };
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function staffAction_(input, lock, publicAccess) {
  try {
    if (!publicAccess) {
      var secret = PropertiesService.getScriptProperties().getProperty('WORKSHOP_SHARED_SECRET');
      if (!secret || secret.length < 32 || input.secret !== secret) workshopFail_('Staff connection is not authorized.', 401);
    }
    lock.waitLock(20000);
    var book = openBook_();
    var sheet = ensureTicketSheet_(book);
    var rows = workshopRows_(sheet);
    var tickets = rows.map(staffTicket_);
    if (input.action === 'staffList') return jsonResponse_({ ok: true, tickets: decorateTelegramTickets_(book, tickets) });
    var index = tickets.findIndex(function(t) { return t.id === input.id; });
    if (index < 0) workshopFail_('Ticket not found.', 404);
    var ticket = tickets[index];
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) workshopFail_('Refresh the ticket first.');
    var now = new Date().toISOString();
    if (input.action === 'adminReview') {
      if (ticket.revision !== input.expectedRevision) workshopFail_('This request changed. Refresh before reviewing.',409);
      var result = validateReview(ticket,input.input);
      Object.assign(ticket,result.edits,{status:result.status,reason:result.reason});
      ticket.history.push({status:ticket.status,at:now,operator:result.operator,reason:result.reason,changes:result.changes});
    } else if (input.action === 'staffUsage') {
      var entry = validateUsage(ticket, input.input);
      var prior = ticket.usage.find(function(u) { return u.requestKey === entry.requestKey; });
      if (prior) {
        if (Object.keys(entry).some(function(k) { return entry[k] !== prior[k]; })) workshopFail_('Usage was already recorded with different values.', 409);
        return jsonResponse_({ ok: true, ticket: ticket });
      }
      if (ticket.revision !== input.expectedRevision) workshopFail_('This ticket changed. Refresh and try again.', 409);
      if (['in-progress', 'ready'].indexOf(ticket.status) < 0) workshopFail_('Start the job before recording material usage.', 409);
      entry.at = now; ticket.usage.push(entry);
    } else {
      if (ticket.revision !== input.expectedRevision) workshopFail_('This ticket changed. Refresh and try again.', 409);
      assertTransition(tickets, ticket, input.status);
      if (ticket.status === input.status) return jsonResponse_({ ok: true, ticket: ticket });
      if (typeof input.reason !== 'undefined' && typeof input.reason !== 'string') workshopFail_('Check the reason.');
      var reason = (input.reason || '').trim();
      if (reason.length > 1000 || (input.status === 'cancelled' && !reason)) workshopFail_('Give a cancellation reason (up to 1000 characters).');
      ticket.status = input.status; ticket.reason = reason;
      ticket.history.push({ status: ticket.status, at: now, reason: ticket.reason });
    }
    ticket.revision++; ticket.updatedAt = now;
    // One row write commits status, revision, usage and history together.
    var row = rows[index];
    if (input.action === 'adminReview') {
      row[2] = MACHINES[ticket.machine]; row[3] = ticket.customerName; row[4] = ticket.department; row[5] = ticket.purpose; row[6] = ticket.phone;
      row[7] = ticket.quantity; row[8] = ticket.paperType; row[9] = ticket.width; row[10] = ticket.length; row[11] = ticket.thickness;
      row[12] = ticket.neededBy; row[14] = ticket.notes; row[15] = ticket.files.map(f => f.originalName + ' — ' + f.url).join('\n');
    }
    row[29] = ticket.smsConsent ? 'yes' : ''; row[30] = ticket.reason || '';
    row[13] = ticket.status; row[17] = now; row[18] = ticket.revision;
    row[27] = JSON.stringify(ticket.usage); row[28] = JSON.stringify(ticket.history);
    if (row[27].length > 45000 || row[28].length > 45000) workshopFail_('This ticket has reached its history limit. Contact the coordinator.');
    sheet.getRange(index + 2, 1, 1, HEADERS.length).setValues([row.map(escapeCell_)]);
    SpreadsheetApp.flush();
    invalidatePublicQueueCache_();
    input._telegramStatusCommitted = (input.action === 'staffUpdate' && input.status === 'ready')
      || (input.action === 'adminReview' && input.input && input.input.decision === 'decline');
    return jsonResponse_({ ok: true, ticket: decorateTelegramTickets_(book, [ticket])[0] });
  } catch (error) {
    return jsonResponse_({ ok: false, status: error.status || 503, error: error.status ? error.message : 'Google Sheets could not complete this operation. Refresh and retry.' });
  }
}

// Run once during rollout if pre-existing queued requests have not been reviewed.
// Active/ready/closed work and recorded material usage are retained.
function holdUnreviewedQueueForAdminReview() {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var sheet = ensureTicketSheet_(openBook_());
    workshopRows_(sheet).forEach(function(row,index) {
      var ticket = staffTicket_(row);
      var approved = ticket.history.some(function(h) { return h.status === 'queued' && h.operator && Array.isArray(h.changes); });
      if (ticket.status !== 'queued' || approved) return;
      var now = new Date().toISOString();
      ticket.history.push({status:'pending-review',at:now,reason:'Existing unstarted request moved to admin review during rollout.'});
      row[13] = 'pending-review'; row[17] = now; row[18] = ticket.revision + 1; row[28] = JSON.stringify(ticket.history);
      sheet.getRange(index + 2,1,1,HEADERS.length).setValues([row.map(escapeCell_)]);
    });
    SpreadsheetApp.flush();
    invalidatePublicQueueCache_();
  } finally { lock.releaseLock(); }
}

function telegramBotUsername_(properties) {
  var username = String(properties.getProperty('TELEGRAM_BOT_USERNAME') || '').trim().replace(/^@/, '');
  return /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username) ? username : '';
}

function telegramText_(value) {
  return String(value == null ? '' : value).replace(/^'(?=-?\d+$)/, '');
}

function telegramDateMs_(value) {
  if (value instanceof Date) return value.getTime();
  var parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function sha256Hex_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value)).map(function(byte) {
    return (byte < 0 ? byte + 256 : byte).toString(16).padStart(2, '0');
  }).join('');
}

function telegramLinkForTicket_(book, ticket) {
  var properties = PropertiesService.getScriptProperties();
  var username = telegramBotUsername_(properties);
  var tokenConfigured = /^\d{6,15}:[A-Za-z0-9_-]{30,}$/.test(String(properties.getProperty('TELEGRAM_BOT_TOKEN') || '').trim());
  if (!username || !tokenConfigured || !ticket || !ticket.id || !ticket.ticketNumber) return null;

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var subscriptions = ensureTelegramSheets_(book).subscriptions;
    var rowNumber = findRow_(subscriptions, TELEGRAM_SUB.TICKET_ID + 1, ticket.id);
    var existing = rowNumber ? subscriptions.getRange(rowNumber, 1, 1, TELEGRAM_SUBSCRIPTION_HEADERS.length).getValues()[0] : null;
    if (existing && String(existing[TELEGRAM_SUB.STATE]) === 'enabled' && telegramText_(existing[TELEGRAM_SUB.CHAT_ID])) return { linked: true };

    var token = String(Utilities.getUuid()).replace(/-/g, '');
    var now = new Date();
    var row = existing || Array(TELEGRAM_SUBSCRIPTION_HEADERS.length).fill('');
    row[TELEGRAM_SUB.TICKET_ID] = ticket.id;
    row[TELEGRAM_SUB.TICKET_NUMBER] = ticket.ticketNumber;
    row[TELEGRAM_SUB.CHAT_ID] = '';
    row[TELEGRAM_SUB.USER_ID] = '';
    row[TELEGRAM_SUB.STATE] = 'pending';
    row[TELEGRAM_SUB.LINKED_AT] = '';
    row[TELEGRAM_SUB.DISABLED_AT] = '';
    row[TELEGRAM_SUB.TOKEN_HASH] = sha256Hex_(token);
    row[TELEGRAM_SUB.TOKEN_EXPIRES] = new Date(now.getTime() + TELEGRAM_LINK_TTL_MS);
    row[TELEGRAM_SUB.TOKEN_ISSUED] = now;
    var target = rowNumber || subscriptions.getLastRow() + 1;
    subscriptions.getRange(target, 1, 1, row.length).setValues([row.map(escapeCell_)]);
    SpreadsheetApp.flush();
    return { linked: false, url: 'https://t.me/' + username + '?start=' + token };
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function parseTelegramCommand_(text) {
  var match = /^\/([A-Za-z]+)(?:@[A-Za-z0-9_]+)?(?:\s+([^\r\n]{1,100}))?\s*$/.exec(String(text || '').trim());
  return match ? { command: match[1].toLowerCase(), argument: String(match[2] || '').trim() } : null;
}

function telegramStatusLabel_(status) {
  return ({
    'pending-review': 'Awaiting review',
    declined: 'Declined',
    queued: 'Waiting in the queue',
    'in-progress': 'In progress',
    ready: 'Ready for pickup',
    collected: 'Collected',
    cancelled: 'Cancelled'
  })[String(status || '').toLowerCase()] || 'Unknown';
}

function telegramPushMessage_(ticketNumber, status, declineReason) {
  if (status === 'ready') return ticketNumber + ' is ready for pickup.';
  if (status === 'declined') {
    var reason = String(declineReason || '').trim();
    return ticketNumber + ' was declined.' + (reason ? '\nReason: ' + reason : '');
  }
  return '';
}

function telegramStaffValue_(value, fallback) {
  var text = String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .trim();
  return text || fallback || 'Not provided';
}

function telegramStaffNumber_(value) {
  var number = Number(value);
  return Number.isFinite(number) && number > 0 ? String(number) : '';
}

function telegramStaffSize_(ticket) {
  var width = telegramStaffNumber_(ticket && ticket.width);
  var length = telegramStaffNumber_(ticket && ticket.length);
  if (width && length) return width + ' × ' + length + ' in';
  if (width) return width + ' in wide (length not provided)';
  if (length) return length + ' in long (width not provided)';
  return 'Not provided';
}

function telegramStaffSubmittedAt_(value) {
  var date = new Date(value);
  if (Number.isFinite(date.getTime())) {
    try {
      if (typeof Utilities !== 'undefined' && typeof Session !== 'undefined') {
        return Utilities.formatDate(date, Session.getScriptTimeZone(), 'MMM d, yyyy · h:mm a z');
      }
    } catch (_error) { /* Fall back to an unambiguous UTC timestamp. */ }
    return date.toISOString().replace('T', ' ').replace(/:\d{2}\.\d{3}Z$/, ' UTC');
  }
  return telegramStaffValue_(value, 'Unknown');
}

function telegramStaffNewTicketMessage_(ticket) {
  ticket = ticket || {};
  var machine = String(ticket.machine || '');
  var lines = [
    '🆕 NEW WORKSHOP TICKET',
    telegramStaffValue_(ticket.ticketNumber, 'Ticket number pending') + ' · Awaiting review',
    'Submitted: ' + telegramStaffSubmittedAt_(ticket.createdAt),
    '',
    '👤 REQUESTER',
    'Name: ' + telegramStaffValue_(ticket.customerName),
    'Department: ' + telegramStaffValue_(ticket.department),
    'Phone: ' + telegramStaffValue_(ticket.phone),
    '',
    '📋 REQUEST',
    'Service: ' + (MACHINES[machine] || telegramStaffValue_(ticket.machineName, 'Workshop request')),
    'Purpose:',
    telegramStaffValue_(ticket.purpose),
    '',
    '⚙️ JOB DETAILS',
    'Quantity: ' + telegramStaffValue_(telegramStaffNumber_(ticket.quantity)),
    'Finished size: ' + telegramStaffSize_(ticket)
  ];
  if (machine === 'foam') lines.push('Foam thickness: ' + (telegramStaffNumber_(ticket.thickness) ? telegramStaffNumber_(ticket.thickness) + ' in' : 'Not provided'));
  if (telegramStaffValue_(ticket.paperType, '') !== 'Not provided') lines.push('Paper: ' + telegramStaffValue_(ticket.paperType));
  lines.push('Needed by: ' + telegramStaffValue_(ticket.neededBy, 'No rush'));
  lines.push('');
  lines.push('📝 ADDITIONAL NOTES');
  lines.push(telegramStaffValue_(ticket.notes, 'None provided'));
  lines.push('');
  var files = Array.isArray(ticket.files) ? ticket.files : [];
  lines.push('📎 FILES (' + files.length + ')');
  if (!files.length) {
    lines.push('None attached.');
    return lines.join('\n');
  }
  files.slice(0, MAX_FILES).forEach(function(file, index) {
    var name = telegramStaffValue_(file && file.originalName, 'Artwork ' + (index + 1)).replace(/\n+/g, ' ');
    var url = String(file && file.url || '').trim();
    lines.push((index + 1) + '. ' + name);
    lines.push(/^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]+\/view$/.test(url) ? '   ' + url : '   File link unavailable');
  });
  return lines.join('\n');
}

function telegramMessageChunks_(message, maxLength) {
  var remaining = String(message || '');
  var limit = Number.isSafeInteger(maxLength) && maxLength > 100 ? maxLength : TELEGRAM_STAFF_MESSAGE_CHUNK;
  var chunks = [];
  while (remaining.length > limit) {
    var splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt < Math.floor(limit / 2)) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
    if (remaining.charAt(0) === '\n') remaining = remaining.slice(1);
  }
  if (remaining || !chunks.length) chunks.push(remaining);
  return chunks;
}

function telegramStaffNewTicketMessages_(ticket) {
  var chunks = telegramMessageChunks_(telegramStaffNewTicketMessage_(ticket), TELEGRAM_STAFF_MESSAGE_CHUNK);
  if (chunks.length === 1) return chunks;
  return chunks.map(function(chunk, index) {
    if (index === 0) return chunk + '\n\nPart 1 of ' + chunks.length;
    return '↳ ' + telegramStaffValue_(ticket && ticket.ticketNumber, 'Ticket') + ' continued · Part ' + (index + 1) + ' of ' + chunks.length + '\n\n' + chunk;
  });
}

function telegramApiRequest_(method, payload, token) {
  var response;
  try {
    response = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload || {}),
      muteHttpExceptions: true
    });
  } catch (_error) {
    // UrlFetch errors may contain the request URL. Never let a token-bearing URL
    // reach Apps Script execution logs or the notification journal.
    throw new Error('Telegram could not be reached. Try again shortly.');
  }
  var body;
  try { body = JSON.parse(response.getContentText() || '{}'); } catch (_error) { body = {}; }
  return {
    ok: response.getResponseCode() >= 200 && response.getResponseCode() < 300 && body.ok === true,
    httpCode: response.getResponseCode(),
    result: body.result,
    description: String(body.description || ''),
    parameters: body.parameters || {}
  };
}

function telegramSheetRows_(sheet, width) {
  return sheet.getLastRow() < 2 ? [] : sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
}

function appendTelegramOutbox_(outbox, record, existingIds) {
  if (!record.eventId || (existingIds && existingIds.has(record.eventId)) || findRow_(outbox, TELEGRAM_OUT.EVENT_ID + 1, record.eventId)) return false;
  var now = new Date();
  var row = Array(TELEGRAM_OUTBOX_HEADERS.length).fill('');
  row[TELEGRAM_OUT.EVENT_ID] = record.eventId;
  row[TELEGRAM_OUT.TICKET_ID] = record.ticketId || '';
  row[TELEGRAM_OUT.TICKET_NUMBER] = record.ticketNumber || '';
  row[TELEGRAM_OUT.AUDIENCE] = record.audience || 'requester';
  row[TELEGRAM_OUT.CHAT_ID] = record.chatId;
  row[TELEGRAM_OUT.STATUS] = record.status || 'command';
  row[TELEGRAM_OUT.MESSAGE] = record.message;
  row[TELEGRAM_OUT.STATE] = 'pending';
  row[TELEGRAM_OUT.ATTEMPTS] = 0;
  row[TELEGRAM_OUT.NEXT_ATTEMPT] = now;
  row[TELEGRAM_OUT.CREATED] = now;
  row[TELEGRAM_OUT.UPDATED] = now;
  outbox.getRange(outbox.getLastRow() + 1, 1, 1, row.length).setValues([row.map(escapeCell_)]);
  if (existingIds) existingIds.add(record.eventId);
  return true;
}

function telegramCommandReply_(outbox, updateId, chatId, message, audience, suffix) {
  return appendTelegramOutbox_(outbox, {
    eventId: 'command-' + updateId + '-' + (suffix || 'reply'),
    audience: audience || 'requester',
    chatId: chatId,
    status: 'command',
    message: message
  });
}

function telegramTicketMap_(book) {
  var tickets = workshopRows_(ensureTicketSheet_(book)).map(staffTicket_);
  var byId = new Map();
  var byNumber = new Map();
  tickets.forEach(function(ticket) { byId.set(ticket.id, ticket); byNumber.set(ticket.ticketNumber, ticket); });
  return { tickets: tickets, byId: byId, byNumber: byNumber };
}

function disableTelegramChat_(subscriptions, outbox, chatId) {
  var normalized = String(chatId);
  var now = new Date();
  var disabled = 0;
  telegramSheetRows_(subscriptions, TELEGRAM_SUBSCRIPTION_HEADERS.length).forEach(function(row, index) {
    if (String(row[TELEGRAM_SUB.STATE]) !== 'enabled' || telegramText_(row[TELEGRAM_SUB.CHAT_ID]) !== normalized) return;
    row[TELEGRAM_SUB.STATE] = 'disabled';
    row[TELEGRAM_SUB.DISABLED_AT] = now;
    row[TELEGRAM_SUB.CHAT_ID] = '';
    row[TELEGRAM_SUB.USER_ID] = '';
    subscriptions.getRange(index + 2, 1, 1, row.length).setValues([row.map(escapeCell_)]);
    disabled++;
  });
  telegramSheetRows_(outbox, TELEGRAM_OUTBOX_HEADERS.length).forEach(function(row, index) {
    if (row[TELEGRAM_OUT.AUDIENCE] !== 'requester' || telegramText_(row[TELEGRAM_OUT.CHAT_ID]) !== normalized || row[TELEGRAM_OUT.STATE] !== 'pending') return;
    row[TELEGRAM_OUT.STATE] = 'superseded';
    row[TELEGRAM_OUT.UPDATED] = now;
    row[TELEGRAM_OUT.DETAIL] = 'The requester turned off Telegram updates before this message was sent.';
    outbox.getRange(index + 2, 1, 1, row.length).setValues([row.map(escapeCell_)]);
  });
  return disabled;
}

function handleTelegramUpdate_(update, book, subscriptions, outbox, properties) {
  var message = update && update.message;
  if (!message || !message.chat || typeof message.text !== 'string') return;
  var parsed = parseTelegramCommand_(message.text);
  if (!parsed) return;
  var chatId = String(message.chat.id);
  var chatType = String(message.chat.type || '');
  var updateId = String(update.update_id);
  var ticketMap = telegramTicketMap_(book);

  if (parsed.command === 'registerstaff') {
    if (chatType !== 'group' && chatType !== 'supergroup') {
      telegramCommandReply_(outbox, updateId, chatId, 'Staff registration must be sent inside the private staff group.', 'staff', 'register');
      return;
    }
    var expected = String(properties.getProperty('TELEGRAM_STAFF_REGISTRATION_CODE') || '');
    var expires = Number(properties.getProperty('TELEGRAM_STAFF_REGISTRATION_EXPIRES') || 0);
    if (!expected || parsed.argument !== expected || Date.now() > expires) {
      telegramCommandReply_(outbox, updateId, chatId, 'That staff registration code is invalid or expired. Run Telegram setup from the ticket Sheet again.', 'staff', 'register');
      return;
    }
    properties.setProperty('TELEGRAM_STAFF_CHAT_ID', chatId);
    properties.setProperty('TELEGRAM_STAFF_REGISTERED_AT', new Date().toISOString());
    properties.deleteProperty('TELEGRAM_STAFF_REGISTRATION_CODE');
    properties.deleteProperty('TELEGRAM_STAFF_REGISTRATION_EXPIRES');
    telegramCommandReply_(outbox, updateId, chatId, 'Private staff group registered. New ticket, ready, and declined updates will appear here.', 'staff', 'register');
    return;
  }

  if (parsed.command === 'start') {
    if (chatType !== 'private') return;
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(parsed.argument)) {
      telegramCommandReply_(outbox, updateId, chatId, 'Open the Telegram update link from your ticket receipt to link a ticket.', 'requester', 'start');
      return;
    }
    var tokenHash = sha256Hex_(parsed.argument);
    var subscriptionRow = findRow_(subscriptions, TELEGRAM_SUB.TOKEN_HASH + 1, tokenHash);
    if (!subscriptionRow) {
      telegramCommandReply_(outbox, updateId, chatId, 'This ticket link is invalid, expired, or has already been used.', 'requester', 'start');
      return;
    }
    var subscription = subscriptions.getRange(subscriptionRow, 1, 1, TELEGRAM_SUBSCRIPTION_HEADERS.length).getValues()[0];
    if (telegramDateMs_(subscription[TELEGRAM_SUB.TOKEN_EXPIRES]) < Date.now()) {
      subscription[TELEGRAM_SUB.STATE] = 'expired';
      subscription[TELEGRAM_SUB.TOKEN_HASH] = '';
      subscription[TELEGRAM_SUB.TOKEN_EXPIRES] = '';
      subscriptions.getRange(subscriptionRow, 1, 1, subscription.length).setValues([subscription.map(escapeCell_)]);
      telegramCommandReply_(outbox, updateId, chatId, 'This ticket link has expired. Use the public live queue for updates.', 'requester', 'start');
      return;
    }
    var ticket = ticketMap.byId.get(String(subscription[TELEGRAM_SUB.TICKET_ID]));
    if (!ticket) {
      telegramCommandReply_(outbox, updateId, chatId, 'This ticket could not be found.', 'requester', 'start');
      return;
    }
    subscription[TELEGRAM_SUB.CHAT_ID] = chatId;
    subscription[TELEGRAM_SUB.USER_ID] = message.from && message.from.id != null ? String(message.from.id) : '';
    subscription[TELEGRAM_SUB.STATE] = 'enabled';
    subscription[TELEGRAM_SUB.LINKED_AT] = new Date();
    subscription[TELEGRAM_SUB.DISABLED_AT] = '';
    subscription[TELEGRAM_SUB.TOKEN_HASH] = '';
    subscription[TELEGRAM_SUB.TOKEN_EXPIRES] = '';
    subscriptions.getRange(subscriptionRow, 1, 1, subscription.length).setValues([subscription.map(escapeCell_)]);
    telegramCommandReply_(outbox, updateId, chatId,
      'Telegram updates are enabled for ' + ticket.ticketNumber + '.\nCurrent status: ' + telegramStatusLabel_(ticket.status) + '.\nUse /status anytime or /stop to turn off updates.',
      'requester', 'start');
    return;
  }

  if (parsed.command === 'status') {
    var staffChat = String(properties.getProperty('TELEGRAM_STAFF_CHAT_ID') || '');
    if ((chatType === 'group' || chatType === 'supergroup') && chatId === staffChat) {
      var number = parsed.argument.toUpperCase();
      if (!/^[PF]-\d{4,8}$/.test(number)) {
        telegramCommandReply_(outbox, updateId, chatId, 'Use /status followed by a ticket number, for example /status P-0001.', 'staff', 'status');
        return;
      }
      var staffTicket = ticketMap.byNumber.get(number);
      telegramCommandReply_(outbox, updateId, chatId, staffTicket ? staffTicket.ticketNumber + ' — ' + telegramStatusLabel_(staffTicket.status) : 'Ticket not found.', 'staff', 'status');
      return;
    }
    if (chatType !== 'private') return;
    var linkedIds = telegramSheetRows_(subscriptions, TELEGRAM_SUBSCRIPTION_HEADERS.length).filter(function(row) {
      return row[TELEGRAM_SUB.STATE] === 'enabled' && telegramText_(row[TELEGRAM_SUB.CHAT_ID]) === chatId;
    }).map(function(row) { return String(row[TELEGRAM_SUB.TICKET_ID]); });
    var lines = linkedIds.map(function(id) { return ticketMap.byId.get(id); }).filter(Boolean).map(function(ticket) {
      return ticket.ticketNumber + ' — ' + telegramStatusLabel_(ticket.status);
    });
    telegramCommandReply_(outbox, updateId, chatId, lines.length ? 'Your ticket status:\n' + lines.join('\n') : 'No tickets are linked to this Telegram chat. Open the Telegram update link from a ticket receipt.', 'requester', 'status');
    return;
  }

  if (parsed.command === 'stop' && chatType === 'private') {
    var count = disableTelegramChat_(subscriptions, outbox, chatId);
    telegramCommandReply_(outbox, updateId, chatId, count ? 'Telegram ticket updates are now turned off.' : 'No active ticket updates were linked to this chat.', 'requester', 'stop');
    return;
  }

  if (parsed.command === 'help' || (parsed.command === 'start' && !parsed.argument)) {
    var help = chatType === 'private'
      ? 'Use /status to check linked tickets or /stop to turn off updates. Link a ticket from the Telegram button on its receipt.'
      : 'Staff can use /status P-0001 to check a ticket. New ticket, ready, and declined updates are posted automatically after this group is registered.';
    telegramCommandReply_(outbox, updateId, chatId, help, chatType === 'private' ? 'requester' : 'staff', 'help');
  }
}

function reconcileTelegramEvents_(book, subscriptions, outbox, properties) {
  var map = telegramTicketMap_(book);
  var existingIds = new Set(telegramSheetRows_(outbox, TELEGRAM_OUTBOX_HEADERS.length).map(function(row) { return String(row[TELEGRAM_OUT.EVENT_ID]); }));
  var enabledByTicket = new Map();
  telegramSheetRows_(subscriptions, TELEGRAM_SUBSCRIPTION_HEADERS.length).forEach(function(row) {
    if (row[TELEGRAM_SUB.STATE] === 'enabled' && telegramText_(row[TELEGRAM_SUB.CHAT_ID])) enabledByTicket.set(String(row[TELEGRAM_SUB.TICKET_ID]), row);
  });
  var staffChat = String(properties.getProperty('TELEGRAM_STAFF_CHAT_ID') || '');
  var staffLinkedAt = Date.parse(String(properties.getProperty('TELEGRAM_STAFF_REGISTERED_AT') || '')) || 0;
  var created = 0;
  map.tickets.forEach(function(ticket) {
    var ticketCreatedAt = Date.parse(String(ticket.createdAt || '')) || 0;
    if (staffChat && ticketCreatedAt && ticketCreatedAt >= staffLinkedAt) {
      var staffNewEventId = sha256Hex_([ticket.id, ticket.createdAt, 'new', 'staff', staffChat].join('|'));
      // The original event ID remains the first message so deploying this richer
      // format never re-sends historical ticket alerts to the staff group.
      if (!existingIds.has(staffNewEventId)) telegramStaffNewTicketMessages_(ticket).forEach(function(message, partIndex) {
        created += appendTelegramOutbox_(outbox, {
          eventId: partIndex === 0 ? staffNewEventId : sha256Hex_([ticket.id, ticket.createdAt, 'new', 'staff', staffChat, 'part', partIndex + 1].join('|')),
          ticketId: ticket.id,
          ticketNumber: ticket.ticketNumber,
          audience: 'staff',
          chatId: staffChat,
          status: 'new',
          message: message
        }, existingIds) ? 1 : 0;
      });
    }
    (ticket.history || []).forEach(function(entry) {
      var status = String(entry.status || '');
      if (TELEGRAM_PUSH_STATUSES.indexOf(status) === -1 || !entry.at) return;
      if (status === 'ready' && ticket.status !== 'ready') return;
      var eventAt = Date.parse(entry.at) || 0;
      var message = telegramPushMessage_(ticket.ticketNumber, status, entry.reason || ticket.reason);
      var subscription = enabledByTicket.get(ticket.id);
      if (subscription && eventAt >= telegramDateMs_(subscription[TELEGRAM_SUB.LINKED_AT])) {
        var requesterChat = telegramText_(subscription[TELEGRAM_SUB.CHAT_ID]);
        created += appendTelegramOutbox_(outbox, {
          eventId: sha256Hex_([ticket.id, entry.at, status, 'requester', requesterChat].join('|')),
          ticketId: ticket.id,
          ticketNumber: ticket.ticketNumber,
          audience: 'requester',
          chatId: requesterChat,
          status: status,
          message: message
        }, existingIds) ? 1 : 0;
      }
      if (staffChat && eventAt >= staffLinkedAt) {
        created += appendTelegramOutbox_(outbox, {
          eventId: sha256Hex_([ticket.id, entry.at, status, 'staff', staffChat].join('|')),
          ticketId: ticket.id,
          ticketNumber: ticket.ticketNumber,
          audience: 'staff',
          chatId: staffChat,
          status: status,
          message: message
        }, existingIds) ? 1 : 0;
      }
    });
  });
  return created;
}

function claimTelegramOutbox_(book, outbox, onlyTicketId, batchSize) {
  var now = Date.now();
  var ticketMap = telegramTicketMap_(book).byId;
  var claimed = [];
  var ticketFilter = String(onlyTicketId || '');
  var limit = Number.isSafeInteger(batchSize) && batchSize > 0 ? batchSize : TELEGRAM_SEND_BATCH_SIZE;
  telegramSheetRows_(outbox, TELEGRAM_OUTBOX_HEADERS.length).forEach(function(row, index) {
    var state = String(row[TELEGRAM_OUT.STATE] || '');
    var updated = telegramDateMs_(row[TELEGRAM_OUT.UPDATED]);
    if (state === 'sending' && updated && now - updated > TELEGRAM_STALE_SEND_MS) {
      row[TELEGRAM_OUT.STATE] = 'unknown';
      row[TELEGRAM_OUT.UPDATED] = new Date(now);
      row[TELEGRAM_OUT.DETAIL] = 'The Apps Script run ended during the send. Check Telegram before retrying to avoid a duplicate.';
      outbox.getRange(index + 2, 1, 1, row.length).setValues([row.map(escapeCell_)]);
      return;
    }
    if (ticketFilter && String(row[TELEGRAM_OUT.TICKET_ID] || '') !== ticketFilter) return;
    if (state !== 'pending' || telegramDateMs_(row[TELEGRAM_OUT.NEXT_ATTEMPT]) > now || claimed.length >= limit) return;
    var ticket = ticketMap.get(String(row[TELEGRAM_OUT.TICKET_ID] || ''));
    if (row[TELEGRAM_OUT.STATUS] === 'ready' && ticket && ticket.status !== 'ready') {
      row[TELEGRAM_OUT.STATE] = 'superseded';
      row[TELEGRAM_OUT.UPDATED] = new Date(now);
      row[TELEGRAM_OUT.DETAIL] = 'The ticket moved on before the ready message was sent.';
      outbox.getRange(index + 2, 1, 1, row.length).setValues([row.map(escapeCell_)]);
      return;
    }
    var attempts = Number(row[TELEGRAM_OUT.ATTEMPTS] || 0) + 1;
    if (attempts > 5) {
      row[TELEGRAM_OUT.STATE] = 'failed';
      row[TELEGRAM_OUT.UPDATED] = new Date(now);
      row[TELEGRAM_OUT.DETAIL] = 'Telegram rejected this message repeatedly.';
      outbox.getRange(index + 2, 1, 1, row.length).setValues([row.map(escapeCell_)]);
      return;
    }
    row[TELEGRAM_OUT.STATE] = 'sending';
    row[TELEGRAM_OUT.ATTEMPTS] = attempts;
    row[TELEGRAM_OUT.UPDATED] = new Date(now);
    row[TELEGRAM_OUT.DETAIL] = '';
    outbox.getRange(index + 2, 1, 1, row.length).setValues([row.map(escapeCell_)]);
    claimed.push({
      rowNumber: index + 2,
      eventId: String(row[TELEGRAM_OUT.EVENT_ID]),
      audience: String(row[TELEGRAM_OUT.AUDIENCE]),
      chatId: telegramText_(row[TELEGRAM_OUT.CHAT_ID]),
      message: String(row[TELEGRAM_OUT.MESSAGE]),
      attempts: attempts
    });
  });
  return claimed;
}

function telegramDeliveryOutcome_(response, attempts, now) {
  if (response && response.ok && response.result && response.result.message_id != null) {
    return { state: 'sent', messageId: String(response.result.message_id), nextAttempt: '', detail: 'Accepted by Telegram.' };
  }
  var code = Number(response && response.httpCode || 0);
  if (code === 429 && attempts < 5) {
    var retryAfter = Math.max(1, Math.min(3600, Number(response.parameters && response.parameters.retry_after || 30)));
    return { state: 'pending', messageId: '', nextAttempt: new Date(now + retryAfter * 1000), detail: 'Telegram rate limit reached; retry scheduled.' };
  }
  if (code >= 500 && attempts < 5) {
    return { state: 'pending', messageId: '', nextAttempt: new Date(now + Math.min(60, Math.pow(2, attempts)) * 1000), detail: 'Telegram is temporarily unavailable; retry scheduled.' };
  }
  var description = String(response && response.description || '').replace(/\s+/g, ' ').trim();
  return { state: 'failed', messageId: '', nextAttempt: '', detail: description ? 'Telegram rejected the message: ' + description.slice(0, 220) : 'Telegram rejected the message.' };
}

function updateTelegramDelivery_(attempt, outcome, responseCode) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var book = openBook_();
    var sheets = ensureTelegramSheets_(book);
    var rowNumber = attempt.rowNumber;
    var row = sheets.outbox.getRange(rowNumber, 1, 1, TELEGRAM_OUTBOX_HEADERS.length).getValues()[0];
    if (String(row[TELEGRAM_OUT.EVENT_ID]) !== attempt.eventId) {
      rowNumber = findRow_(sheets.outbox, TELEGRAM_OUT.EVENT_ID + 1, attempt.eventId);
      if (!rowNumber) return;
      row = sheets.outbox.getRange(rowNumber, 1, 1, TELEGRAM_OUTBOX_HEADERS.length).getValues()[0];
    }
    row[TELEGRAM_OUT.STATE] = outcome.state;
    row[TELEGRAM_OUT.NEXT_ATTEMPT] = outcome.nextAttempt;
    row[TELEGRAM_OUT.UPDATED] = new Date();
    row[TELEGRAM_OUT.MESSAGE_ID] = outcome.messageId;
    row[TELEGRAM_OUT.DETAIL] = outcome.detail;
    sheets.outbox.getRange(rowNumber, 1, 1, row.length).setValues([row.map(escapeCell_)]);
    if (responseCode === 403 && attempt.audience === 'requester') disableTelegramChat_(sheets.subscriptions, sheets.outbox, attempt.chatId);
    if (responseCode === 403 && attempt.audience === 'staff') {
      var properties = PropertiesService.getScriptProperties();
      if (String(properties.getProperty('TELEGRAM_STAFF_CHAT_ID') || '') === String(attempt.chatId)) {
        properties.deleteProperty('TELEGRAM_STAFF_CHAT_ID');
        properties.deleteProperty('TELEGRAM_STAFF_REGISTERED_AT');
      }
    }
    SpreadsheetApp.flush();
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function processTelegramNotifications() {
  return processTelegramNotifications_({ pollUpdates: true });
}

function processTelegramTicketNotifications_(ticketId) {
  var normalized = String(ticketId || '');
  if (!normalized) return { configured: false, updates: 0, queued: 0, sent: 0 };
  return processTelegramNotifications_({ pollUpdates: false, ticketId: normalized, batchSize: 4 });
}

function processTelegramNotifications_(options) {
  options = options || {};
  var properties = PropertiesService.getScriptProperties();
  var token = String(properties.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!/^\d{6,15}:[A-Za-z0-9_-]{30,}$/.test(token)) return { configured: false, updates: 0, queued: 0, sent: 0 };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { configured: true, busy: true, updates: 0, queued: 0, sent: 0 };
  var claimed = [];
  var updateCount = 0;
  var queued = 0;
  try {
    var offset = Number(properties.getProperty('TELEGRAM_UPDATE_OFFSET') || 0);
    var updates = [];
    if (options.pollUpdates !== false) {
      var response = telegramApiRequest_('getUpdates', { offset: offset, limit: 100, timeout: 0, allowed_updates: ['message'] }, token);
      if (!response.ok || !Array.isArray(response.result)) throw new Error('Telegram update polling failed. Check the bot token and setup status.');
      updates = response.result;
    }
    var book = openBook_();
    var sheets = ensureTelegramSheets_(book);
    var nextOffset = offset;
    updates.forEach(function(update) {
      try { handleTelegramUpdate_(update, book, sheets.subscriptions, sheets.outbox, properties); }
      catch (error) { console.error('Telegram update ' + String(update.update_id) + ' failed: ' + safeError_(error)); }
      if (Number.isSafeInteger(update.update_id)) nextOffset = Math.max(nextOffset, update.update_id + 1);
      updateCount++;
    });
    queued = reconcileTelegramEvents_(book, sheets.subscriptions, sheets.outbox, properties);
    claimed = claimTelegramOutbox_(book, sheets.outbox, options.ticketId, options.batchSize);
    SpreadsheetApp.flush();
    if (options.pollUpdates !== false) properties.setProperty('TELEGRAM_UPDATE_OFFSET', String(nextOffset));
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }

  var sent = 0;
  claimed.forEach(function(attempt) {
    var outcome;
    var responseCode = 0;
    try {
      var result = telegramApiRequest_('sendMessage', { chat_id: attempt.chatId, text: attempt.message, disable_web_page_preview: true }, token);
      responseCode = result.httpCode;
      outcome = telegramDeliveryOutcome_(result, attempt.attempts, Date.now());
    } catch (_error) {
      outcome = { state: 'unknown', messageId: '', nextAttempt: '', detail: 'The connection ended during the send. Check Telegram before retrying to avoid a duplicate.' };
    }
    if (outcome.state === 'sent') sent++;
    updateTelegramDelivery_(attempt, outcome, responseCode);
  });
  return { configured: true, updates: updateCount, queued: queued, sent: sent };
}
