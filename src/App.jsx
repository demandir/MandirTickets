import qrcode from 'qrcode-generator';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FileArrowUp,
  Moon,
  Printer,
  Scissors,
  Sun,
  TelegramLogo,
  UploadSimple,
  X,
} from '@phosphor-icons/react';
import QueueBoard from './QueueBoard.jsx';
import { createSheetsTicket, trackSheetsTicket, validateFileSelection, validateSheetsFiles } from './sheets-api.js';

const MACHINES = {
  printer: 'Poster printing',
  foam: 'Foam cutting',
};

const LEGACY_MACHINE_NAMES = {
  '24-inch roll printer': MACHINES.printer,
  'Foam cutting machine': MACHINES.foam,
};

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const SHEETS_API_URL = (import.meta.env.VITE_GOOGLE_SCRIPT_URL || import.meta.env.WORKSHOP_GOOGLE_SCRIPT_URL || '').replace(/\/$/, '');
const apiUrl = path => `${API_BASE_URL}${path}`;
const staticPreview = location.hostname.endsWith('.github.io') && !API_BASE_URL && !SHEETS_API_URL;
const TELEGRAM_LINK_PATTERN = /^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{4,31}\?start=[A-Za-z0-9_-]{16,64}$/;

const machineName = ticket => MACHINES[ticket?.machine]
  || LEGACY_MACHINE_NAMES[ticket?.machineName]
  || ticket?.machineName
  || 'Workshop request';

const focusSection = id => window.setTimeout(() => {
  const target = document.getElementById(id);
  if (!target) return;
  target.focus({ preventScroll: true });
  target.scrollIntoView({
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    block: 'start',
  });
}, 0);

function TelegramQrCode({ link }) {
  const code = qrcode(0, 'M');
  code.addData(link);
  code.make();
  const size = code.getModuleCount();
  let path = '';
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (code.isDark(row, column)) path += `M${column} ${row}h1v1h-1z`;
    }
  }
  return (
    <figure className="telegram-qr">
      <svg viewBox={`-2 -2 ${size + 4} ${size + 4}`} role="img" aria-label="QR code that opens this ticket in Telegram">
        <rect x="-2" y="-2" width={size + 4} height={size + 4} fill="#fff" />
        <path d={path} fill="#000" />
      </svg>
      <figcaption><strong>On a computer?</strong> Scan this with your phone's camera to open Telegram there.</figcaption>
    </figure>
  );
}

const THEME_STORAGE = 'mandir-theme';

function storedTheme() {
  try {
    const theme = window.localStorage.getItem(THEME_STORAGE);
    return theme === 'light' || theme === 'dark' ? theme : '';
  } catch { return ''; }
}

export function applyStoredTheme() {
  const theme = storedTheme();
  if (theme) document.documentElement.dataset.theme = theme;
}

