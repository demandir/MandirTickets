import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import './WorkshopApp.css';

type Machine = 'printer' | 'foam';
type Status = 'pending-review' | 'declined' | 'queued' | 'in-progress' | 'ready' | 'collected' | 'cancelled' | 'archived';
type Usage = { requestKey: string; used: number; waste: number; material: string; unit: string; operator: string; note: string; at: string };
type TelegramDelivery = { id: string; audience: 'requester' | 'staff'; status: string; state: string; updatedAt: string; detail?: string };
type Ticket = { id: string; ticketNumber: string; sequence: number; machine: Machine; status: Status; revision: number; customerName: string; department: string; purpose: string; phone: string; reason?: string; telegram?: { linked: boolean; deliveries: TelegramDelivery[] }; notes: string; neededBy: string; quantity: number; width: number; length: number; thickness: number; paperType: string; createdAt: string; files: { originalName: string; storedName?: string; url?: string }[]; usage?: Usage[]; history?: { status: Status; at: string; operator?:string; reason?:string; changes?:{field:string;before:unknown;after:unknown}[] }[] };
const API = (process.env.REACT_APP_WORKSHOP_API_URL || '').replace(/\/$/, '');
const REQUEST_SITE = process.env.REACT_APP_REQUEST_SITE_URL || '/';
const STAFF_HOME = `${process.env.PUBLIC_URL || '/staff'}/`.replace(/\/+$/, '/');
const STATIC_PAGES_WITHOUT_API = window.location.hostname.endsWith('.github.io') && !API;
const LABEL: Record<Status, string> = { 'pending-review':'Awaiting admin review', declined:'Declined', queued: 'Waiting', 'in-progress': 'In progress', ready: 'Ready for pickup', collected: 'Closed · picked up', cancelled: 'Cancelled', archived: 'Archived' };
const FIFO = (a: Ticket, b: Ticket) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.sequence - b.sequence || a.id.localeCompare(b.id);
class RequestError extends Error { constructor(message: string, public status: number) { super(message); } }
async function request(path: string, options: RequestInit = {}) {
  if (STATIC_PAGES_WITHOUT_API) throw new RequestError('The staff page is online, but its private workshop service has not been connected yet.', 503);
  const response = await fetch(`${API}${path}`, { ...options, credentials: 'include', headers: { 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(30000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new RequestError(data.error || 'The workshop did not confirm this action. Refresh and retry.', response.status);
  return data;
}
const date = (value: string) => new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const amount = (n: number) => Number(n.toFixed(3)).toLocaleString();
const sizeLabel = (ticket: Pick<Ticket, 'width' | 'length'>) => ticket.width > 0 && ticket.length > 0
  ? `${ticket.width} × ${ticket.length} in`
  : 'Size not provided';

export default function WorkshopApp() {
  const [role, setRole] = useState('staff'), [reviewTickets, setReviewTickets] = useState<Ticket[]>([]);
  const [signedIn, setSignedIn] = useState(false), [checking, setChecking] = useState(true);
  const [tickets, setTickets] = useState<Ticket[]>([]), [source, setSource] = useState(''), [updated, setUpdated] = useState('');
  const [error, setError] = useState(''), [stale, setStale] = useState(true), [busy, setBusy] = useState(false);
  const [machine, setMachine] = useState<Machine>('printer'), [view, setView] = useState('queue'), [filter, setFilter] = useState('active');
  const [search, setSearch] = useState(''), [selected, setSelected] = useState(''), [usageJob, setUsageJob] = useState<string | null>(null);
  const [operator, setOperator] = useState(() => sessionStorage.getItem('workshop.operator') || '');
  const loading = useRef(false), mutation = useRef(false), epoch = useRef(0);
  const refresh = useCallback(async () => {
    if (loading.current || mutation.current) return;
    loading.current = true; const generation = epoch.current;
    try {
      const data = await request('/api/tickets');
      if (generation !== epoch.current) return;
      if (!Array.isArray(data.tickets)) throw new Error('Unexpected ticket response.');
      if (data.role === 'admin') { const review = await request('/api/admin/requests'); if (generation !== epoch.current) return; setReviewTickets(review.tickets); } else setReviewTickets([]);
      setRole(data.role || 'staff'); setTickets(data.tickets); setSource(data.source); setUpdated(data.updatedAt); setSignedIn(true); setStale(false); setError('');
    } catch (e) {
      if (generation !== epoch.current) return;
      if (e instanceof RequestError && e.status === 401) { setSignedIn(false); setTickets([]); }
      else setError(e instanceof Error ? e.message : 'Unable to load the workshop.');
      setStale(true);
    } finally { loading.current = false; setChecking(false); }
  }, []);
  useEffect(() => { refresh(); const timer = setInterval(refresh, 30000); const visible = () => { if (!document.hidden) refresh(); }; document.addEventListener('visibilitychange', visible); return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible); }; }, [refresh]);
  useEffect(() => {
    if (!selected && !usageJob) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
    const dialog = dialogs[dialogs.length - 1];
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled)') || []);
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { if (usageJob) setUsageJob(null); else setSelected(''); }
      if (event.key === 'Tab') {
        const controls = focusable(), first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; previous?.focus(); };
  }, [selected, usageJob]);
  async function mutate(path: string, method: string, body: object) {
    if (mutation.current || stale) return false;
    mutation.current = true; epoch.current++; setBusy(true); setError('');
    try {
      const data = await request(path, { method, body: JSON.stringify(body) });
      setTickets(prev => [...prev.filter(t => t.id !== data.ticket.id), ...(['pending-review','declined'].includes(data.ticket.status) ? [] : [data.ticket])]);
      setReviewTickets(prev => prev.map(t => t.id === data.ticket.id ? data.ticket : t));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The change was not confirmed.'); setStale(true);
      if (e instanceof RequestError && e.status === 401) { setSignedIn(false); setTickets([]); }
      return false;
    } finally { mutation.current = false; setBusy(false); }
  }
  async function change(ticket: Ticket, status: Status) {
    const reason = status === 'cancelled' ? window.prompt(`Why is ${ticket.ticketNumber} being cancelled?`)?.trim() : '';
    if (status === 'cancelled' && !reason) return false;
    return mutate(`/api/tickets/${ticket.id}`, 'PATCH', { status, reason, operator, expectedRevision: ticket.revision });
  }
  async function archive(ticket: Ticket) {
    if (!window.confirm(`Archive ${ticket.ticketNumber}? It will move out of History and remain available under Archive.`)) return;
    if (await change(ticket, 'archived')) setSelected('');
  }
  async function logout() {
    try { await request('/api/session', { method: 'DELETE' }); epoch.current++; setSignedIn(false); setTickets([]); setReviewTickets([]); setRole('staff'); setView('queue'); setSelected(''); setUsageJob(null); setStale(true); }
    catch { setError('Sign-out failed. Please retry.'); }
  }
  async function exportUsage() {
    try {
      const response = await fetch(`${API}/api/usage/export`, { credentials: 'include', signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error('Export failed. Sign in again or refresh.');
      const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = 'mandir-material-usage.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e instanceof Error ? e.message : 'Export failed.'); }
  }
  if (checking) return <main className="workshop-login"><p role="status">Connecting to the workshop…</p></main>;
  if (!signedIn) return <Login error={error} onLogin={async (username, password, name) => { const session = await request('/api/session', { method: 'POST', body: JSON.stringify({ username, password }) }); setView(session.role === 'admin' ? 'review' : 'queue'); setOperator(name); sessionStorage.setItem('workshop.operator', name); await refresh(); }} />;
  const jobs = tickets.filter(t => t.machine === machine).sort(FIFO);
  const active = jobs.filter(t => t.status === 'queued' || t.status === 'in-progress');

  const visible = jobs.filter(t => filter === 'active' ? ['queued', 'in-progress'].includes(t.status) : filter === 'ready' ? t.status === 'ready' : filter === 'closed' ? ['collected', 'cancelled'].includes(t.status) : filter === 'archive' ? t.status === 'archived' : t.status !== 'archived').filter(t => [t.ticketNumber, t.customerName, t.department, t.purpose].some(v => v.toLowerCase().includes(search.toLowerCase())));
  const detail = (view === 'review' ? reviewTickets : tickets).find(t => t.id === selected);
  const usageTicket = tickets.find(t => t.id === usageJob);
  return <div className="workshop">
    <aside className="workshop-nav"><a className="workshop-brand" href={STAFF_HOME}><span>M</span><div>DE Mandir<small>Workshop desk</small></div></a><p className="nav-label">WORKSPACE · {role === 'admin' ? 'ADMIN' : 'STAFF'}</p>{role === 'admin' && <button className={view === 'review' ? 'selected' : ''} onClick={() => {setView('review');setSelected('');}}>✓ &nbsp; Admin review ({reviewTickets.filter(t=>t.status==='pending-review').length})</button>}<button className={view === 'queue' ? 'selected' : ''} onClick={() => {setView('queue');setSelected('');}}>▤ &nbsp; Work queue</button><button className={view === 'materials' ? 'selected' : ''} onClick={() => setView('materials')}>▥ &nbsp; Material usage</button><div className="nav-bottom"><p>One shared queue.<br/>Every request accounted for.</p><a href={REQUEST_SITE} target="_blank" rel="noreferrer">Open request site ↗</a><button onClick={logout}>Sign out</button></div></aside>
    <main className="workshop-main">
      <header className="workshop-heading"><div><p className="workshop-eyebrow">DELAWARE MANDIR / WORKSHOP</p><h1>{view === 'review' ? 'Check every detail. Then approve.' : view === 'queue' ? 'Make room for every request.' : 'Know what the workshop uses.'}</h1><p>{view === 'review' ? 'Requests stay here until an admin approves them for production.' : view === 'queue' ? 'Two machines. One place to keep the work moving.' : 'Actual material use and waste, saved with each ticket.'}</p></div><button className="ws-button" onClick={refresh} disabled={busy}>↻ Refresh</button></header>
      <div className={`connection ${stale ? 'offline' : ''}`} role="status"><span className="connection-dot" />{stale ? 'Updates unavailable · displayed tickets may be out of date' : source === 'google' ? 'Connected to the live Google Sheet' : 'Local workshop database'}{updated && <span>Updated {date(updated)} · every 30 seconds</span>}</div>
      {error && <div className="workshop-error" role="alert">{error} <button onClick={refresh}>Refresh tickets</button></div>}
      <div className="machine-tabs" role="group" aria-label="Workshop machine">{(['printer', 'foam'] as Machine[]).map(m => <button key={m} aria-pressed={machine === m} onClick={() => { setMachine(m); setSelected(''); }}><span>{m === 'printer' ? '▧' : '✂'}</span><div><strong>{m === 'printer' ? 'Poster printing' : 'Foam cutting'}</strong><small>{m === 'printer' ? 'HP DesignJet T210 · 24-inch' : '2525 hot-wire machine'}</small></div><b>{(view === 'review' ? reviewTickets : tickets).filter(t => t.machine === m && (view === 'review' ? t.status === 'pending-review' : ['queued', 'in-progress'].includes(t.status))).length}</b></button>)}</div>
      {view === 'review' && role === 'admin' ? <section className="workshop-panel"><div className="workshop-panel-head"><div><h2>Admin review inbox</h2><p>Open artwork, check dimensions, and edit request details.</p></div></div>{reviewTickets.filter(t=>t.machine===machine && ['pending-review','declined'].includes(t.status)).sort(FIFO).map(t=><button className="review-row" key={t.id} onClick={()=>setSelected(t.id)}><strong>{t.ticketNumber}</strong><span>{t.purpose}<small>{t.customerName} · {t.department}</small></span><span className={`ws-status status-${t.status}`}>{LABEL[t.status]}</span><span>Review →</span></button>)}{!reviewTickets.some(t=>t.machine===machine && t.status==='pending-review') && <div className="workshop-empty">No requests awaiting review for this machine.</div>}</section> : view === 'materials' ? <Materials tickets={jobs} onExport={exportUsage} /> : <>
      <div className="workshop-metrics">{[['Waiting', jobs.filter(t => t.status === 'queued').length, 'In submission order'], ['In progress', jobs.filter(t => t.status === 'in-progress').length, 'On this machine'], ['Ready for pickup', jobs.filter(t => t.status === 'ready').length, 'Work completed'], ['Closed / picked up', jobs.filter(t => t.status === 'collected').length, 'Not yet archived']].map(([label, value, sub]) => <div key={label}><small>{label}</small><strong>{value}</strong><span>{sub}</span></div>)}</div>
      <div className="fifo-note"><b>OLDEST FIRST, FLEXIBLE IN PRACTICE</b><span>Approved jobs are listed in submission order. Start any approved job when it makes sense for the loaded material or machine setup.</span></div>
      <section className="workshop-panel"><div className="workshop-panel-head"><div><h2>{machine === 'printer' ? 'Printing' : 'Foam cutting'} requests</h2><p>{active.length} active jobs · ordered by submission</p></div><input aria-label="Search tickets" placeholder="Search ticket, name, department…" value={search} onChange={e => setSearch(e.target.value)} /></div><div className="workshop-filters" role="group" aria-label="Ticket status">{[['active', 'Queue'], ['ready', 'Ready for pickup'], ['closed', 'History'], ['all', 'All tickets'], ['archive', `Archive (${jobs.filter(t => t.status === 'archived').length})`]].map(([key, label]) => <button key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}</div>
      <div className="workshop-table-scroll"><table className="workshop-table"><thead><tr><th>Position / ticket</th><th>Request</th><th>Size & quantity</th><th>Submitted</th><th>Status</th><th>Next step</th></tr></thead><tbody>{visible.map(t => <tr key={t.id} className={t.status === 'in-progress' ? 'working-row' : ''}><td><button className="ticket-link" onClick={() => setSelected(t.id)}>{active.findIndex(a => a.id === t.id) >= 0 && <span className="position-tag">{active.findIndex(a => a.id === t.id) + 1}</span>}{t.ticketNumber}</button></td><td><button className="purpose-link" onClick={() => setSelected(t.id)}>{t.purpose}</button><small>{t.customerName} · {t.department}</small>{t.status === 'ready' && t.files.length > 0 && <small>{t.files.length === 1 ? 'File: ' : 'Files: '}{t.files.map((f, i) => f.originalName || `Artwork ${i + 1}`).join(', ')}</small>}</td><td>{sizeLabel(t)}<small>{t.machine === 'foam' ? `${t.thickness}″ foam · ` : ''}Qty {t.quantity}</small></td><td>{date(t.createdAt)}</td><td><span className={`ws-status status-${t.status}`}>{LABEL[t.status]}</span></td><td><button className="ws-button small" onClick={() => setSelected(t.id)}>{t.status === 'queued' ? 'Review & start →' : 'Open ticket →'}</button></td></tr>)}</tbody></table></div>
      {visible.length === 0 && <div className="workshop-empty"><strong>{search ? 'No matching requests' : 'You’re all caught up here.'}</strong><p>{search ? 'Try another ticket number, requester, or department.' : 'New requests appear here after admin approval.'}</p></div>}</section>
      </>}
      <footer className="workshop-footer">Queue and material tracking · Machine operation is performed by trained volunteers.</footer>
    </main>
    {detail && <div className="workshop-overlay" onClick={() => setSelected('')}><section className={`ticket-detail ${detail.status === 'pending-review' ? 'review-detail' : ''}`} role="dialog" aria-modal="true" aria-label={`Ticket ${detail.ticketNumber}`} onClick={e => e.stopPropagation()}><button className="detail-close" autoFocus onClick={() => setSelected('')}>Close ✕</button><p className="workshop-eyebrow">{detail.machine === 'printer' ? 'POSTER PRINTING' : 'FOAM CUTTING'}</p><h2>{detail.ticketNumber}</h2><span className={`ws-status status-${detail.status}`}>{LABEL[detail.status]}</span><h3>{detail.purpose}</h3><dl><dt>Requested by</dt><dd>{detail.customerName} · {detail.department}</dd><dt>Job</dt><dd>Qty {detail.quantity} · {sizeLabel(detail)}{detail.machine === 'foam' ? ` · ${detail.thickness}″ thick foam` : ''}</dd><dt>Notes</dt><dd>{detail.notes || 'No additional notes'}</dd></dl>
      <h3>Artwork files</h3>{detail.files.length === 0 ? <p>No file attached. Confirm the design with the requester before starting.</p> : detail.files.map((f, i) => <a className="artwork-link" key={i} href={f.url && /^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]+\/view$/.test(f.url) ? f.url : `${API}/api/tickets/${detail.id}/files/${encodeURIComponent(f.storedName || '')}`} target="_blank" rel="noreferrer">↗ {f.originalName || `Artwork ${i + 1}`}</a>)}
      <p className="detail-help">Download and check the artwork, dimensions, quantity, and machine setup. Starting a ticket marks it in progress; it does not send files to the machine.</p>
      {detail.reason && <p className="review-reason"><strong>Reason:</strong> {detail.reason}</p>}
      {role === 'admin' && detail.status === 'pending-review' && <ReviewForm key={`${detail.id}:${detail.revision}`} ticket={detail} operator={operator} busy={busy || stale} onSave={async values => { const saved = await mutate(`/api/admin/requests/${detail.id}/review`,'POST',{...values,expectedRevision:detail.revision}); if (saved) setSelected(''); }} />}
      <div className="detail-actions">{detail.status === 'queued' && <button className="ws-button primary" disabled={busy || stale} onClick={() => change(detail, 'in-progress')}>Start this job</button>}{['in-progress', 'ready'].includes(detail.status) && <button className="ws-button" disabled={busy || stale} onClick={() => setUsageJob(detail.id)}>Record material use</button>}{detail.status === 'in-progress' && <button className="ws-button primary" disabled={busy || stale || !detail.usage?.length} onClick={() => change(detail, 'ready')}>Mark ready for pickup</button>}{detail.status === 'ready' && <button className="ws-button primary" disabled={busy || stale} onClick={() => change(detail, 'collected')}>Mark picked up / close</button>}{['queued', 'in-progress', 'ready'].includes(detail.status) && <button className="ws-button danger" disabled={busy || stale} onClick={() => change(detail, 'cancelled')}>Cancel ticket</button>}{['collected', 'cancelled', 'declined'].includes(detail.status) && <button className="ws-button" disabled={busy || stale} onClick={() => archive(detail)}>Archive ticket</button>}</div>
      {detail.status === 'archived' && <p className="detail-help">This ticket is archived. Its files, material records, and status history are still retained.</p>}
      {detail.status === 'in-progress' && !detail.usage?.length && <p className="detail-help">Record actual material use before marking this job ready.</p>}
      <h3>Telegram notifications</h3><p>{detail.telegram?.linked ? 'Requester linked this required ticket connection to a private Telegram chat.' : 'Requester has not finished the required Telegram connection; staff can continue reviewing and working this ticket.'} Requesters receive ready and declined updates and can use /pickup to close a collected ticket. The private admin group receives new-ticket, ready, declined, and requester pickup updates.</p>{detail.telegram?.deliveries?.map(n=><div className="usage-entry" key={n.id}><strong>{n.audience === 'staff' ? 'Admin group' : 'Requester'} · {n.status} · {n.state}</strong>{n.detail && <p>{n.detail}</p>}<small>{date(n.updatedAt)}</small></div>)}
      <h3>Recorded materials</h3>{!detail.usage?.length && <p>No usage recorded yet.</p>}{detail.usage?.map(u => <div className="usage-entry" key={u.requestKey}><strong>{amount(u.used)} {u.unit} used + {amount(u.waste)} wasted</strong><p>{u.material} · {u.note}</p><small>{u.operator} · {date(u.at)}</small></div>)}
      <h3>Status history</h3><ul className="status-history"><li>Submitted · {date(detail.createdAt)}</li>{detail.history?.map((h, i) => <li key={i}>{h.status === 'queued' && h.operator ? 'Approved for staff queue' : LABEL[h.status]} · {date(h.at)}{h.operator && ` · ${h.operator}`}{h.reason && <p>{h.reason}</p>}{h.changes?.length ? <details><summary>{h.changes.length} reviewed changes</summary>{h.changes.map((c,j)=><p key={j}><strong>{c.field}:</strong> {JSON.stringify(c.before)} → {JSON.stringify(c.after)}</p>)}</details> : null}</li>)}</ul>
      {error && <p className="workshop-error" role="alert">{error} <button onClick={refresh}>Refresh</button></p>}
    </section></div>}
    {usageTicket && <UsageForm key={usageTicket.id} ticket={usageTicket} operator={operator} busy={busy || stale} error={error} onRefresh={refresh} onClose={() => setUsageJob(null)} onSave={async values => { const success = await mutate(`/api/tickets/${usageTicket.id}/usage`, 'POST', { ...values, expectedRevision: usageTicket.revision }); if (success) setUsageJob(null); }} />}
  </div>;
}

function Login({ error, onLogin }: { error: string; onLogin: (username: string, password: string, name: string) => Promise<void> }) {
  const [username,setUsername]=useState('');
  const [password, setPassword] = useState(''), [name, setName] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) { e.preventDefault(); setBusy(true); setNotice(''); try { await onLogin(username.trim(), password, name.trim()); } catch (e) { setNotice(e instanceof Error ? e.message : 'Sign-in failed.'); } finally { setBusy(false); } }
  return <main className="workshop-login"><form onSubmit={submit}><div className="login-mark">M</div><p className="workshop-eyebrow">DELAWARE MANDIR</p><h1>Welcome to the workshop.</h1><p>Sign in to manage printing, foam cutting, and materials.</p><label>Your name<input required maxLength={100} value={name} onChange={e => setName(e.target.value)} autoComplete="name" /></label><label>Username<input required value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username" /></label><label>Password<input required type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" /></label><button className="ws-button primary" disabled={busy}>{busy ? 'Connecting…' : 'Open workshop →'}</button>{(notice || error) && <p className="workshop-error" role="alert">{notice || error}</p>}<small>Staff access only · Requesters use the public ticket site.</small></form></main>;
}
function UsageForm({ ticket, operator, busy, error, onClose, onRefresh, onSave }: { ticket: Ticket; operator: string; busy: boolean; error: string; onClose: () => void; onRefresh: () => void; onSave: (v: object) => Promise<void> }) {
  const [used, setUsed] = useState(''), [waste, setWaste] = useState('0'), [name, setName] = useState(operator), [note, setNote] = useState('');
  const key = useRef(crypto.randomUUID());
  const unit = ticket.machine === 'printer' ? 'linear feet of roll' : 'square feet of foam';
  const hasEstimate = ticket.machine === 'printer' ? ticket.length > 0 : ticket.width > 0 && ticket.length > 0;
  const estimate = hasEstimate ? (ticket.machine === 'printer' ? ticket.length * ticket.quantity / 12 : ticket.width * ticket.length * ticket.quantity / 144) : 0;
  return <div className="workshop-overlay usage-overlay"><form className="usage-form" role="dialog" aria-modal="true" aria-label="Record material usage" onSubmit={e => { e.preventDefault(); onSave({ requestKey: key.current, used, waste, operator: name, note }); }}><button className="detail-close" type="button" onClick={onClose}>Close ✕</button><p className="workshop-eyebrow">{ticket.ticketNumber} / MATERIAL LOG</p><h2>Record what you used.</h2><p>{ticket.machine === 'printer' ? 'Poster printing' : `${ticket.thickness}″ foam`} · {unit}</p><p className="detail-help">{hasEstimate ? <>Design estimate: {amount(estimate)} {unit}. {ticket.machine === 'printer' ? 'Assumes one design along the roll for each copy; confirm the actual layout and roll feed.' : 'Based on finished rectangular dimensions; record the actual stock consumed and account for reusable offcuts separately.'}</> : 'Design estimate unavailable because no finished size was provided.'} Enter measured use below.</p><div className="usage-fields"><label>Used ({ticket.machine === 'printer' ? 'ft' : 'sq ft'})<input autoFocus required type="number" min="0" max="100000" step="0.001" value={used} onChange={e => setUsed(e.target.value)} /></label><label>Waste ({ticket.machine === 'printer' ? 'ft' : 'sq ft'})<input required type="number" min="0" max="100000" step="0.001" value={waste} onChange={e => setWaste(e.target.value)} /></label></div><label>Recorded by<input required maxLength={100} value={name} onChange={e => setName(e.target.value)} /></label><label>Usage note / waste reason<textarea required maxLength={500} placeholder="Initial run, setup trim, damaged piece, or reprint…" value={note} onChange={e => setNote(e.target.value)} /></label><p>Used + waste = total stock consumed. Saved entries are retained in the ticket history.</p>{error && <p className="workshop-error" role="alert">{error} <button type="button" onClick={onRefresh}>Refresh tickets</button></p>}<button className="ws-button primary" disabled={busy || Number(used) + Number(waste) <= 0}>Save material use</button></form></div>;
}
function Materials({ tickets, onExport }: { tickets: Ticket[]; onExport: () => void }) {
  const [from, setFrom] = useState(''), [to, setTo] = useState('');
  const rows = tickets.flatMap(t => (t.usage || []).map(u => ({ ...u, ticket: t.ticketNumber, department: t.department }))).filter(u => (!from || Date.parse(u.at) >= new Date(`${from}T00:00:00`).getTime()) && (!to || Date.parse(u.at) <= new Date(`${to}T23:59:59.999`).getTime())).sort((a,b) => b.at.localeCompare(a.at));
  const totals = new Map<string, { material: string; unit: string; used: number; waste: number }>();
  rows.forEach(u => { const key = `${u.material}:${u.unit}`; const v = totals.get(key) || { material: u.material, unit: u.unit, used: 0, waste: 0 }; v.used += u.used; v.waste += u.waste; totals.set(key, v); });
  return <section className="workshop-panel"><div className="workshop-panel-head"><div><h2>Material usage ledger</h2><p>Shared across staff devices. Foam totals are separated by thickness.</p></div><button className="ws-button" onClick={onExport}>Export all machines & dates ↓</button></div><div className="material-dates"><label>From<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><label>Through<input type="date" min={from} value={to} onChange={e => setTo(e.target.value)} /></label></div><div className="material-totals">{Array.from(totals.values()).map(v => <article key={v.material}><h3>{v.material}</h3><strong>{amount(v.used + v.waste)} <small>{v.unit}</small></strong><p>{amount(v.used)} used · {amount(v.waste)} waste</p></article>)}</div><div className="workshop-table-scroll"><table className="workshop-table"><thead><tr><th>Ticket</th><th>Material</th><th>Used</th><th>Waste</th><th>Recorded by</th><th>Note / date</th></tr></thead><tbody>{rows.map(u => <tr key={`${u.ticket}:${u.requestKey}`}><td>{u.ticket}<small>{u.department}</small></td><td>{u.material}<small>{u.unit}</small></td><td>{amount(u.used)}</td><td>{amount(u.waste)}</td><td>{u.operator}</td><td>{u.note}<small>{date(u.at)}</small></td></tr>)}</tbody></table></div>{rows.length === 0 && <div className="workshop-empty"><strong>No material usage recorded for this view.</strong><p>Start a job and record actual material use on its ticket.</p></div>}<p className="ledger-note">These are usage totals, not remaining stock or measured ink levels. Reusable offcuts should not be logged as waste.</p></section>;
}

function ReviewForm({ticket,operator,busy,onSave}:{ticket:Ticket;operator:string;busy:boolean;onSave:(values:object)=>Promise<void>}) {
  const [fields,setFields]=useState(ticket), [reason,setReason]=useState(''), [name,setName]=useState(operator), [checked,setChecked]=useState(false);
  const edit=(key:string,value:unknown)=>{setFields(prev=>({...prev,[key]:value}));setChecked(false);};
  const fileEdit=(index:number,key:string,value:string)=>edit('files',fields.files.map((f,i)=>i===index?{...f,[key]:value}:f));
  const textField=(key:'customerName'|'department',label:string,required:boolean,max:number)=><label>{label}<input required={required} maxLength={max} value={fields[key]} onChange={e=>edit(key,e.target.value)}/></label>;
  return <form className="review-form" onSubmit={async e=>{e.preventDefault();const decision=(e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') || 'save';if(decision==='approve'&&!checked)return;await onSave({fields,decision,reason,operator:name});}}>
    <h3>Admin review & corrections</h3><p>Review the actual artwork using the links above. File links open in Google Drive; private files need your Google account’s permission.</p>
    <div className="review-grid">
      <label>Request type<select value={fields.machine} onChange={e=>edit('machine',e.target.value)}><option value="printer">Poster printing</option><option value="foam">Foam cutting</option></select></label>
      {textField('customerName','Requester name',true,100)}{textField('department','Department',true,100)}
      <label className="review-wide">Purpose<textarea required maxLength={2000} value={fields.purpose} onChange={e=>edit('purpose',e.target.value)}/></label>
      {(['quantity','width','length'] as const).map(k=><label key={k}>{k==='quantity'?'Quantity':k==='width'?'Width (inches, optional)':'Length (inches, optional)'}<input required={k==='quantity'} type="number" min={k==='quantity'?1:.01} max={k==='quantity'?10000:k==='width'?(fields.machine==='printer'?24:10000):100000} step={k==='quantity'?1:'any'} value={k==='quantity'?fields[k]:(fields[k] || '')} onChange={e=>edit(k,e.target.value)}/></label>)}
      {fields.machine==='foam' && <label>Foam thickness (inches)<input required type="number" min="0.01" max="1000" step="any" value={fields.thickness || ''} onChange={e=>edit('thickness',e.target.value)}/></label>}
      <label className="review-wide">Notes<textarea maxLength={4000} value={fields.notes} onChange={e=>edit('notes',e.target.value)}/></label>
    </div>
    <h4>Artwork attachments</h4><p>Correct names, remove an attachment, or replace it with a Google Drive file link. Upload corrected artwork to the workshop Drive folder first.</p>
    {fields.files.map((f,i)=><div className="review-file" key={i}><label>File {i+1} name<input required maxLength={180} value={f.originalName} onChange={e=>fileEdit(i,'originalName',e.target.value)}/></label>{!f.storedName && <label>File {i+1} Google Drive link<input required type="url" placeholder="https://drive.google.com/file/d/…/view" value={f.url || ''} onChange={e=>fileEdit(i,'url',e.target.value)}/></label>}<button className="ws-button danger" type="button" onClick={()=>edit('files',fields.files.filter((_,j)=>j!==i))}>Remove file {i+1}</button></div>)}
    <button className="ws-button" type="button" disabled={fields.files.length>=10} onClick={()=>edit('files',[...fields.files,{originalName:'',url:''}])}>Add artwork link</button>
    <label>Reviewing admin<input required maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></label>
    <label>Reason / message to requester<textarea maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)} placeholder="Required when declining. Explain what needs to change."/></label>
    <label className="review-check"><input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)}/> I checked the artwork quality, provided dimensions, and quantity.</label>
    <div className="detail-actions"><button className="ws-button" type="submit" value="save" disabled={busy}>Save corrections</button><button className="ws-button primary" type="submit" value="approve" disabled={busy || !checked}>Approve for staff queue</button><button className="ws-button danger" type="submit" value="decline" disabled={busy || !reason.trim()}>Decline request</button></div>
  </form>;
}
