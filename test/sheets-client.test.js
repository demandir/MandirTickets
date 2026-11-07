import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSheetsTicket,
  driveNextOffset,
  encodeInlineFile,
  fetchSheetsQueue,
  legacySheetsDeadline,
  legacySheetsNotes,
  retrySheetsTransport,
  postSheetsTicket,
  uploadDriveFile,
  validateFileTypes,
  validateNeededByDate,
  validateSheetsFiles,
  SHEETS_MAX_FILE_BYTES,
  SHEETS_MAX_FILES,
  SHEETS_MAX_INLINE_FILE_BYTES,
  SHEETS_MAX_TOTAL_BYTES,
  SHEETS_MAX_VECTOR_FILE_BYTES,
} from '../src/sheets-api.js';

const file = (name, size = 1024) => ({ name, size });
const foamArtwork = () => {
  const contents = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>');
  return {
    name: 'layout.svg',
    size: contents.length,
    type: 'image/svg+xml',
    lastModified: 1770000004000,
    arrayBuffer: async () => contents.buffer.slice(contents.byteOffset, contents.byteOffset + contents.byteLength),
  };
};

const requestDetails = requestKey => ({
  requestKey,
  startedAt: Date.now() - 2000,
  machine: 'printer',
  customerName: 'Pipeline Test',
  department: 'Workshop',
  purpose: 'Verify upload delivery',
  phone: '',
  notes: '',
  quantity: '1',
  width: '24',
  length: '36',
  neededBy: '2099-12-31',
  paperType: 'Standard',
  website: '',
});

async function withBrowserPipeline({ jsonp, xhr = [], onPost = () => {} }, operation) {
  const original = {
    document: globalThis.document,
    fetch: globalThis.fetch,
    location: globalThis.location,
    window: globalThis.window,
    XMLHttpRequest: globalThis.XMLHttpRequest,
  };
  const uploads = [];
  let nextTimer = 0;

  class FakeXMLHttpRequest {
    upload = {};
    headers = {};

    open(method, url) {
      this.method = method;
      this.url = url;
    }

    setRequestHeader(name, value) {
      this.headers[name] = value;
    }

    send(body) {
      const response = xhr.shift();
      assert.ok(response, `Unexpected upload request to ${this.url}`);
      uploads.push({ method: this.method, url: this.url, headers: { ...this.headers }, body });
      this.upload.onprogress?.({ loaded: body?.size || 0 });
      if (response.error) {
        this.onerror();
        return;
      }
      this.responseHeaders = response.headers || {};
      this.status = response.status;
      this.responseText = response.body === undefined ? '' : JSON.stringify(response.body);
      this.onload();
    }

    getResponseHeader(name) {
      const match = Object.keys(this.responseHeaders || {}).find(key => key.toLowerCase() === name.toLowerCase());
      return match ? this.responseHeaders[match] : null;
    }
  }

  globalThis.window = {
    setTimeout(callback, milliseconds) {
      const timer = ++nextTimer;
      // Transport timeouts remain inert; retry and confirmation pauses complete immediately.
      if (milliseconds < 10000) queueMicrotask(callback);
      return timer;
    },
    clearTimeout() {},
  };
  globalThis.location = { origin: 'https://demandir.github.io' };
  globalThis.document = {
    createElement: () => ({ remove() {} }),
    head: {
      append(script) {
        const url = new URL(script.src);
        const parameters = Object.fromEntries(url.searchParams);
        const response = jsonp(parameters);
        queueMicrotask(() => response?.transportError ? script.onerror() : globalThis.window[parameters.callback](response));
      },
    },
  };
  globalThis.XMLHttpRequest = FakeXMLHttpRequest;
  globalThis.fetch = async (url, options) => {
    if (options.method === 'GET') {
      const requestUrl = new URL(url);
      const parameters = Object.fromEntries(requestUrl.searchParams);
      const response = jsonp(parameters);
      if (response?.transportError) throw new Error('GET transport failed');
      return {
        ok: true,
        status: 200,
        text: async () => `${parameters.callback}(${JSON.stringify(response)});`,
      };
    }
    onPost(JSON.parse(options.body));
    return {};
  };

  try {
    return await operation({ uploads });
  } finally {
    globalThis.document = original.document;
    globalThis.fetch = original.fetch;
    globalThis.location = original.location;
    globalThis.window = original.window;
    globalThis.XMLHttpRequest = original.XMLHttpRequest;
  }
}

