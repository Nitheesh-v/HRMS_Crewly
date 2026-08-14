// ============================================================
// 📄 My Documents (employee) — Phase 14
// 📥 Requested-by-HR inbox · 📂 my files by category ·
// upload own · view/download · expiry badges
// ============================================================
import React, { useEffect, useRef, useState } from 'react';
import {
  getMyDocuments, getMyDocRequests, getDocCategories,
  uploadMyDocument, fulfillDocRequest,
} from '../../services/docsService.js';

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

const inp = 'w-full rounded-lg border border-slate-600 bg-slate-900/60 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500';
const chip = (txt, cls) => (
  <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${cls}`}>{txt}</span>
);
const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

const ExpiryBadge = ({ expiryDate }) => {
  if (!expiryDate) return null;
  const days = Math.ceil((new Date(expiryDate) - Date.now()) / 86400000);
  if (days < 0) return chip(`⚠️ Expired ${fmtDate(expiryDate)}`, 'bg-red-400/15 text-red-300');
  if (days <= 30) return chip(`⏳ Expires in ${days}d`, 'bg-amber-400/15 text-amber-300');
  return chip(`Exp ${fmtDate(expiryDate)}`, 'bg-slate-500/20 text-slate-400');
};

const REQ_CHIP = {
  PENDING: 'bg-amber-400/15 text-amber-300',
  FULFILLED: 'bg-emerald-400/15 text-emerald-300',
  CANCELLED: 'bg-slate-500/20 text-slate-400',
};

const download = async (d) => {
  try {
    const res = await fetch(d.fileUrl);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = d.name || 'document';
    a.click();
    URL.revokeObjectURL(a.href);
  } catch {
    window.open(d.fileUrl, '_blank');
  }
};

export default function MyDocumentsPage() {
  const [docs, setDocs] = useState([]);
  const [requests, setRequests] = useState([]);
  const [cats, setCats] = useState(FALLBACK_CATS);
  const [banner, setBanner] = useState(null);
  const [busy, setBusy] = useState(false);
  const [cat, setCat] = useState('OTHER');
  const [docName, setDocName] = useState('');
  const fileRef = useRef(null);

  const labelOf = (v) => cats.find((c) => c.value === v)?.label || (v === 'OTHER' ? 'Other Document' : v || 'Other Document');

  const load = async () => {
    try {
      const [d, r, c] = await Promise.all([getMyDocuments(), getMyDocRequests(), getDocCategories()]);
      setDocs(d);
      setRequests(r);
      if (c.length) setCats(c);
    } catch {
      setBanner({ ok: false, text: 'Could not load documents — refresh to retry.' });
    }
  };
  useEffect(() => { load(); }, []);

  const flash = (ok, text) => {
    setBanner({ ok, text });
    setTimeout(() => setBanner(null), 3500);
  };

  const doSelfUpload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return flash(false, 'Pick a file first');
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('document', file);
      fd.append('name', docName.trim() || file.name);
      fd.append('category', cat);
      await uploadMyDocument(fd);
      setDocName(''); setCat('OTHER'); fileRef.current.value = '';
      flash(true, 'Uploaded ✅');
      await load();
    } catch (e) {
      flash(false, e?.response?.data?.message || 'Upload failed');
    } finally { setBusy(false); }
  };

  const doFulfill = async (request, file) => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('document', file);
      fd.append('name', file.name);
      await fulfillDocRequest(request._id, fd);
      flash(true, `"${file.name}" sent to HR ✅`);
      await load();
    } catch (e) {
      flash(false, e?.response?.data?.message || 'Upload failed');
    } finally { setBusy(false); }
  };

  const pending = requests.filter((r) => r.status === 'PENDING');
  const history = requests.filter((r) => r.status !== 'PENDING');
  const byCat = cats
    .map((c) => ({ ...c, items: docs.filter((d) => (d.category || 'OTHER') === c.value) }))
    .filter((g) => g.items.length);
  const leftover = docs.filter((d) => !cats.some((c) => c.value === (d.category || 'OTHER')));
  if (leftover.length) byCat.push({ value: '_misc', label: 'Other', items: leftover });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-100">📄 My Documents</h1>
        <span className="text-sm text-slate-400">{docs.length} file(s) · {pending.length} pending request(s)</span>
      </div>

      {banner && (
        <div className={`rounded-lg px-4 py-2.5 text-sm font-medium ${banner.ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}>
          {banner.text}
        </div>
      )}

      {/* 📥 Requested by HR */}
      {pending.length > 0 && (
        <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-amber-300">📥 Requested by HR — action needed</h2>
          <div className="space-y-2">
            {pending.map((r) => (
              <div key={r._id} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-700 bg-slate-800/70 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-100">{labelOf(r.category)}</p>
                  <p className="text-xs text-slate-400">
                    by {r.requestedBy?.name || 'HR'}
                    {r.note ? ` — "${r.note}"` : ''}
                    {r.dueDate ? ` · due ${fmtDate(r.dueDate)}` : ''}
                  </p>
                </div>
                <label
                  htmlFor={`req-file-${r._id}`}
                  className={`cursor-pointer rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-500 ${busy ? 'pointer-events-none opacity-50' : ''}`}
                >
                  ⬆️ Upload
                </label>
                <input id={`req-file-${r._id}`} type="file" className="hidden" onChange={(e) => doFulfill(r, e.target.files?.[0])} />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ⬆️ Upload own */}
      <section className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-300">⬆️ Upload a document</h2>
        <div className="flex flex-wrap items-center gap-3">
          <select className={`${inp} max-w-[220px]`} value={cat} onChange={(e) => setCat(e.target.value)}>
            {cats.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <input className={`${inp} max-w-[240px]`} placeholder="File name (optional)" value={docName} onChange={(e) => setDocName(e.target.value)} />
          <input ref={fileRef} type="file" className="text-sm text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-700 file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-slate-100 hover:file:bg-slate-600" />
          <button onClick={doSelfUpload} disabled={busy} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-500 disabled:opacity-50">
            {busy ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </section>

      {/* 📂 Files by category */}
      {byCat.length === 0 ? (
        <p className="rounded-xl border border-slate-700 bg-slate-800/40 p-8 text-center text-sm text-slate-400">
          No documents yet — upload above, and anything HR adds for you appears here.
        </p>
      ) : (
        byCat.map((g) => (
          <section key={g.value} className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
            <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-300">{g.label} <span className="text-slate-500">({g.items.length})</span></h2>
            <div className="divide-y divide-slate-700/60">
              {g.items.map((d) => (
                <div key={d._id} className="flex flex-wrap items-center gap-3 py-3">
                  <span className="text-xl">📎</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-100">{d.name}</p>
                    <p className="text-xs text-slate-400">
                      {fmtSize(d.size)} · {fmtDate(d.createdAt)}
                      {d.uploadedBy?.name ? ` · added by ${d.uploadedBy.name}` : ''}
                    </p>
                  </div>
                  <ExpiryBadge expiryDate={d.expiryDate} />
                  <button onClick={() => window.open(d.fileUrl, '_blank')} className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-bold text-slate-200 hover:bg-slate-700">👁 View</button>
                  <button onClick={() => download(d)} className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-bold text-slate-200 hover:bg-slate-700">⬇ Download</button>
                </div>
              ))}
            </div>
          </section>
        ))
      )}

      {/* history of requests */}
      {history.length > 0 && (
        <section className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-300">🕓 Request history</h2>
          <div className="space-y-2">
            {history.map((r) => (
              <div key={r._id} className="flex items-center gap-3 text-sm">
                <span className="flex-1 text-slate-300">{labelOf(r.category)} {r.note ? <span className="text-slate-500">— "{r.note}"</span> : null}</span>
                {chip(r.status, REQ_CHIP[r.status] || REQ_CHIP.CANCELLED)}
                <span className="text-xs text-slate-500">{fmtDate(r.fulfilledAt || r.updatedAt)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}