export const SHEETS_MAX_FILES = 5;
export const SHEETS_MAX_FILE_BYTES = 200 * 1024 * 1024;
export const SHEETS_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
export const SHEETS_MAX_VECTOR_FILE_BYTES = 10 * 1024 * 1024;
export const SHEETS_MAX_INLINE_FILE_BYTES = 5 * 1024 * 1024;
export const SHEETS_MAX_INLINE_TOTAL_BYTES = 10 * 1024 * 1024;

const DRIVE_CHUNK_BYTES = 10 * 1024 * 1024;
const DRIVE_MAX_RECOVERY_ATTEMPTS = 5;
const DRIVE_REQUEST_TIMEOUT = 5 * 60 * 1000;
const SHEETS_REQUEST_ATTEMPTS = 5;
const SHEETS_CONFIRMATION_ATTEMPTS = 12;
const SHEETS_CREATE_RETRY_ATTEMPT = 5;
const SHEETS_UPLOAD_START_TIMEOUT = 45000;
const SHEETS_CREATE_POST_TIMEOUT = 45000;
const uploadedFilesByRequest = new Map();
const wait = milliseconds => new Promise(resolve => window.setTimeout(resolve, milliseconds));

export function validateNeededByDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) throw new Error('Choose a valid needed-by date.');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== value) throw new Error('Choose a valid needed-by date.');
  return value;
}

// Keep the current deployed Apps Script compatible until its separately
// versioned backend is republished. New versions prefer neededByDate below.
export function legacySheetsDeadline(value, now = new Date()) {
  validateNeededByDate(value);
  const target = Date.parse(`${value}T00:00:00Z`);
  const start = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((target - start) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days <= 7) return 'This week';
  return 'No rush';
}

export function legacySheetsNotes(value, neededBy) {
  const note = String(value || '');
  const result = `Needed by date: ${validateNeededByDate(neededBy)}${note ? `\n${note}` : ''}`;
  if (result.length > 4000) throw new Error('Notes are too long to include the needed-by date.');
  return result;
}

const fileRule = machine => {
  if (machine === 'printer') return { pattern: /\.(pdf|jpg|jpeg|jpe|jfif|png|apng|gif|webp|bmp|dib|tif|tiff|avif|heic|heif|hif|ico|jxl)$/i, message: 'Poster printing accepts PDF or common image files only.' };
  if (machine === 'foam') return { pattern: /\.(svg|dxf)$/i, message: 'Foam cutting accepts SVG or DXF files only.' };
  throw new Error('Choose a request type before adding files.');
};

export function validateFileTypes(files, machine) {
  const rule = fileRule(machine);
  for (const file of files) {
    if (!rule.pattern.test(file.name)) throw new Error(rule.message);
  }
}

export function validateFileSelection(files, machine) {
  if (!files.length) throw new Error('Attach at least one artwork file to submit a ticket.');
  validateFileTypes(files, machine);
  let total = 0;
  for (const file of files) {
    if (file.size < 1) throw new Error('Empty files cannot be submitted.');
    if (/\.(?:svg|dxf)$/i.test(file.name) && file.size > SHEETS_MAX_VECTOR_FILE_BYTES) {
      throw new Error('SVG and DXF files must be 10 MB or smaller so their full contents can be checked.');
    }
    total += file.size;
  }
  if (total > SHEETS_MAX_TOTAL_BYTES) throw new Error('Attachments must total 200 MB or less.');
}

export function validateSheetsFiles(files, machine) {
  if (files.length > SHEETS_MAX_FILES) throw new Error(`Attach no more than ${SHEETS_MAX_FILES} files.`);
  validateFileSelection(files, machine);
  for (const file of files) {
    if (file.size > SHEETS_MAX_FILE_BYTES) throw new Error('Each file must be 200 MB or smaller.');
  }
}