test('client accepts every printer format while keeping foam files restricted', () => {
  assert.doesNotThrow(() => validateSheetsFiles([file('poster.pdf'), file('phone.HEIC'), file('art.webp'), file('modern.avif'), file('icon.ico')], 'printer'));
  assert.doesNotThrow(() => validateFileTypes([file('layout.ai'), file('archive.zip'), file('README')], 'printer'));
  assert.doesNotThrow(() => validateSheetsFiles([file('letters.svg'), file('layout.dxf')], 'foam'));
  assert.throws(() => validateFileTypes([file('photo.jpg')], 'foam'), /SVG or DXF/i);
});

test('small vector files are encoded losslessly for server-side Drive storage', async () => {
  const bytes = Uint8Array.from([0, 10, 13, 32, 65, 127, 128, 255]);
  const data = await encodeInlineFile({ size: bytes.length, arrayBuffer: async () => bytes.buffer });
  assert.deepEqual(Uint8Array.from(Buffer.from(data, 'base64')), bytes);
  await assert.rejects(
    encodeInlineFile({ size: bytes.length + 1, arrayBuffer: async () => bytes.buffer }),
    /changed while it was being read/i,
  );
});

test('Google Sheets client enforces count, extension, per-file, and total limits', () => {
  assert.throws(() => validateSheetsFiles([], 'foam'), /at least one artwork file/i);
  assert.throws(() => validateSheetsFiles(Array.from({ length: SHEETS_MAX_FILES + 1 }, (_, index) => file(`${index}.pdf`)), 'printer'), /no more than/i);
  assert.doesNotThrow(() => validateSheetsFiles([file('installer.exe')], 'printer'));
  assert.throws(() => validateSheetsFiles([file('oversize.pdf', SHEETS_MAX_FILE_BYTES + 1)], 'printer'), /200 MB/i);
  assert.throws(() => validateSheetsFiles([file('oversize.svg', SHEETS_MAX_VECTOR_FILE_BYTES + 1)], 'foam'), /10 MB/i);
  assert.throws(() => validateSheetsFiles([file('one.pdf', SHEETS_MAX_TOTAL_BYTES), file('two.pdf', 1)], 'printer'), /200 MB/i);
});

test('calendar dates are validated and mapped for the currently deployed Sheets backend', () => {
  assert.equal(validateNeededByDate('2099-12-31'), '2099-12-31');
  assert.throws(() => validateNeededByDate('2099-02-29'), /valid needed-by date/i);
  const now = new Date(2026, 9, 24, 12);
  assert.equal(legacySheetsDeadline('2026-10-24', now), 'Today');
  assert.equal(legacySheetsDeadline('2026-10-25', now), 'Tomorrow');
  assert.equal(legacySheetsDeadline('2026-10-30', now), 'This week');
  assert.equal(legacySheetsDeadline('2026-11-15', now), 'No rush');
  assert.equal(legacySheetsNotes('Use the blue logo.', '2026-11-15'), 'Needed by date: 2026-11-15\nUse the blue logo.');
});

test('Google Sheets client retries transient transport failures', async () => {
  let calls = 0;
  const pauses = [];
  const result = await retrySheetsTransport(async () => {
    calls++;
    if (calls < 3) throw new Error('temporary redirect failure');
    return { ok: true };
  }, {
    attempts: 3,
    pause: async milliseconds => pauses.push(milliseconds),
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 3);
  assert.deepEqual(pauses, [1000, 2000]);
});

test('Google Sheets client stops retrying after the final transport failure', async () => {
  let calls = 0;
  await assert.rejects(
    retrySheetsTransport(async () => {
      calls++;
      throw new Error('still offline');
    }, { attempts: 3, pause: async () => {} }),
    /still offline/,
  );
  assert.equal(calls, 3);
});

test('ticket creation POST aborts when Google never settles the request', async () => {
  let aborts = 0;
  const fetcher = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      aborts++;
      reject(options.signal.reason);
    });
  });

  await assert.rejects(
    postSheetsTicket('https://script.example/exec', { action: 'createTicket' }, {
      fetcher,
      timeout: 1,
      setTimer: callback => { queueMicrotask(callback); return 1; },
      clearTimer: () => {},
    }),
    /too long/i,
  );
  assert.equal(aborts, 1);
});