function currentTheme() {
  const theme = typeof window === 'undefined' ? '' : storedTheme();
  if (theme) return theme;
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function ThemeToggle() {
  const [theme, setTheme] = useState(currentTheme);
  const next = theme === 'dark' ? 'light' : 'dark';
  const toggle = () => {
    document.documentElement.dataset.theme = next;
    try { window.localStorage.setItem(THEME_STORAGE, next); } catch {}
    setTheme(next);
  };
  return (
    <button className="header-note theme-toggle" type="button" onClick={toggle} aria-label={`Switch to ${next} mode`}>
      {theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
    </button>
  );
}

const TELEGRAM_DEVICE_STORAGE = 'mandir-telegram-device';

function readTelegramDeviceKey() {
  try { return window.localStorage.getItem(TELEGRAM_DEVICE_STORAGE) || ''; } catch { return ''; }
}

function forgetTelegramDevice() {
  try { window.localStorage.removeItem(TELEGRAM_DEVICE_STORAGE); } catch {}
}

const createRequestKey = () => Array.from(
  crypto.getRandomValues(new Uint8Array(16)),
  value => value.toString(16).padStart(2, '0'),
).join('');

function telegramDeviceKey() {
  const existing = readTelegramDeviceKey();
  if (existing) return existing;
  const key = createRequestKey();
  try { window.localStorage.setItem(TELEGRAM_DEVICE_STORAGE, key); } catch {}
  return key;
}

export function TicketReceipt({ ticket, onStartAnother }) {
  const telegramLink = typeof ticket.telegramLink === 'string' && TELEGRAM_LINK_PATTERN.test(ticket.telegramLink)
    ? ticket.telegramLink
    : '';
  const telegramLinked = ticket.telegramLinked === true;
  return (
    <section className="receipt-card" id="ticket-receipt" tabIndex="-1" aria-labelledby="receipt-title">
      <span className="receipt-check"><Check size={25} weight="bold" aria-hidden="true" /></span>
      <p className="eyebrow">Ticket submitted</p>
      <h2 id="receipt-title">Your request is awaiting review.</h2>
      <p className="receipt-label">Ticket number</p>
      <strong className="receipt-number">{ticket.ticketNumber}</strong>
      <p>{machineName(ticket)} · {ticket.department}{ticket.position ? ` · ${ticket.position - 1} ${ticket.position === 2 ? 'job' : 'jobs'} ahead of you` : ''}</p>
      <p className="receipt-help">Your ticket was sent to the workshop immediately. Telegram is still required for ticket updates and pickup confirmation.</p>
      {telegramLinked && <aside className="telegram-opt-in telegram-opt-in-linked" aria-label="Telegram ticket notifications">
        <span className="telegram-opt-in-icon"><TelegramLogo size={28} weight="fill" aria-hidden="true" /></span>
        <span className="telegram-opt-in-copy"><strong>Telegram is connected</strong><span>We'll message you when the ticket is ready or declined. After collection, use /pickup in Telegram to close it.</span></span>
      </aside>}
      {telegramLink && !telegramLinked && <aside className="telegram-opt-in telegram-opt-in-requested" aria-label="Required Telegram ticket connection">
        <span className="telegram-opt-in-icon"><TelegramLogo size={28} weight="fill" aria-hidden="true" /></span>
        <span className="telegram-opt-in-copy"><strong>Required: finish linking Telegram</strong><span>Open Telegram and press Start. Keep this page open; confirmation can take up to one minute.</span></span>
        <a className="button telegram-button" href={telegramLink} target="_blank" rel="noreferrer">Continue to Telegram <ArrowRight weight="bold" aria-hidden="true" /></a>
        <TelegramQrCode link={telegramLink} />
      </aside>}
      <div className="receipt-actions">
        <button className="button button-secondary" type="button" onClick={() => window.print()}><Printer aria-hidden="true" /> Print receipt</button>
        <button className="button button-primary" type="button" onClick={onStartAnother} disabled={!telegramLinked}>Open another ticket <ArrowRight aria-hidden="true" /></button>
      </div>
      {!telegramLinked && <p className="receipt-help" role="status">Open another ticket after Telegram confirms this connection.</p>}
    </section>
  );
}

function Header() {
  return (
    <header className="site-header">
      <a className="brand" href={location.pathname} aria-label="Mandir workshop ticket home">
        <span><strong>Mandir</strong><small>Workshop tickets</small></span>
      </a>
      <nav className="header-links" aria-label="Page navigation">
        <a className="header-note header-queue-link" href="#queue">View queue</a>
        <a className="header-note header-staff-link" href="./staff/">Staff</a>
        <ThemeToggle />
      </nav>
    </header>
  );
}

function MachineChoice({ value, onChange }) {
  return (
    <section className="machine-step" aria-labelledby="ticket-question">
      <p className="eyebrow">Start a workshop ticket</p>
      <h1 id="ticket-question" tabIndex="-1">What do you need?</h1>
      <p className="intro">Choose a service. We will guide you through the details and show you the live queue before you submit.</p>
      <div className="machine-choices" role="group" aria-label="Choose a ticket type">
        <button className={value === 'printer' ? 'machine-choice selected' : 'machine-choice'} type="button" aria-pressed={value === 'printer'} aria-labelledby="poster-printing-title" aria-describedby="poster-printing-description" onClick={() => onChange('printer')}>
          <span className="choice-icon"><Printer size={34} weight="duotone" aria-hidden="true" /></span>
          <span className="choice-copy"><strong id="poster-printing-title">Poster printing</strong><small id="poster-printing-description">Posters, signs, stickers, and canvas up to 24 inches wide.</small></span>
          <span className="choice-select" aria-hidden="true">Start <ArrowRight weight="bold" /></span>
        </button>
        <button className={value === 'foam' ? 'machine-choice selected' : 'machine-choice'} type="button" aria-pressed={value === 'foam'} aria-labelledby="foam-cutting-title" aria-describedby="foam-cutting-description" onClick={() => onChange('foam')}>
          <span className="choice-icon"><Scissors size={34} weight="duotone" aria-hidden="true" /></span>
          <span className="choice-copy"><strong id="foam-cutting-title">Foam cutting</strong><small id="foam-cutting-description">Foam letters, shapes, signs, and display pieces.</small></span>
          <span className="choice-select" aria-hidden="true">Start <ArrowRight weight="bold" /></span>
        </button>
      </div>
    </section>
  );
}

export function TicketForm({ machine, onChangeMachine, onTicket }) {
  const formRef = useRef(null);
  const noticeRef = useRef(null);
  const requestKey = useRef(createRequestKey());
  const startedAt = useRef(Date.now());
  const [files, setFiles] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [notice, setNotice] = useState({ text: '', error: false });
  const [canRetry, setCanRetry] = useState(false);
  const [ticket, setTicket] = useState(null);
  const [telegramRemembered, setTelegramRemembered] = useState(() => Boolean(readTelegramDeviceKey()));

  const showNotice = (text, error = true) => {
    setNotice({ text, error });
    window.setTimeout(() => noticeRef.current?.focus(), 0);
  };

  useEffect(() => {
    const warn = event => {
      if (submitting) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [submitting]);

  useEffect(() => {
    if (!ticket || ticket.telegramLinked === true || !SHEETS_API_URL) return undefined;
    let cancelled = false;
    let timer;
    const refreshTelegram = async () => {
      try {
        const refreshed = await trackSheetsTicket(SHEETS_API_URL, { requestKey: requestKey.current });
        if (cancelled) return;
        setTicket(current => ({ ...current, ...refreshed, machine, department: current.department }));
        if (refreshed.telegramLinked === true) {
          setTelegramRemembered(true);
          return;
        }
      } catch {
        // The ticket is already saved. Keep checking while Apps Script processes
        // the Telegram Start command instead of replacing the receipt with an error.
      }
      if (!cancelled) timer = window.setTimeout(refreshTelegram, 3000);
    };
    timer = window.setTimeout(refreshTelegram, 1500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [ticket?.ticketNumber, ticket?.telegramLinked, machine]);

  const addFiles = incoming => {
    const incomingFiles = Array.from(incoming);
    const knownFiles = new Set(files.map(file => `${file.name}:${file.size}:${file.lastModified}`));
    const uniqueFiles = incomingFiles.filter(file => !knownFiles.has(`${file.name}:${file.size}:${file.lastModified}`));

    if (incomingFiles.length > 0 && uniqueFiles.length === 0) {
      showNotice('That file is already attached. Choose a different file or remove the existing copy first.');
      return;
    }

    const nextFiles = [...files, ...uniqueFiles];
    try {
      validateFileSelection(nextFiles, machine);
      if (SHEETS_API_URL) validateSheetsFiles(nextFiles, machine);
      setFiles(nextFiles);
      setNotice({
        text: uniqueFiles.length < incomingFiles.length ? 'Duplicate files were skipped.' : '',
        error: false,
      });
      setCanRetry(false);
    } catch (error) {
      showNotice(error.message);
    }
  };

  const upload = data => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl('/api/tickets'));
    xhr.withCredentials = true;
    xhr.setRequestHeader('idempotency-key', requestKey.current);
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) setProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () => reject(new Error('The connection was interrupted. Retrying will keep the same ticket number.'));
    xhr.onload = () => {
      let response;
      try { response = JSON.parse(xhr.responseText); }
      catch { reject(new Error('The workshop could not confirm the ticket. Please try again.')); return; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(response);
      else reject(new Error(response.error || 'The ticket could not be submitted.'));
    };
    xhr.send(data);
  });

  const submit = async event => {
    event.preventDefault();
    if (submitting || !formRef.current.reportValidity()) return;
    if (files.length === 0) {
      showNotice('Add at least one artwork file before submitting a ticket.');
      return;
    }
    if (staticPreview) {
      showNotice('The hosted ticket service is not connected. Use the local workshop site to submit this request.');
      return;
    }
    if (!SHEETS_API_URL) {
      showNotice('Telegram is required. Submit this request from the live Google-connected workshop site.');
      return;
    }
    const data = new FormData(formRef.current);
    data.delete('files');
    setSubmitting(true);
    setCanRetry(false);
    setProgress(0);
    setNotice({ text: 'Uploading files and reserving your ticket number.', error: false });
    try {
      let submittedTicket;
      if (SHEETS_API_URL) {
        const details = { phone: '', smsConsent: false, ...Object.fromEntries(data.entries()) };
        submittedTicket = await createSheetsTicket(SHEETS_API_URL, {
          ...details,
          requestKey: requestKey.current,
          startedAt: startedAt.current,
          website: '',
          telegramDeviceKey: telegramDeviceKey(),
        }, files, setProgress);
        submittedTicket = { ...submittedTicket, machine, department: details.department };
      } else {
        files.forEach(file => data.append('files', file));
        const response = await upload(data);
        submittedTicket = response.ticket;
      }
      setTicket(submittedTicket);
      onTicket(submittedTicket);
      setNotice({ text: '', error: false });
      window.setTimeout(() => document.getElementById('ticket-receipt')?.focus(), 0);
    } catch (error) {
      showNotice(error.message);
      setCanRetry(true);
    } finally {
      setSubmitting(false);
      setProgress(0);
    }
  };

  const startAnother = () => {
    requestKey.current = createRequestKey();
    startedAt.current = Date.now();
    setFiles([]);
    setTicket(null);
    setTelegramRemembered(Boolean(readTelegramDeviceKey()));
    setNotice({ text: '', error: false });
    setCanRetry(false);
    onChangeMachine(null);
    focusSection('ticket-question');
  };

  if (ticket) {
    return <TicketReceipt ticket={ticket} onStartAnother={startAnother} />;
  }

  return (
    <section className="form-section" aria-labelledby="form-title">
      <div className="form-heading">
        <button className="change-machine" type="button" onClick={() => { onChangeMachine(null); focusSection('ticket-question'); }}><ArrowLeft aria-hidden="true" /> Change request type</button>
        <span className="selected-machine">{machine === 'printer' ? <Printer aria-hidden="true" /> : <Scissors aria-hidden="true" />}{MACHINES[machine]}</span>
        <h2 id="form-title" tabIndex="-1">{MACHINES[machine]} request</h2>
        <p>Complete the fields below. Send one ticket for each item or design.</p>
      </div>

      <form ref={formRef} onSubmit={submit} aria-busy={submitting}>
        <input type="hidden" name="machine" value={machine} />

        <fieldset className="form-card">
          <legend>About your request</legend>
          <div className="field-grid">
            <label>Name <span>Required</span><input name="customerName" autoComplete="name" required maxLength="100" placeholder="Your name" /></label>
            <label>Department <span>Required</span><input name="department" required maxLength="100" placeholder="Decorations, Events, Youth" /></label>
            <label className="field-full">What is this for? <span>Required</span><textarea name="purpose" required maxLength="2000" rows="4" placeholder="Tell us about the event or project." /></label>
          </div>
        </fieldset>

        <fieldset className="form-card">
          <legend>Job details</legend>
          <div className={`field-grid details-grid details-grid-${machine}`}>
            {machine === 'foam' && <label>Foam thickness <span>Required</span><select name="thickness" required defaultValue=""><option value="" disabled>Choose thickness</option><option value="1">1 inch</option><option value="2">2 inches</option></select></label>}
            <label>Quantity <span>Required</span><input name="quantity" type="number" min="1" max="10000" step="1" defaultValue="1" required /></label>
            <label>Width in inches <span>Optional</span><input name="width" type="number" min="0.01" max={machine === 'printer' ? '24' : '10000'} step="any" placeholder={machine === 'printer' ? '24' : '20'} /></label>
            <label>Length in inches <span>Optional</span><input name="length" type="number" min="0.01" max="100000" step="any" placeholder="36" /></label>
          </div>
          <p className="field-help">{machine === 'printer' ? 'If known, add the finished size. Maximum print width: 24 inches. Staff will review the artwork and choose the paper.' : 'Add the finished size if known. Attach an SVG or DXF cut layout for staff to review.'}</p>

          <label className="upload-label">Artwork files <span>Required</span></label>
          <div className="dropzone" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); addFiles(event.dataTransfer.files); }}>
            <UploadSimple size={30} weight="duotone" aria-hidden="true" />
            <strong>Choose files or drop them here</strong>
            <small>{machine === 'printer' ? 'Any file type' : 'SVG or DXF (10 MB per vector file)'} · up to 200 MB total</small>
            <input type="file" name="files" accept={machine === 'foam' ? '.svg,.dxf' : undefined} multiple required={files.length === 0} onChange={event => { addFiles(event.target.files); event.target.value = ''; }} aria-label="Upload artwork files" />
          </div>

          {files.length > 0 && (
            <ul className="file-list">
              {files.map((file, index) => (
                <li key={`${file.name}-${file.lastModified}-${index}`}><FileArrowUp aria-hidden="true" /><span><strong>{file.name}</strong><small>{(file.size / 1024 / 1024).toFixed(2)} MB</small></span><button type="button" onClick={() => setFiles(current => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remove ${file.name}`}><X aria-hidden="true" /></button></li>
              ))}
            </ul>
          )}

          <details className="instructions">
            <summary>Add more details <span>Optional</span></summary>
            <label>Details<textarea name="notes" rows="3" maxLength="3950" placeholder="Finishing, placement, color, or anything else the workshop should know." /></label>
          </details>
        </fieldset>

        <fieldset className="form-card telegram-form-card">
          <legend>Telegram <span>Required</span></legend>
          <div className="telegram-form-choice selected">
            <span className="telegram-form-icon"><TelegramLogo size={27} weight="fill" aria-hidden="true" /></span>
            <span className="telegram-form-copy"><strong>Telegram is required for every ticket</strong><span>Your ticket goes to staff as soon as you submit it. Then open the secure Telegram link and press Start for status updates and to confirm pickup.</span></span>
            <span className="telegram-form-state">Required</span>
          </div>
          {telegramRemembered && <p className="telegram-form-remembered">This browser has a linked Telegram account, so the ticket may connect automatically. On a shared computer, <button type="button" onClick={() => { forgetTelegramDevice(); setTelegramRemembered(false); }}>use a different Telegram account</button>.</p>}
        </fieldset>

        <div className="submit-area">
          <p>A karyakar reviews each request before it enters the queue. Timing depends on staff and material availability.</p>
          <button className="button button-primary submit-button" type="submit" disabled={submitting}>{submitting ? 'Submitting ticket' : canRetry ? 'Try again' : 'Submit and link Telegram'} <ArrowRight weight="bold" aria-hidden="true" /></button>
        </div>
        {submitting && <progress max="100" value={progress} aria-label={`Upload progress: ${progress}%`} />}
        {notice.text && <p ref={noticeRef} id="ticket-form-notice" className={notice.error ? 'notice error' : 'notice'} role={notice.error ? 'alert' : 'status'} tabIndex="-1">{notice.text}</p>}
      </form>
    </section>
  );
}

function App() {
  const [machine, setMachine] = useState(null);
  const [recentTicket, setRecentTicket] = useState(null);

  const chooseMachine = value => {
    setMachine(value);
    if (value) focusSection('form-title');
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">Skip to ticket request</a>
      <Header />
      {staticPreview && <div className="deployment-banner" role="status"><strong>Ticket service not connected</strong><span>Use the local workshop address to submit a live request.</span></div>}
      <main id="main" tabIndex="-1">
        <MachineChoice value={machine} onChange={chooseMachine} />
        {machine && <div id="ticket-form"><TicketForm machine={machine} onChangeMachine={chooseMachine} onTicket={setRecentTicket} /></div>}
        <QueueBoard apiBase={API_BASE_URL} sheetsUrl={SHEETS_API_URL} preview={staticPreview} recentTicket={recentTicket} />
      </main>
      <footer><strong>Mandir Workshop Tickets</strong><span>Poster printing and foam cutting requests in one place.</span></footer>
    </div>
  );
}

export default App;