function sheetsJsonpAttempt(url, parameters, timeout) {
  return new Promise((resolve, reject) => {
    const callback = `__mandirTicket_${crypto.getRandomValues(new Uint32Array(2)).join('_')}`;
    const script = document.createElement('script');
    const timer = window.setTimeout(() => finish(new Error('The ticket service took too long to respond.')), timeout);
    const finish = (error, value) => {
      window.clearTimeout(timer);
      script.remove();
      delete window[callback];
      if (error) reject(error); else resolve(value);
    };
    window[callback] = value => finish(null, value);
    script.onerror = () => finish(new Error('The ticket service could not be reached.'));
    const query = new URLSearchParams({ ...parameters, callback, cache: Date.now().toString() });
    script.src = `${url}?${query}`;
    document.head.append(script);
  });
}

function sheetsFetchAttempt(url, parameters, timeout, {
  fetcher = fetch,
  setTimer = (callback, milliseconds) => window.setTimeout(callback, milliseconds),
  clearTimer = timer => window.clearTimeout(timer),
} = {}) {
  const callback = `__mandirTicket_${crypto.getRandomValues(new Uint32Array(2)).join('_')}`;
  const requestUrl = new URL(url);
  Object.entries({ ...parameters, callback, cache: Date.now().toString() })
    .forEach(([key, value]) => requestUrl.searchParams.set(key, value));
  const controller = new AbortController();
  const timer = setTimer(() => controller.abort(), timeout);

  return fetcher(requestUrl, {
    method: 'GET',
    mode: 'cors',
    cache: 'no-store',
    redirect: 'follow',
    signal: controller.signal,
  }).then(async response => {
    if (!response.ok) throw new Error(`The ticket service returned HTTP ${response.status}.`);
    const source = (await response.text()).trim();
    const prefix = `${callback}(`;
    if (source.startsWith(prefix) && source.endsWith(');')) {
      return JSON.parse(source.slice(prefix.length, -2));
    }
    // Apps Script returns JSON for failures that happen before callback
    // validation. Accept it so the real backend message is not hidden.
    return JSON.parse(source);
  }).finally(() => clearTimer(timer));
}

async function sheetsRead(url, parameters, timeout, {
  attempts = SHEETS_REQUEST_ATTEMPTS,
  pause = wait,
  fetchAttempt = sheetsFetchAttempt,
  jsonpAttempt = sheetsJsonpAttempt,
} = {}) {
  // Some privacy extensions block cross-site script tags while allowing CORS
  // reads; other older browsers do the reverse. Alternate transports across
  // retries so queue reads and upload handshakes can recover in either case.
  return retrySheetsTransport(attempt => (
    attempt % 2
      ? fetchAttempt(url, parameters, timeout)
      : jsonpAttempt(url, parameters, timeout)
  ), { attempts, pause });
}

export async function retrySheetsTransport(request, { attempts = SHEETS_REQUEST_ATTEMPTS, pause = wait } = {}) {
  const attemptCount = Math.max(1, Math.floor(attempts));
  let lastError;
  for (let attempt = 1; attempt <= attemptCount; attempt++) {
    try {
      return await request(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < attemptCount) await pause(Math.min(1000 * (2 ** (attempt - 1)), 8000));
    }
  }
  throw lastError;
}

export async function sheetsJsonp(url, parameters, timeout = 15000) {
  try {
    return await retrySheetsTransport(() => sheetsJsonpAttempt(url, parameters, timeout));
  } catch (cause) {
    throw new Error('Google did not respond after several attempts. Your form and files are still here, so wait a moment and choose Try again.', { cause });
  }
}

export async function fetchSheetsQueue(url, {
  timeout = 12000,
  attempts = 3,
  pause = wait,
  fetchAttempt = sheetsFetchAttempt,
  jsonpAttempt = sheetsJsonpAttempt,
} = {}) {
  try {
    return await sheetsRead(url, { action: 'queue' }, timeout, {
      attempts,
      pause,
      fetchAttempt,
      jsonpAttempt,
    });
  } catch (cause) {
    throw new Error('The live queue is taking too long to respond.', { cause });
  }
}