test('live queue uses a short retry budget and recovers from one transport failure', async () => {
  let calls = 0;
  const result = await withBrowserPipeline({
    jsonp(parameters) {
      assert.equal(parameters.action, 'queue');
      calls++;
      return calls === 1 ? { transportError: true } : { ok: true, machines: [] };
    },
  }, () => fetchSheetsQueue('https://script.example/exec', { timeout: 10000, attempts: 2, pause: async () => {} }));

  assert.equal(calls, 2);
  assert.deepEqual(result.machines, []);
});

test('live queue tolerates two cold-start transport failures before showing an error', async () => {
  let calls = 0;
  const result = await withBrowserPipeline({
    jsonp(parameters) {
      assert.equal(parameters.action, 'queue');
      calls++;
      return calls < 3 ? { transportError: true } : { ok: true, machines: [] };
    },
  }, () => fetchSheetsQueue('https://script.example/exec'));

  assert.equal(calls, 3);
  assert.deepEqual(result.machines, []);
});

test('live queue alternates CORS and JSONP so either browser transport can recover', async () => {
  const transports = [];
  const result = await fetchSheetsQueue('https://script.example/exec', {
    attempts: 3,
    pause: async () => {},
    fetchAttempt: async () => {
      transports.push('fetch');
      throw new Error('privacy extension blocked the CORS request');
    },
    jsonpAttempt: async () => {
      transports.push('jsonp');
      return { ok: true, machines: [] };
    },
  });

  assert.deepEqual(transports, ['fetch', 'jsonp']);
  assert.deepEqual(result.machines, []);
});

test('Google Sheets client uses a longer default retry window', async () => {
  let calls = 0;
  const pauses = [];
  await assert.rejects(
    retrySheetsTransport(async () => {
      calls++;
      throw new Error('temporarily unavailable');
    }, { pause: async milliseconds => pauses.push(milliseconds) }),
    /temporarily unavailable/,
  );
  assert.equal(calls, 5);
  assert.deepEqual(pauses, [1000, 2000, 4000, 8000]);
});

test('completed Drive receipts are reused when ticket confirmation must be retried', async () => {
  const artwork = {
    name: 'poster.pdf',
    size: 4096,
    type: 'application/pdf',
    lastModified: 1770000000000,
    slice: (start, end) => ({ size: end - start }),
  };
  let beginUploads = 0;
  let trackCalls = 0;
  const posts = [];

  await withBrowserPipeline({
    jsonp(parameters) {
      if (parameters.action === 'beginUpload') {
        assert.equal(parameters.machine, 'printer');
        beginUploads++;
        return { ok: true, sessionUrl: 'https://www.googleapis.com/upload/session-one' };
      }
      trackCalls++;
      if (trackCalls <= 12) return { ok: false, pending: true, error: 'The ticket is still being saved.' };
      return { ok: true, ticket: { ticketNumber: 'P-0042', trackingCode: 'ABCD2345', status: 'queued' } };
    },
    xhr: [{ status: 200, body: { id: 'drive_file_12345', size: '4096', mimeType: 'application/pdf', md5Checksum: '0123456789abcdef0123456789abcdef' } }],
    onPost: body => posts.push(body),
  }, async ({ uploads }) => {
    const details = requestDetails('11111111111111111111111111111111');
    await assert.rejects(createSheetsTicket('https://script.example/exec', details, [artwork]), /without uploading the files again/i);
    const ticket = await createSheetsTicket('https://script.example/exec', details, [artwork]);

    assert.equal(ticket.ticketNumber, 'P-0042');
    assert.equal(beginUploads, 1, 'a confirmed Drive file must not be uploaded a second time');
    assert.equal(uploads.length, 1, 'retry should reuse the cached Drive receipt');
    assert.equal(posts.length, 3, 'confirmation should retry the idempotent create request, then user retry should resend it once');
    assert.deepEqual(posts[1].files, [{
      id: 'drive_file_12345',
      index: 0,
      name: 'poster.pdf',
      type: 'application/pdf',
      size: 4096,
      md5Checksum: '0123456789abcdef0123456789abcdef',
    }]);
    assert.deepEqual(posts[2].files, posts[1].files);
  });
});

