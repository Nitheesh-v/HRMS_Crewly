// ============================================================
// Documents — the employee cabinet.
//
// Laid out as a cabinet rather than a form: a header with the one action that
// matters, four counted tiles that describe the whole cabinet at a glance, an
// upload panel you can dismiss, category tabs with real counts, and the records
// themselves (list or grid).
//
// Every number on this page is derived from what the API returned — there is no
// storage quota and no encryption badge, because the app has neither; and no
// promise that documents can be signed, because signing is not built. What it does have is a gated download endpoint, so
// the badge says "Private" and the footer says how the bytes travel.
//
// Phase 14 · Phase 32.8 (private bytes) · Phase 35.1 (toasts)
// ============================================================
import { useEffect, useState } from 'react';
import {
  CloudUpload, Download, FileImage, FileSpreadsheet, FileText, FolderOpen,
  HardDrive, History, Hourglass, Inbox, LayoutGrid, List, PenLine, Search,
  Send, Upload, X,
} from 'lucide-react';
import Modal from '../../components/Modal.jsx';
import {
  getMyDocuments, getMyDocRequests, getDocCategories, getMyHrDocRequests,
  uploadMyDocument, fulfillDocRequest, downloadDocument,
  createHrDocRequest, cancelHrDocRequest,
} from '../../services/docsService.js';
import { notify } from '../../utils/notify.js';
import EmptyState from '../../components/common/EmptyState.jsx';

const FALLBACK_CATS = [
  { value: 'AADHAAR_ID', label: 'Aadhaar / ID' },
  { value: 'OFFER_LETTER', label: 'Offer Letter' },
  { value: 'JOINING_LETTER', label: 'Joining Letter' },
  { value: 'EXPERIENCE_LETTER', label: 'Experience Letter' },
  { value: 'SALARY_DOCUMENT', label: 'Salary Document' },
  { value: 'CERTIFICATE', label: 'Certificate' },
  { value: 'CONTRACT', label: 'Contract' },
  { value: 'OTHER', label: 'Other Document' },
];

const fmtSize = (n) => {
  if (!n) return '—';
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
};
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const DAY = 86400000;
const daysTo = (date) => (date ? Math.ceil((new Date(date) - Date.now()) / DAY) : null);
const bytes = (docs) => docs.reduce((sum, d) => sum + (Number(d.size) || 0), 0);

const REQ_CHIP = {
  PENDING: 'bg-crewly-accent/20 text-crewly-text',
  FULFILLED: 'bg-crewly-green/15 text-crewly-green',
  CANCELLED: 'bg-crewly-inset-strong text-crewly-dim',
};