export async function postSheetsTicket(url, request, {
  fetcher = fetch,
  timeout = SHEETS_CREATE_POST_TIMEOUT,
  setTimer = (callback, milliseconds) => window.setTimeout(callback, milliseconds),
  clearTimer = timer => window.clearTimeout(timer),
} = {}) {
  const controller = new AbortController();
  const timer = setTimer(() => controller.abort(), timeout);
  try {
    return await fetcher(url, {
      method: 'POST',
      mode: 'no-cors',
      cache: 'no-store',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } catch (cause) {
    if (controller.signal.aborted) throw new Error('Google took too long to save the ticket.', { cause });
    throw cause;
  } finally {
    clearTimer(timer);
  }
}

export async function trackSheetsTicket(url, { ticket, code, requestKey } = {}) {
  let response;
  try {
    response = await sheetsRead(url, {
      action: 'track',
      ...(requestKey ? { requestKey } : { ticket: String(ticket || '').trim().toUpperCase(), code: String(code || '').trim().toUpperCase() }),
    }, 15000);
  } catch (cause) {
    throw new Error('Google did not respond after several attempts. Your form and files are still here, so wait a moment and choose Try again.', { cause });
  }
  if (!response?.ok) {
    const error = new Error(response?.error || 'The ticket could not be found.');
    error.retryable = response?.pending === true;
    throw error;
  }
  return response.ticket;
}

export function driveNextOffset(rangeHeader, fallback) {
  const match = /^bytes=0-(\d+)$/.exec(String(rangeHeader || '').trim());
  if (!match) return fallback;
  const offset = Number(match[1]) + 1;
  return Number.isSafeInteger(offset) ? offset : fallback;
}

function driveRequestError(message, retryable = false) {
  const error = new Error(message);
  error.retryable = retryable;
  return error;
}

function putDriveChunk(sessionUrl, file, start, end, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', sessionUrl);
    xhr.timeout = DRIVE_REQUEST_TIMEOUT;
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('Content-Range', `bytes ${start}-${end - 1}/${file.size}`);
    xhr.upload.onprogress = event => onProgress(start + event.loaded);
    xhr.onerror = () => reject(driveRequestError('The file upload was interrupted.', true));
    xhr.ontimeout = () => reject(driveRequestError('The file upload paused for too long.', true));
    xhr.onabort = () => reject(driveRequestError('The file upload was interrupted.', true));
    xhr.onload = () => {
      if (xhr.status === 308) {
        const nextOffset = driveNextOffset(xhr.getResponseHeader('Range'), -1);
        if (nextOffset < 0) {
          reject(driveRequestError('Google Drive did not confirm the uploaded byte range.', true));
          return;
        }
        resolve({ nextOffset });
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(driveRequestError('Google Drive could not save the file.', xhr.status === 408 || xhr.status === 429 || xhr.status >= 500));
        return;
      }
      try {
        resolve({ nextOffset: file.size, receipt: JSON.parse(xhr.responseText) });
      } catch {
        reject(driveRequestError('Google Drive saved the file but did not return a file receipt.', true));
      }
    };
    xhr.send(file.slice(start, end, file.type || 'application/octet-stream'));
  });
}

function queryDriveUpload(sessionUrl, file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', sessionUrl);
    xhr.timeout = DRIVE_REQUEST_TIMEOUT;
    xhr.setRequestHeader('Content-Range', `bytes */${file.size}`);
    xhr.onerror = () => reject(driveRequestError('Google Drive upload recovery was interrupted.', true));
    xhr.ontimeout = () => reject(driveRequestError('Google Drive upload recovery took too long.', true));
    xhr.onabort = () => reject(driveRequestError('Google Drive upload recovery was interrupted.', true));
    xhr.onload = () => {
      if (xhr.status === 308) {
        resolve({ nextOffset: driveNextOffset(xhr.getResponseHeader('Range'), 0) });
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(driveRequestError('Google Drive could not recover the file upload.', xhr.status === 408 || xhr.status === 429 || xhr.status >= 500));
        return;
      }
      try {
        resolve({ nextOffset: file.size, receipt: JSON.parse(xhr.responseText) });
      } catch {
        reject(driveRequestError('Google Drive did not return the recovered file receipt.', true));
      }
    };
    xhr.send();
  });
}