test('ticket creation surfaces a permanent backend failure without polling it as pending', async () => {
  const artwork = {
    name: 'poster.pdf',
    size: 4096,
    type: 'application/pdf',
    lastModified: 1770000000000,
    slice: (start, end) => ({ size: end - start }),
  };
  let trackCalls = 0;

  await withBrowserPipeline({
    jsonp(parameters) {
      if (parameters.action === 'beginUpload') return { ok: true, sessionUrl: 'https://www.googleapis.com/upload/permanent-error' };
      trackCalls++;
      return { ok: false, pending: false, error: 'The destination Sheet rejected the row.' };
    },
    xhr: [{ status: 200, body: { id: 'drive_file_error', md5Checksum: '0123456789abcdef0123456789abcdef' } }],
  }, async () => {
    await assert.rejects(
      createSheetsTicket('https://script.example/exec', requestDetails('5'.repeat(32)), [artwork]),
      /destination Sheet rejected the row/i,
    );
  });

  assert.equal(trackCalls, 1);
});

test('a changed retry cannot reuse a request key after an uncertain submission', async () => {
  const makeArtwork = marker => ({
    marker,
    name: 'poster.pdf',
    size: 4096,
    type: 'application/pdf',
    lastModified: 1770000000000,
    slice: (start, end) => ({ marker, size: end - start }),
  });
  const firstArtwork = makeArtwork('first');
  const replacementArtwork = makeArtwork('replacement');
  let beginUploads = 0;
  let trackCalls = 0;

  await withBrowserPipeline({
    jsonp(parameters) {
      if (parameters.action === 'beginUpload') {
        beginUploads++;
        return { ok: true, sessionUrl: `https://www.googleapis.com/upload/session-${beginUploads}` };
      }
      trackCalls++;
      return { ok: false, pending: true, error: 'The ticket is still being saved.' };
    },
    xhr: [
      { status: 200, body: { id: 'drive_file_first', md5Checksum: '0123456789abcdef0123456789abcdef' } },
    ],
  }, async ({ uploads }) => {
    const details = requestDetails('22222222222222222222222222222222');
    await assert.rejects(createSheetsTicket('https://script.example/exec', details, [firstArtwork]), /without uploading the files again/i);
    await assert.rejects(createSheetsTicket('https://script.example/exec', details, [replacementArtwork]), /different details or files/i);
    await assert.rejects(createSheetsTicket('https://script.example/exec', { ...details, purpose: 'Changed purpose' }, [firstArtwork]), /different details or files/i);

    assert.equal(beginUploads, 1);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].body.marker, 'first');
  });
});

test('Drive range parsing uses only confirmed resumable-upload offsets', () => {
  assert.equal(driveNextOffset('bytes=0-10485759', 0), 10485760);
  assert.equal(driveNextOffset('bytes=0-0', 12), 1);
  assert.equal(driveNextOffset('bytes=5-10', 12), 12);
  assert.equal(driveNextOffset('garbage', 12), 12);
});

test('an ambiguous 308 response queries Drive instead of skipping an unconfirmed chunk', async () => {
  const mebibyte = 1024 * 1024;
  const size = 15 * mebibyte;
  const artwork = {
    name: 'poster.pdf',
    size,
    type: 'application/pdf',
    slice: (start, end) => ({ size: end - start }),
  };

  await withBrowserPipeline({
    jsonp: () => ({ ok: true }),
    xhr: [
      { status: 308 },
      { status: 308, headers: {} },
      { status: 308, headers: { Range: `bytes=0-${5 * mebibyte - 1}` } },
      { status: 308, headers: { Range: `bytes=0-${15 * mebibyte - 1}` } },
      { status: 200, body: { id: 'drive_file_complete', md5Checksum: '0123456789abcdef0123456789abcdef' } },
    ],
  }, async ({ uploads }) => {
    const receipt = await uploadDriveFile('https://www.googleapis.com/upload/ambiguous-session', artwork, () => {});
    assert.equal(receipt.id, 'drive_file_complete');
    assert.deepEqual(uploads.map(request => request.headers['Content-Range']), [
      `bytes 0-${10 * mebibyte - 1}/${size}`,
      `bytes */${size}`,
      `bytes 0-${10 * mebibyte - 1}/${size}`,
      `bytes ${5 * mebibyte}-${15 * mebibyte - 1}/${size}`,
      `bytes */${size}`,
    ]);
  });
});