const chip = (txt, cls) => (
  <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${cls}`}>{txt}</span>
);

const ExpiryBadge = ({ expiryDate }) => {
  if (!expiryDate) return null;
  const days = daysTo(expiryDate);
  if (days < 0) return chip(`Expired ${fmtDate(expiryDate)}`, 'bg-crewly-red/15 text-crewly-red');
  if (days <= 30) {
    return chip(
      <><Hourglass className="mr-1 inline h-3 w-3" />Expires in {days}d</>,
      'bg-crewly-orange/15 text-crewly-orange',
    );
  }
  return chip(`Exp ${fmtDate(expiryDate)}`, 'bg-crewly-inset-strong text-crewly-dim');
};

// One icon per file family, so a list of eight documents is scannable without
// reading eight names. The glyph is chosen as an element rather than held in a
// component variable, so nothing is re-declared on every render.
const fileGlyph = (name = '') => {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return <FileImage className="h-5 w-5" />;
  if (['xls', 'xlsx', 'csv'].includes(ext)) return <FileSpreadsheet className="h-5 w-5" />;
  return <FileText className="h-5 w-5" />;
};

const FileTile = ({ name, size = 'h-10 w-10' }) => (
  <span className={`${size} flex shrink-0 items-center justify-center rounded-lg bg-crewly-inset text-crewly-dim`}>
    {fileGlyph(name)}
  </span>
);

// No `justify-between` here on purpose: the app's phone rules rewrite any
// `.flex.justify-between` to wrap, which pushed the little icon onto its own
// line. The text takes the space instead and the icon stays pinned right.
const Stat = ({ icon: Icon, label, value, sub }) => (
  <div className="flex items-start gap-3 p-4 sm:p-5">
    <div className="min-w-0 flex-1">
      <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">{label}</p>
      <p className="mt-1.5 text-xl font-bold leading-tight sm:text-2xl">{value}</p>
      {sub ? <p className="mt-1 text-xs leading-snug text-crewly-dim">{sub}</p> : null}
    </div>
    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-crewly-dim" aria-hidden="true" />
  </div>
);

// Phase 32.8 — documents are PRIVATE: bytes flow through the gated
// GET /documents/:id/file endpoint with the caller's authentication.
const download = async (d) => {
  try {
    // 35.1 — the page's own sentence beats the raw status code for a blob.
    const res = await downloadDocument(d._id, { skipErrorToast: true });
    const blob = res?.data ?? res;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob instanceof Blob ? blob : new Blob([blob]));
    a.download = d.name || 'document';
    a.click();
    URL.revokeObjectURL(a.href);
  } catch {
    notify.error('This file could not be downloaded. You may not have access to it.');
  }
};

export default function MyDocumentsPage() {
  const [docs, setDocs] = useState([]);
  const [requests, setRequests] = useState([]);
  // The employee's own asks to HR ("please issue my experience letter").
  const [askHr, setAskHr] = useState([]);
  const [askOpen, setAskOpen] = useState(false);
  const [askForm, setAskForm] = useState({ category: 'EXPERIENCE_LETTER', note: '', neededBy: '' });
  const [askBusy, setAskBusy] = useState(false);
  const [cats, setCats] = useState(FALLBACK_CATS);
  const [busy, setBusy] = useState(false);
  const [cat, setCat] = useState('OTHER');
  const [docName, setDocName] = useState('');
  const [file, setFile] = useState(null);
  const [dragging, setDragging] = useState(false);

  // Cabinet chrome
  const [uploadOpen, setUploadOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [tab, setTab] = useState('ALL');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('ALL');
  const [sort, setSort] = useState('NEWEST');
  const [view, setView] = useState('list');

  const labelOf = (v) => cats.find((c) => c.value === v)?.label || (v === 'OTHER' ? 'Other Document' : v || 'Other Document');

  const load = async () => {
    try {
      const [d, r, c, mine] = await Promise.all([
        getMyDocuments(), getMyDocRequests(), getDocCategories(), getMyHrDocRequests(),
      ]);
      setDocs(d);
      setRequests(r);
      setAskHr(mine);
      if (c.length) setCats(c);
    } catch {
      notify.error('Could not load documents — refresh to retry.');
    }
  };
  useEffect(() => { load(); }, []);

  /* 35.1 — feedback is a toast now; the signature is unchanged. */
  const flash = (ok, text) => {
    const body = typeof text === 'string' && text ? text : '';

    if (!body) return;

    if (ok) notify.success(body);
    else notify.error(body);
  };

  const pickFile = (next) => {
    if (!next) return;
    setFile(next);
    if (!docName.trim()) setDocName(next.name.replace(/\.[^.]+$/, ''));
    setUploadOpen(true);
  };

  const doSelfUpload = async () => {
    if (!file) return flash(false, 'Pick a file first');
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('document', file);
      fd.append('name', docName.trim() || file.name);
      fd.append('category', cat);
      await uploadMyDocument(fd);
      setDocName(''); setCat('OTHER'); setFile(null);
      flash(true, 'Uploaded');
      await load();
    } catch (e) {
      flash(false, e?.response?.data?.message || 'Upload failed');
    } finally { setBusy(false); }
  };

  /* ── the other direction: ask HR to issue something ──────────────────── */
  const askHrForDocument = async () => {
    setAskBusy(true);
    try {
      await createHrDocRequest({
        category: askForm.category,
        note: askForm.note.trim(),
        dueDate: askForm.neededBy || null,
      });
      setAskOpen(false);
      setAskForm({ category: 'EXPERIENCE_LETTER', note: '', neededBy: '' });
      flash(true, 'Request sent to HR');
      await load();
    } catch (e) {
      flash(false, e?.response?.data?.message || 'Could not send the request');
    } finally { setAskBusy(false); }
  };

  const withdrawAsk = async (request) => {
    try {
      await cancelHrDocRequest(request._id);
      flash(true, 'Request withdrawn');
      await load();
    } catch (e) {
      flash(false, e?.response?.data?.message || 'Could not withdraw the request');
    }
  };

  const doFulfill = async (request, chosen) => {
    if (!chosen) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('document', chosen);
      fd.append('name', chosen.name);
      await fulfillDocRequest(request._id, fd);
      flash(true, `"${chosen.name}" sent to HR`);
      await load();
    } catch (e) {
      flash(false, e?.response?.data?.message || 'Upload failed');
    } finally { setBusy(false); }
  };

  const pending = requests.filter((r) => r.status === 'PENDING');
  const history = requests.filter((r) => r.status !== 'PENDING');

  // Category tabs carry real counts: a folder only exists if something is in it.
  const withDoc = cats
    .map((c) => ({ ...c, count: docs.filter((d) => (d.category || 'OTHER') === c.value).length }))
    .filter((c) => c.count > 0);
  const stray = docs.filter((d) => !cats.some((c) => c.value === (d.category || 'OTHER')));
  if (stray.length) withDoc.push({ value: '_misc', label: 'Other', count: stray.length });
  const tabs = [{ value: 'ALL', label: 'All documents', count: docs.length }, ...withDoc];

  const inTab = (d) => tab === 'ALL'
    || (tab === '_misc' ? !cats.some((c) => c.value === (d.category || 'OTHER')) : (d.category || 'OTHER') === tab);

  const matchesStatus = (d) => {
    if (status === 'ALL') return true;
    const days = daysTo(d.expiryDate);
    if (status === 'EXPIRING') return days !== null && days >= 0 && days <= 30;
    if (status === 'EXPIRED') return days !== null && days < 0;
    if (status === 'NO_EXPIRY') return days === null;
    return true;
  };

  const shown = docs
    .filter(inTab)
    .filter((d) => {
      const needle = query.trim().toLowerCase();
      if (!needle) return true;
      return `${d.name} ${labelOf(d.category)}`.toLowerCase().includes(needle);
    })
    .filter(matchesStatus)
    .sort((a, b) => {
      if (sort === 'NAME') return String(a.name).localeCompare(String(b.name));
      if (sort === 'SIZE') return (Number(b.size) || 0) - (Number(a.size) || 0);
      const [x, y] = [new Date(a.createdAt || 0), new Date(b.createdAt || 0)];
      return sort === 'OLDEST' ? x - y : y - x;
    });

  const used = bytes(docs);
  const folders = withDoc.length;
  const nextDue = pending
    .map((r) => r.dueDate)
    .filter(Boolean)
    .sort((a, b) => new Date(a) - new Date(b))[0];

  return (
    <div className="space-y-5">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-crewly-green/15 text-crewly-green">
            <FileText className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-bold sm:text-2xl">Document Management</h1>
            <p className="mt-1 max-w-xl text-sm leading-relaxed text-crewly-dim">
              Everything in your cabinet: the policies, letters and contracts HR has issued to you,
              what HR is still waiting on, and anything you have uploaded yourself.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
          <button type="button" className="btn-ghost w-full justify-center gap-2 text-sm sm:w-auto" onClick={() => setAskOpen(true)}>
            <Send className="h-4 w-4" />
            Request from HR
          </button>
          <button type="button" className="btn-ghost w-full justify-center gap-2 text-sm sm:w-auto" onClick={() => setHistoryOpen(true)}>
            <History className="h-4 w-4" />
            Request history
            {requests.length + askHr.length ? <span className="text-crewly-dim">({requests.length + askHr.length})</span> : null}
          </button>
          <button
            type="button"
            className="btn-primary w-full justify-center gap-2 text-sm sm:w-auto"
            onClick={() => setUploadOpen((open) => !open)}
          >
            <Upload className="h-4 w-4" />
            Upload document
          </button>
        </div>
      </div>

      {/* ── counted tiles ──────────────────────────────────────────────── */}
      {/* `sm:grid-cols-2` is deliberate even though the base is already 2: the
          mobile helper in style.css collapses any grid-cols-2 without a
          breakpoint twin to one column, and 2×2 is what fits a phone here. */}
      <div className="card grid grid-cols-2 gap-px overflow-hidden border-crewly-border bg-crewly-border p-0 sm:grid-cols-2 xl:grid-cols-4">
        <div className="bg-crewly-card">
          <Stat
            icon={FileText}
            label="Available files"
            value={docs.length}
            sub={docs.length ? `Across ${folders} folder${folders === 1 ? '' : 's'}` : 'Nothing filed yet'}
          />
        </div>
        <div className="bg-crewly-card">
          <Stat
            icon={PenLine}
            label="Action required"
            value={pending.length}
            sub={pending.length
              ? `${nextDue ? `Earliest due ${fmtDate(nextDue)}` : 'Waiting on your upload'}`
              : 'Nothing waiting on you'}
          />
        </div>
        <div className="bg-crewly-card">
          <Stat
            icon={HardDrive}
            label="Storage used"
            value={fmtSize(used)}
            sub={`${docs.length} file${docs.length === 1 ? '' : 's'} · your cabinet only`}
          />
        </div>
        <div className="bg-crewly-card">
          <Stat
            icon={FolderOpen}
            label="Active folders"
            value={folders}
            sub={folders
              ? `${withDoc.slice(0, 2).map((c) => c.label).join(', ')}${folders > 2 ? ` +${folders - 2}` : ''}`
              : 'Folders appear as files arrive'}
          />
        </div>
      </div>

      {/* ── requested by HR ────────────────────────────────────────────── */}
      {pending.length > 0 && (
        <section className="card border-crewly-accent/40 bg-crewly-accent/10">
          <h2 className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-bold">
            <Inbox className="h-4 w-4 shrink-0 text-crewly-orange" />
            <span className="whitespace-nowrap">Requested by HR</span>
            <span className="font-normal text-crewly-dim">— upload these to close the request</span>
          </h2>
          <div className="space-y-2">
            {pending.map((r) => (
              <div key={r._id} className="flex flex-wrap items-center gap-3 rounded-lg border border-crewly-border bg-crewly-card px-4 py-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-crewly-orange/15 text-crewly-orange">
                  <CloudUpload className="h-4 w-4" />
                </span>
                <div className="min-w-[14rem] flex-1">
                  <p className="text-sm font-semibold">{labelOf(r.category)}</p>
                  <p className="text-xs text-crewly-dim">
                    by {r.requestedBy?.name || 'HR'}
                    {r.note ? ` — “${r.note}”` : ''}
                    {r.dueDate ? ` · due ${fmtDate(r.dueDate)}` : ''}
                  </p>
                </div>
                <label
                  htmlFor={`req-file-${r._id}`}
                  className={`cursor-pointer rounded-lg bg-crewly-accent px-3 py-1.5 text-xs font-bold text-crewly-accent-ink ${busy ? 'pointer-events-none opacity-50' : ''}`}
                >
                  <Upload className="mr-1 inline h-3.5 w-3.5" />Upload
                </label>
                <input
                  id={`req-file-${r._id}`}
                  type="file"
                  className="hidden"
                  onChange={(e) => doFulfill(r, e.target.files?.[0])}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── what I asked HR for ─────────────────────────────────────────── */}
      {askHr.length > 0 && (
        <section className="card p-0">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4">
            <h2 className="flex items-center gap-2 text-sm font-bold">
              <Send className="h-4 w-4 text-crewly-dim" />
              Requested from HR
              <span className="font-normal text-crewly-dim">({askHr.length})</span>
            </h2>
            <button type="button" className="text-xs font-semibold text-crewly-orange hover:underline" onClick={() => setAskOpen(true)}>
              + New request
            </button>
          </div>
          <div className="mt-2 divide-y divide-crewly-border/60">
            {askHr.map((r) => (
              <div key={r._id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                <div className="min-w-[12rem] flex-1">
                  <p className="text-sm font-semibold">{labelOf(r.category)}</p>
                  <p className="text-xs text-crewly-dim">
                    {r.note ? `“${r.note}” · ` : ''}
                    {r.dueDate ? `needed by ${fmtDate(r.dueDate)} · ` : ''}
                    asked {fmtDate(r.createdAt)}
                  </p>
                </div>
                {chip(r.status, REQ_CHIP[r.status] || REQ_CHIP.CANCELLED)}
                {r.status === 'FULFILLED' && r.document?.name ? (
                  <span className="max-w-[12rem] truncate text-xs text-crewly-dim" title={r.document.name}>
                    {r.document.name}
                  </span>
                ) : null}
                {r.status === 'PENDING' && (
                  <button type="button" onClick={() => withdrawAsk(r)} className="btn-ghost px-2.5 py-1 text-[11px]">
                    Withdraw
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── upload panel ───────────────────────────────────────────────── */}
      {uploadOpen ? (
        <section className="card">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-crewly-dim" />
              <h2 className="text-sm font-bold">Upload documents</h2>
              <span className="rounded-full bg-crewly-inset px-2 py-0.5 text-[11px] font-semibold text-crewly-dim">
                Private · signed-in only
              </span>
            </div>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs font-semibold text-crewly-dim transition hover:text-crewly-text"
              onClick={() => setUploadOpen(false)}
            >
              Dismiss <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="grid gap-5 lg:grid-cols-[1.35fr_1fr]">
            <label
              htmlFor="doc-upload"
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                pickFile(e.dataTransfer.files?.[0]);
              }}
              className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition ${
                dragging ? 'border-crewly-green bg-crewly-green/10' : 'border-crewly-border bg-crewly-inset/60 hover:border-crewly-green'
              }`}
            >
              <span className="mb-2 flex h-11 w-11 items-center justify-center rounded-full bg-crewly-card text-crewly-green">
                <CloudUpload className="h-5 w-5" />
              </span>
              {file ? (
                <>
                  <span className="break-all text-sm font-semibold">{file.name}</span>
                  <span className="mt-1 text-xs text-crewly-dim">{fmtSize(file.size)} · click to choose another</span>
                </>
              ) : (
                <>
                  <span className="text-sm font-semibold">Drag &amp; drop the file here</span>
                  <span className="mt-1 text-xs text-crewly-dim">
                    or <span className="font-semibold text-crewly-green underline underline-offset-2">browse files</span> from your device
                  </span>
                  <span className="mt-3 text-[11px] uppercase tracking-wide text-crewly-dim">
                    PDF · PNG · JPG · DOCX · XLSX
                  </span>
                </>
              )}
              <input
                id="doc-upload"
                type="file"
                className="hidden"
                onChange={(e) => pickFile(e.target.files?.[0])}
              />
            </label>

            <div className="space-y-3">
              <div>
                <label className="label" htmlFor="doc-category">Target category</label>
                <select id="doc-category" className="input" value={cat} onChange={(e) => setCat(e.target.value)}>
                  {cats.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="doc-name">File title (optional)</label>
                <input
                  id="doc-name"
                  className="input"
                  placeholder="e.g. Passport renewal 2026"
                  value={docName}
                  onChange={(e) => setDocName(e.target.value)}
                />
              </div>
              <p className="text-xs leading-relaxed text-crewly-dim">
                The file is stored against your profile and goes to HR only if they asked for it.
              </p>
              <button
                type="button"
                className="btn-primary w-full gap-2"
                onClick={doSelfUpload}
                disabled={busy || !file}
              >
                <Upload className="h-4 w-4" />
                {busy ? 'Uploading…' : 'Process & upload'}
              </button>
            </div>
          </div>
        </section>
      ) : (
        <button
          type="button"
          className="card flex w-full items-center justify-between gap-3 text-left transition hover:border-crewly-green"
          onClick={() => setUploadOpen(true)}
        >
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Upload className="h-4 w-4 text-crewly-green" />
            Upload a document
          </span>
          <span className="text-xs text-crewly-dim">Category, title, then upload</span>
        </button>
      )}

      {/* ── tabs + toolbar ─────────────────────────────────────────────── */}
      {docs.length > 0 && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="-mx-1 flex max-w-full items-center gap-1 overflow-x-auto px-1 pb-1">
              {tabs.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setTab(t.value)}
                  aria-pressed={tab === t.value}
                  className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition ${
                    tab === t.value
                      ? 'bg-crewly-selected font-semibold text-crewly-selected-text'
                      : 'text-crewly-dim hover:bg-crewly-inset hover:text-crewly-text'
                  }`}
                >
                  {t.label}
                  <span className={`text-xs ${tab === t.value ? 'text-crewly-selected-text' : 'text-crewly-dim'}`}>{t.count}</span>
                </button>
              ))}
            </div>
            <div className="inline-flex rounded-lg bg-crewly-inset p-1">
              <button
                type="button"
                title="List view"
                aria-pressed={view === 'list'}
                onClick={() => setView('list')}
                className={`rounded-md p-1.5 transition ${view === 'list' ? 'bg-crewly-selected text-crewly-selected-text' : 'text-crewly-dim hover:text-crewly-text'}`}
              >
                <List className="h-4 w-4" />
              </button>
              <button
                type="button"
                title="Grid view"
                aria-pressed={view === 'grid'}
                onClick={() => setView('grid')}
                className={`rounded-md p-1.5 transition ${view === 'grid' ? 'bg-crewly-selected text-crewly-selected-text' : 'text-crewly-dim hover:text-crewly-text'}`}
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-crewly-dim" />
              <input
                className="input pl-9"
                placeholder="Search by file name or category…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search documents"
              />
            </div>
            <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-crewly-dim">
              Status
              <select className="input w-auto py-2 text-sm normal-case tracking-normal" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="ALL">All statuses</option>
                <option value="EXPIRING">Expiring in 30 days</option>
                <option value="EXPIRED">Expired</option>
                <option value="NO_EXPIRY">No expiry</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-crewly-dim">
              Sort
              <select className="input w-auto py-2 text-sm normal-case tracking-normal" value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="NEWEST">Newest first</option>
                <option value="OLDEST">Oldest first</option>
                <option value="NAME">Name A–Z</option>
                <option value="SIZE">Largest first</option>
              </select>
            </label>
          </div>

          {/* ── records ──────────────────────────────────────────────────── */}
          {shown.length === 0 ? (
            <div className="card">
              <EmptyState
                illustration="documents"
                title="No documents match"
                description="Nothing in this folder matches the search and status you picked. Clear them to see every file in your cabinet."
              />
            </div>
          ) : view === 'list' ? (
            <div className="card overflow-hidden p-0">
              <div className="divide-y divide-crewly-border/60">
                {shown.map((d) => (
                  <div key={d._id} className="flex items-start gap-3 px-4 py-3">
                    <FileTile name={d.name} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold" title={d.name}>{d.name}</p>
                      <p className="truncate text-xs text-crewly-dim">
                        {labelOf(d.category)} · {fmtSize(d.size)} · {fmtDate(d.createdAt)}
                        {d.uploadedBy?.name ? ` · added by ${d.uploadedBy.name}` : ''}
                      </p>
                      {d.expiryDate ? (
                        <div className="mt-1"><ExpiryBadge expiryDate={d.expiryDate} /></div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => download(d)}
                      className="btn-ghost shrink-0 gap-1.5 px-3 py-1.5 text-xs"
                      title={`Download ${d.name}`}
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Download</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((d) => (
                <article key={d._id} className="card flex flex-col gap-3">
                  <div className="flex items-start gap-3">
                    <FileTile name={d.name} size="h-11 w-11" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold" title={d.name}>{d.name}</p>
                      <p className="text-xs text-crewly-dim">{labelOf(d.category)}</p>
                    </div>
                  </div>
                  <p className="text-xs text-crewly-dim">
                    {fmtSize(d.size)} · {fmtDate(d.createdAt)}
                  </p>
                  <div className="mt-auto flex items-center justify-between gap-2">
                    <ExpiryBadge expiryDate={d.expiryDate} />
                    <button type="button" onClick={() => download(d)} className="btn-ghost gap-1.5 px-3 py-1.5 text-xs">
                      <Download className="h-3.5 w-3.5" />Download
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}

          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-crewly-dim">
            <span>Showing {shown.length} of {docs.length} record{docs.length === 1 ? '' : 's'}</span>
            <span aria-hidden="true">•</span>
            <span>Private — every download is served by the authenticated endpoint, never a public link.</span>
          </p>
        </>
      )}

      {/* First-run cabinet: the tiles above already say zero */}
      {docs.length === 0 && (
        <div className="card">
          <EmptyState
            illustration="documents"
            title="No documents yet"
            description="Upload a file above, and anything HR issues to you — letters, payslips, policies — appears here by category."
          />
        </div>
      )}

      {askOpen && (
        <Modal title="Request a document from HR" onClose={() => setAskOpen(false)}>
          <div className="space-y-3">
            <p className="text-sm text-crewly-dim">
              Ask HR to issue a letter or certificate. They upload it straight into your cabinet, and
              this request closes when they do.
            </p>
            <div>
              <label className="label" htmlFor="ask-category">What do you need?</label>
              <select
                id="ask-category"
                className="input"
                value={askForm.category}
                onChange={(e) => setAskForm({ ...askForm, category: e.target.value })}
              >
                {cats.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="ask-note">Note for HR (optional)</label>
              <textarea
                id="ask-note"
                className="input min-h-[70px]"
                placeholder="e.g. for a bank loan application, addressed to HDFC"
                value={askForm.note}
                onChange={(e) => setAskForm({ ...askForm, note: e.target.value })}
              />
            </div>
            <div>
              <label className="label" htmlFor="ask-due">Needed by (optional)</label>
              <input
                id="ask-due"
                type="date"
                className="input"
                value={askForm.neededBy}
                onChange={(e) => setAskForm({ ...askForm, neededBy: e.target.value })}
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" className="btn-ghost text-sm" onClick={() => setAskOpen(false)}>Cancel</button>
              <button type="button" className="btn-primary gap-2 text-sm" onClick={askHrForDocument} disabled={askBusy}>
                <Send className="h-4 w-4" />{askBusy ? 'Sending…' : 'Send request'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {historyOpen && (
        <Modal title="Document requests" onClose={() => setHistoryOpen(false)}>
          {requests.length + askHr.length === 0 ? (
            <p className="text-sm text-crewly-dim">
              No requests yet. HR can ask you for a file, and you can ask HR to issue a letter or
              certificate — both show up here with their dates.
            </p>
          ) : (
            <ul className="divide-y divide-crewly-border/60">
              {[
                // Incoming (HR → me) and outgoing (me → HR) in one chronology,
                // each labelled with which way it points.
                ...[...pending, ...history].map((r) => ({ ...r, _dir: 'FROM_HR' })),
                ...askHr.map((r) => ({ ...r, _dir: 'TO_HR' })),
              ]
                .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
                .map((r) => (
                  <li key={`${r._dir}-${r._id}`} className="flex flex-wrap items-center gap-2 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
                        {labelOf(r.category)}
                        <span className="rounded-full bg-crewly-inset-strong px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-crewly-dim">
                          {r._dir === 'FROM_HR' ? 'from HR' : 'to HR'}
                        </span>
                      </p>
                      <p className="text-xs text-crewly-dim">
                        {r._dir === 'FROM_HR'
                          ? `by ${r.requestedBy?.name || 'HR'}`
                          : 'you asked HR'}
                        {r.note ? ` — “${r.note}”` : ''}
                        {r.dueDate ? ` · ${r._dir === 'FROM_HR' ? 'due' : 'needed by'} ${fmtDate(r.dueDate)}` : ''}
                      </p>
                    </div>
                    {chip(r.status, REQ_CHIP[r.status] || REQ_CHIP.CANCELLED)}
                    <span className="text-xs text-crewly-dim">{fmtDate(r.fulfilledAt || r.updatedAt || r.createdAt)}</span>
                  </li>
                ))}
            </ul>
          )}
        </Modal>
      )}
    </div>
  );
}