export async function uploadDriveFile(sessionUrl, file, onProgress, {
  put = putDriveChunk,
  query = queryDriveUpload,
  pause = wait,
  maxRecoveryAttempts = DRIVE_MAX_RECOVERY_ATTEMPTS,
} = {}) {
  const reportProgress = typeof onProgress === 'function' ? onProgress : () => {};
  let nextOffset = 0;
  let reportedOffset = 0;
  let recoveryAttempts = 0;
  let needsQuery = false;
  while (true) {
    try {
      const result = !needsQuery && nextOffset < file.size
        ? await put(sessionUrl, file, nextOffset, Math.min(nextOffset + DRIVE_CHUNK_BYTES, file.size), loaded => {
          reportedOffset = Math.max(reportedOffset, Math.min(loaded, file.size));
          reportProgress(reportedOffset);
        })
        : await query(sessionUrl, file);
      if (result?.receipt?.id) {
        reportProgress(file.size);
        return result.receipt;
      }
      const confirmedOffset = Number(result?.nextOffset);
      if (!Number.isSafeInteger(confirmedOffset) || confirmedOffset < 0 || confirmedOffset > file.size) {
        throw driveRequestError('Google Drive returned an invalid upload position.');
      }
      if (confirmedOffset > nextOffset) recoveryAttempts = 0;
      else recoveryAttempts++;
      nextOffset = confirmedOffset;
      needsQuery = false;
      reportedOffset = Math.max(reportedOffset, nextOffset);
      reportProgress(reportedOffset);
      if (recoveryAttempts > maxRecoveryAttempts) throw driveRequestError('Google Drive could not make progress on the file upload.');
      if (recoveryAttempts) await pause(Math.min(1000 * (2 ** (recoveryAttempts - 1)), 8000));
    } catch (error) {
      if (!error?.retryable) throw error;
      recoveryAttempts++;
      needsQuery = true;
      if (recoveryAttempts > maxRecoveryAttempts) {
        throw new Error('The file upload could not recover after several attempts. Your form and file are still selected; choose Try again.');
      }
      await pause(Math.min(1000 * (2 ** (recoveryAttempts - 1)), 8000));
    }
  }
}

