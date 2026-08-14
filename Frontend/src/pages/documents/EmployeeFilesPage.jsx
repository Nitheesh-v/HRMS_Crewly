// ============================================================
// 🗂 Employee Files (HR/Admin) — Phase 14 file cabinet
// pick employee → upload (category + expiry) · view/download/delete
// · request a document · track request status
// ============================================================
import React, { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import {
  getEmployees, getEmployeeCabinet, getDocCategories,
  hrUploadDocument, createDocRequest, cancelDocRequest, deleteDocument,
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

const REQ_CHIP = {
  PENDING: 'bg-amber-400/15 text-amber-300',
  FULFILLED: 'bg-emerald-400/15 text-emerald-300',
  CANCELLED: 'bg-slate-500/20 text-slate-400',
};

const ExpiryBadge = ({ expiryDate }) => {
  if (!expiryDate) return null;
  const days = Math.ceil((new Date(expiryDate) - Date.now()) / 86400000);
  if (days < 0) return chip(`⚠️ Expired`, 'bg-red-400/15 text-red-300');
  if (days <= 30) return chip(`⏳ ${days}d left`, 'bg-amber-400/15 text-amber-300');
  return chip(`Exp ${fmtDate(expiryDate)}`, 'bg-slate-500/20 text-slate-400');
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

const EmptyCabinet = { employee: null, documents: [], requests: [] };

export default function EmployeeFilesPage() {
  const me = useSelector((s) => s.auth.user);
  const allowed = ['COMPANY_ADMIN', 'HR_MANAGER'].includes(me?.role);

  const [employees, setEmployees] = useState([]);
  const [search, setSearch] = useState('');
  const [cats, setCats] = useState(FALLBACK_CATS);
  const [cabinet, setCabinet] = useState(EmptyCabinet);
  const [banner, setBanner] = useState(null);
  const [busy, setBusy] = useState(false);

  const [showUpload, setShowUpload] = useState(false);
  const [showRequest, setShowRequest] = useState(false);
  const [form, setForm] = useState({ name: '', category: 'OTHER', expiryDate: '', note: '' });
  const [reqForm, setReqForm] = useState({ category: 'AADHAAR_ID', note: '', dueDate: '' });
  const fileRef = useRef(null);

  const labelOf = (v) => cats.find((c) => c.value === v)?.label || v || 'Other';
  const flash = (ok, text) => {
    setBanner({ ok, text });
    setTimeout(() => setBanner(null), 3500);
  };

  useEffect(() => {
    (async () => {
      const [emps, c] = await Promise.all([getEmployees(), getDocCategories()]);
      setEmployees(emps.filter((e) => ['EMPLOYEE', 'TEAM_LEAD', 'MANAGER', 'HR_MANAGER'].includes(e.role)));
      if (c.length) setCats(c);
    })();
  }, []);

  const openCabinet = async (emp) => {
    setBusy(true);
    try {
      setCabinet(await getEmployeeCabinet(emp._id));
    } catch {
      setCabinet({ ...EmptyCabinet, employee: emp });
      flash(false, 'Could not open the file cabinet');
    } finally { setBusy(false); }
  };

  const empId = cabinet.employee?._id;

  const doUpload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return flash(false, 'Pick a file first');
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('document', file);
      fd.append('name', form.name.trim() || file.name);
      fd.append('category', form.category);
      if (form.expiryDate) fd.append('expiryDate', form.expiryDate);
      if (form.note.trim()) fd.append('note', form.note.trim());
      await hrUploadDocument(empId, fd);
      setShowUpload(false);
      setForm({ name: '', category: 'OTHER', expiryDate: '', note: '' });
      flash(true, 'Document uploaded ✅ — employee notified 🔔');
      await openCabinet(cabinet.employee);
    } catch (e) {
      flash(false, e?.response?.data?.message || 'Upload failed');
    } finally { setBusy(false); }
  };

  const doRequest = async () => {
    setBusy(true);
    try {
      await createDocRequest({
        userId: empId,
        category: reqForm.category,
        note: reqForm.note.trim(),
        dueDate: reqForm.dueDate || null,
      });
      setShowRequest(false);
      setReqForm({ category: 'AADHAAR_ID', note: '', dueDate: '' });
      flash(true, 'Request sent 📥 — employee notified 🔔');
      await openCabinet(cabinet.employee);
    } catch (e) {
      flash(false, e?.response?.data?.message || 'Could not create request');
    } finally { setBusy(false); }
  };

  const doDelete = async (doc) => {
    if (!window.confirm(`Delete "${doc.name}"? This cannot be undone.`)) return;
    try {
      await deleteDocument(doc._id);
      flash(true, 'Deleted 🗑');
      await openCabinet(cabinet.employee);
    } catch (e) {
      flash(false, e?.response?.data?.message || 'Delete failed');
    }
  };

  const doCancel = async (req) => {
    try {
      await cancelDocRequest(req._id);
      flash(true, 'Request withdrawn');
      await openCabinet(cabinet.employee);
    } catch (e) {
      flash(false, e?.response?.data?.message || 'Cancel failed');
    }
  };

  if (!allowed) {
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-8 text-center text-sm text-slate-300">
        🔒 Only HR or the company admin can open employee files.
      </div>
    );
  }

  const filtered = employees.filter((e) =>
    `${e.name} ${e.email} ${e.designation || ''}`.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-100">🗂 Employee Files</h1>
        <span className="text-sm text-slate-400">{employees.length} employees</span>
      </div>

      {banner && (
        <div className={`rounded-lg px-4 py-2.5 text-sm font-medium ${banner.ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}>
          {banner.text}
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[300px,1fr]">
        {/* 👥 employee picker */}
        <aside className="rounded-xl border border-slate-700 bg-slate-800/60 p-3">
          <input className={`${inp} mb-3`} placeholder="🔎 Search employees…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="max-h-[60vh] space-y-1 overflow-y-auto">
            {filtered.map((e) => (
              <button
                key={e._id}
                onClick={() => openCabinet(e)}
                className={`block w-full rounded-lg px-3 py-2 text-left text-sm transition ${
                  empId === e._id ? 'bg-indigo-600 font-bold text-white' : 'text-slate-200 hover:bg-slate-700/60'
                }`}
              >
                <span className="block truncate font-semibold">{e.name}</span>
                <span className={`block truncate text-xs ${empId === e._id ? 'text-indigo-200' : 'text-slate-400'}`}>
                  {e.designation || e.role}
                </span>
              </button>
            ))}
            {filtered.length === 0 && <p className="px-2 py-6 text-center text-xs text-slate-500">No employees found</p>}
          </div>
        </aside>

        {/* 🗂 cabinet */}
        <section className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
          {!cabinet.employee ? (
            <p className="p-10 text-center text-sm text-slate-400">👈 Pick an employee to open their file cabinet</p>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-bold text-slate-100">{cabinet.employee.name}</h2>
                  <p className="text-xs text-slate-400">{cabinet.employee.designation || cabinet.employee.role} · {cabinet.employee.email}</p>
                </div>
                <button onClick={() => setShowUpload(true)} className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-bold text-white hover:bg-indigo-500">⬆️ Upload document</button>
                <button onClick={() => setShowRequest(true)} className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs font-bold text-amber-300 hover:bg-amber-500/20">📥 Request document</button>
              </div>

              {/* documents */}
              <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">📂 Documents ({cabinet.documents.length})</h3>
              {cabinet.documents.length === 0 ? (
                <p className="mb-4 rounded-lg border border-dashed border-slate-600 p-4 text-center text-xs text-slate-500">Nothing on file yet — upload or request one above.</p>
              ) : (
                <div className="mb-4 divide-y divide-slate-700/60">
                  {cabinet.documents.map((d) => (
                    <div key={d._id} className="flex flex-wrap items-center gap-3 py-2.5">
                      <span className="text-lg">📎</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-slate-100">{d.name}</p>
                        <p className="text-xs text-slate-400">
                          {fmtSize(d.size)} · {fmtDate(d.createdAt)}
                          {d.uploadedBy?.name ? ` · by ${d.uploadedBy.name}` : ' · self-uploaded'}
                          {d.note ? ` · ${d.note}` : ''}
                        </p>
                      </div>
                      {chip(labelOf(d.category || 'OTHER'), 'bg-indigo-400/15 text-indigo-300')}
                      <ExpiryBadge expiryDate={d.expiryDate} />
                      <button onClick={() => window.open(d.fileUrl, '_blank')} className="rounded-lg border border-slate-600 px-2.5 py-1 text-[11px] font-bold text-slate-200 hover:bg-slate-700">👁</button>
                      <button onClick={() => download(d)} className="rounded-lg border border-slate-600 px-2.5 py-1 text-[11px] font-bold text-slate-200 hover:bg-slate-700">⬇</button>
                      <button onClick={() => doDelete(d)} className="rounded-lg border border-red-500/40 px-2.5 py-1 text-[11px] font-bold text-red-300 hover:bg-red-500/10">🗑</button>
                    </div>
                  ))}
                </div>
              )}

              {/* requests */}
              <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">📥 Requests ({cabinet.requests.length})</h3>
              {cabinet.requests.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-600 p-4 text-center text-xs text-slate-500">No requests yet.</p>
              ) : (
                <div className="space-y-2">
                  {cabinet.requests.map((r) => (
                    <div key={r._id} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-sm">
                      <span className="flex-1 text-slate-200">
                        {labelOf(r.category)}
                        {r.note ? <span className="text-slate-500"> — "{r.note}"</span> : null}
                        {r.dueDate ? <span className="text-slate-500"> · due {fmtDate(r.dueDate)}</span> : null}
                      </span>
                      {chip(r.status, REQ_CHIP[r.status])}
                      <span className="text-xs text-slate-500">{fmtDate(r.createdAt)}</span>
                      {r.status === 'PENDING' && (
                        <button onClick={() => doCancel(r)} className="rounded-lg border border-slate-600 px-2.5 py-1 text-[11px] font-bold text-slate-300 hover:bg-slate-700">Withdraw</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {/* ⬆️ upload modal */}
      {showUpload && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setShowUpload(false)}>
          <div className="w-full max-w-md space-y-3 rounded-xl border border-slate-600 bg-slate-800 p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold text-slate-100">⬆️ Upload for {cabinet.employee?.name}</h3>
            <select className={inp} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {cats.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <input className={inp} placeholder="Document name (optional — defaults to file name)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-400">Expiry date (optional)</label>
              <input type="date" className={inp} value={form.expiryDate} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} />
            </div>
            <input className={inp} placeholder="Note (optional)" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            <input ref={fileRef} type="file" className="w-full text-sm text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-700 file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-slate-100 hover:file:bg-slate-600" />
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setShowUpload(false)} className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-bold text-slate-300 hover:bg-slate-700">Cancel</button>
              <button onClick={doUpload} disabled={busy} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-500 disabled:opacity-50">{busy ? 'Uploading…' : 'Upload'}</button>
            </div>
          </div>
        </div>
      )}

      {/* 📥 request modal */}
      {showRequest && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setShowRequest(false)}>
          <div className="w-full max-w-md space-y-3 rounded-xl border border-slate-600 bg-slate-800 p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold text-slate-100">📥 Request from {cabinet.employee?.name}</h3>
            <select className={inp} value={reqForm.category} onChange={(e) => setReqForm({ ...reqForm, category: e.target.value })}>
              {cats.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <input className={inp} placeholder="Note (optional — e.g. 'please upload the back side too')" value={reqForm.note} onChange={(e) => setReqForm({ ...reqForm, note: e.target.value })} />
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-400">Due date (optional)</label>
              <input type="date" className={inp} value={reqForm.dueDate} onChange={(e) => setReqForm({ ...reqForm, dueDate: e.target.value })} />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setShowRequest(false)} className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-bold text-slate-300 hover:bg-slate-700">Cancel</button>
              <button onClick={doRequest} disabled={busy} className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-bold text-white hover:bg-amber-500 disabled:opacity-50">{busy ? 'Sending…' : 'Send request 🔔'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}