test('an interrupted Drive upload resumes at the server-confirmed offset without resending bytes', async () => {
  const mebibyte = 1024 * 1024;
  const size = 25 * mebibyte;
  const artwork = { name: 'large-poster.pdf', size, type: 'application/pdf' };
  const starts = [];
  const progress = [];
  let queries = 0;
  let firstPut = true;

  const receipt = await uploadDriveFile('https://www.googleapis.com/upload/session-one', artwork, value => progress.push(value), {
    async put(_url, _file, start, end) {
      starts.push([start, end]);
      if (firstPut) {
        firstPut = false;
        const error = new Error('response was lost after a partial write');
        error.retryable = true;
        throw error;
      }
      if (start === 5 * mebibyte) return { nextOffset: 15 * mebibyte };
      return {
        nextOffset: size,
        receipt: {
          id: 'drive_file_resume',
          size: String(size),
          md5Checksum: '1234567890abcdef1234567890abcdef',
        },
      };
    },
    async query() {
      queries++;
      return { nextOffset: 5 * mebibyte };
    },
    pause: async () => {},
  });

  assert.equal(receipt.id, 'drive_file_resume');
  assert.equal(queries, 1);
  assert.deepEqual(starts, [
    [0, 10 * mebibyte],
    [5 * mebibyte, 15 * mebibyte],
    [15 * mebibyte, 25 * mebibyte],
  ]);
  assert.ok(starts.slice(1).every(([start]) => start >= 5 * mebibyte), 'confirmed bytes must never be sent again');
  assert.deepEqual(progress, [...progress].sort((a, b) => a - b), 'progress must never move backwards during recovery');
  assert.equal(progress.at(-1), size);
});

test('Drive recovery keeps querying after a transient status failure before sending more bytes', async () => {
  const mebibyte = 1024 * 1024;
  const size = 8 * mebibyte;
  const starts = [];
  let queries = 0;

  const receipt = await uploadDriveFile(
    'https://www.googleapis.com/upload/recovery-session',
    { name: 'poster.pdf', size, type: 'application/pdf' },
    () => {},
    {
      async put(_url, _file, start) {
        starts.push(start);
        if (start === 0) {
          const error = new Error('upload response was lost');
          error.retryable = true;
          throw error;
        }
        return {
          nextOffset: size,
          receipt: { id: 'drive_file_recovered', md5Checksum: '1234567890abcdef1234567890abcdef' },
        };
      },
      async query() {
        queries++;
        if (queries === 1) {
          const error = new Error('status response was also lost');
          error.retryable = true;
          throw error;
        }
        return { nextOffset: 3 * mebibyte };
      },
      pause: async () => {},
    },
  );

  assert.equal(receipt.id, 'drive_file_recovered');
  assert.equal(queries, 2);
  assert.deepEqual(starts, [0, 3 * mebibyte], 'an unknown upload position must be queried, not guessed or resent');
});

test('ticket creation preserves file identity metadata from selection through the POST receipt', async () => {
  const artwork = {
    name: 'annual-poster.PDF',
    size: 8192,
    type: 'application/pdf',
    lastModified: 1770000002000,
    slice: (start, end) => ({ size: end - start }),
  };
  let posted;

  await withBrowserPipeline({
    jsonp(parameters) {
      if (parameters.action === 'beginUpload') return { ok: true, sessionUrl: 'https://www.googleapis.com/upload/metadata-session' };
      return { ok: true, ticket: { ticketNumber: 'P-0044', trackingCode: 'CDEF4567', status: 'queued' } };
    },
    xhr: [{ status: 200, body: { id: 'drive_file_metadata', name: 'pending-name', size: '8192', mimeType: 'application/pdf', md5Checksum: 'abcdef0123456789abcdef0123456789' } }],
    onPost: body => { posted = body; },
  }, async () => {
    await createSheetsTicket(
      'https://script.example/exec',
      requestDetails('33333333333333333333333333333333'),
      [artwork],
    );
  });

  assert.equal(posted.action, 'createTicket');
  assert.equal(posted.neededByDate, '2099-12-31');
  assert.equal(posted.neededBy, 'No rush');
  assert.equal(posted.notes, 'Needed by date: 2099-12-31');
  assert.deepEqual(posted.files, [{
    id: 'drive_file_metadata',
    index: 0,
    name: artwork.name,
    type: artwork.type,
    size: artwork.size,
    md5Checksum: 'abcdef0123456789abcdef0123456789',
  }]);
});