export async function encodeInlineFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('The selected file could not be read. Choose it again and retry.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== file.size) throw new Error('The selected file changed while it was being read. Choose it again and retry.');
  let binary = '';
  const chunkSize = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

async function uploadFiles(url, details, files, onProgress) {
  validateSheetsFiles(files, details.machine);
  const fingerprint = JSON.stringify({
    details: {
      machine: details.machine,
      customerName: details.customerName,
      department: details.department,
      purpose: details.purpose,
      phone: details.phone,
      smsConsent: details.smsConsent,
      notes: details.notes,
      quantity: details.quantity,
      width: details.width,
      length: details.length,
      thickness: details.thickness,
      neededBy: details.neededBy,
      paperType: details.paperType,
      website: details.website,
    },
    files: files.map(file => [file.name, file.size, file.type || '', file.lastModified || 0]),
  });
  let cached = uploadedFilesByRequest.get(details.requestKey);
  const sameFiles = cached?.files?.length === files.length && cached.files.every((file, index) => file === files[index]);
  if (cached && (cached.fingerprint !== fingerprint || !sameFiles)) {
    throw new Error('This retry has different details or files. Reload the form to start a new request instead of changing an upload that may already have been saved.');
  }
  if (!cached) {
    cached = { fingerprint, files: files.slice(), uploaded: [] };
    uploadedFilesByRequest.set(details.requestKey, cached);
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const uploaded = cached.uploaded.slice();
  let completedBytes = uploaded.reduce((sum, file) => sum + file.size, 0);
  let inlineBytes = uploaded.reduce((sum, file) => sum + (file.data ? file.size : 0), 0);
  if (completedBytes) onProgress?.(Math.max(1, Math.round((completedBytes / totalBytes) * 90)));
  for (let index = uploaded.length; index < files.length; index++) {
    const file = files[index];
    const canUploadInline = /\.(?:svg|dxf)$/i.test(file.name)
      && file.size <= SHEETS_MAX_INLINE_FILE_BYTES
      && inlineBytes + file.size <= SHEETS_MAX_INLINE_TOTAL_BYTES;
    if (canUploadInline) {
      const data = await encodeInlineFile(file);
      uploaded.push({
        name: file.name,
        type: file.type || 'application/octet-stream',
        size: file.size,
        data,
      });
      cached.uploaded = uploaded.slice();
      inlineBytes += file.size;
      completedBytes += file.size;
      onProgress?.(Math.max(1, Math.round((completedBytes / totalBytes) * 90)));
      continue;
    }
    let response;
    try {
      response = await sheetsRead(url, {
        action: 'beginUpload',
        requestKey: details.requestKey,
        startedAt: details.startedAt,
        machine: details.machine,
        index,
        name: file.name,
        type: file.type || 'application/octet-stream',
        size: file.size,
        origin: location.origin,
      }, SHEETS_UPLOAD_START_TIMEOUT);
    } catch (cause) {
      throw new Error('Google did not start the file upload. Your form and file are still selected; wait a moment and choose Try again.', { cause });
    }
    if (!response?.ok || !response.sessionUrl) throw new Error(response?.error || 'The file upload could not be started.');
    const receipt = await uploadDriveFile(response.sessionUrl, file, loaded => {
      const fraction = totalBytes ? (completedBytes + Math.min(loaded, file.size)) / totalBytes : 1;
      onProgress?.(Math.max(1, Math.round(fraction * 90)));
    });
    if (!/^[a-f0-9]{32}$/i.test(String(receipt.md5Checksum || ''))) throw new Error('Google Drive did not return a file integrity check. Please try again.');
    uploaded.push({
      id: receipt.id,
      index,
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      md5Checksum: receipt.md5Checksum.toLowerCase(),
    });
    cached.uploaded = uploaded.slice();
    completedBytes += file.size;
  }
  return uploaded;
}

export async function createSheetsTicket(url, details, files, onProgress) {
  const normalizedDetails = {
    ...details,
    phone: details.phone ?? '',
    smsConsent: details.smsConsent ?? false,
    width: details.width ?? '',
    length: details.length ?? '',
    neededBy: details.neededBy === undefined ? 'No rush' : details.neededBy,
  };
  const hasRequestedDate = normalizedDetails.neededBy !== 'No rush';
  if (hasRequestedDate) validateNeededByDate(normalizedDetails.neededBy);
  const compatibleNotes = hasRequestedDate
    ? legacySheetsNotes(normalizedDetails.notes, normalizedDetails.neededBy)
    : String(normalizedDetails.notes || '');
  const uploadedFiles = await uploadFiles(url, normalizedDetails, files, onProgress);
  onProgress?.(92);
  const createRequest = {
    action: 'createTicket',
    ...normalizedDetails,
    ...(hasRequestedDate ? {
      neededByDate: normalizedDetails.neededBy,
      neededBy: legacySheetsDeadline(normalizedDetails.neededBy),
    } : {}),
    notes: compatibleNotes,
    files: uploadedFiles,
  };
  const sendCreateRequest = () => postSheetsTicket(url, createRequest);
  await retrySheetsTransport(sendCreateRequest, { attempts: 3 });
  onProgress?.(95);
  let lastError;
  for (let attempt = 0; attempt < SHEETS_CONFIRMATION_ATTEMPTS; attempt++) {
    try {
      const ticket = await trackSheetsTicket(url, { requestKey: normalizedDetails.requestKey });
      onProgress?.(100);
      uploadedFilesByRequest.delete(normalizedDetails.requestKey);
      return ticket;
    } catch (error) {
      lastError = error;
      if (!error?.retryable) throw error;
      if (attempt === SHEETS_CREATE_RETRY_ATTEMPT) await retrySheetsTransport(sendCreateRequest, { attempts: 3 });
      if (attempt < SHEETS_CONFIRMATION_ATTEMPTS - 1) await wait(Math.min(1000 * (attempt + 1), 5000));
    }
  }
  throw new Error('Your files were uploaded, but Google has not confirmed the ticket yet. Choose Try again to finish without uploading the files again.', { cause: lastError });
}