test('ticket creation defaults to no rush when the customer form has no needed-by field', async () => {
  let posted;
  await withBrowserPipeline({
    jsonp: () => ({ ok: true, ticket: { ticketNumber: 'F-0045', trackingCode: 'DEFG5678', status: 'pending-review' } }),
    onPost: body => { posted = body; },
  }, async () => {
    const details = {
      ...requestDetails('44444444444444444444444444444444'),
      machine: 'foam',
      thickness: '2',
      notes: 'Use the blue foam.',
    };
    delete details.neededBy;
    await createSheetsTicket('https://script.example/exec', details, [foamArtwork()]);
  });

  assert.equal(posted.neededBy, 'No rush');
  assert.equal(Object.hasOwn(posted, 'neededByDate'), false);
  assert.equal(posted.notes, 'Use the blue foam.');
});

test('ticket creation supplies safe defaults when phone and size inputs are absent', async () => {
  let posted;
  await withBrowserPipeline({
    jsonp: () => ({ ok: true, ticket: { ticketNumber: 'F-0046', trackingCode: 'EFGH6789', status: 'pending-review' } }),
    onPost: body => { posted = body; },
  }, async () => {
    const details = {
      ...requestDetails('88888888888888888888888888888888'),
      machine: 'foam',
      thickness: '2',
    };
    delete details.phone;
    delete details.width;
    delete details.length;
    await createSheetsTicket('https://script.example/exec', details, [foamArtwork()]);
  });

  assert.equal(posted.phone, '');
  assert.equal(posted.smsConsent, false);
  assert.equal(posted.width, '');
  assert.equal(posted.length, '');
});

test('small DXF tickets bypass the fragile browser Drive handshake', async () => {
  const contents = Buffer.from('0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n');
  const artwork = {
    name: 'foam-layout.dxf',
    size: contents.length,
    type: 'image/vnd.dxf',
    lastModified: 1770000003000,
    arrayBuffer: async () => contents.buffer.slice(contents.byteOffset, contents.byteOffset + contents.byteLength),
  };
  let posted;

  await withBrowserPipeline({
    jsonp(parameters) {
      assert.notEqual(parameters.action, 'beginUpload', 'a small DXF must not depend on a browser Drive session');
      return { ok: true, ticket: { ticketNumber: 'F-0046', trackingCode: 'EFGH6789', status: 'pending-review' } };
    },
    onPost: body => { posted = body; },
  }, async () => {
    const details = {
      ...requestDetails('66666666666666666666666666666666'),
      machine: 'foam',
      thickness: '2',
    };
    await createSheetsTicket('https://script.example/exec', details, [artwork]);
  });

  assert.deepEqual(posted.files, [{
    name: artwork.name,
    type: artwork.type,
    size: artwork.size,
    data: contents.toString('base64'),
  }]);
});

test('vectors above the inline limit retain the resumable Drive path', async () => {
  const artwork = {
    name: 'large-layout.dxf',
    size: SHEETS_MAX_INLINE_FILE_BYTES + 1,
    type: 'application/dxf',
    lastModified: 1770000004000,
    slice: (start, end) => ({ size: end - start }),
  };
  let beginUploads = 0;

  await withBrowserPipeline({
    jsonp(parameters) {
      if (parameters.action === 'beginUpload') {
        beginUploads++;
        return { ok: true, sessionUrl: 'https://www.googleapis.com/upload/large-dxf-session' };
      }
      return { ok: true, ticket: { ticketNumber: 'F-0047', trackingCode: 'FGHJ789A', status: 'pending-review' } };
    },
    xhr: [{ status: 200, body: { id: 'drive_file_large_dxf', md5Checksum: '0123456789abcdef0123456789abcdef' } }],
  }, async () => {
    await createSheetsTicket('https://script.example/exec', {
      ...requestDetails('77777777777777777777777777777777'),
      machine: 'foam',
      thickness: '2',
    }, [artwork]);
  });

  assert.equal(beginUploads, 1);
});
