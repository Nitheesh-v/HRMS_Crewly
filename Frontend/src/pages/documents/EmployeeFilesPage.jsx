// ============================================================
// Employee Files — the HR cabinet.
//
// One employee at a time: pick someone on the left, and the right-hand side is
// their whole cabinet — header, standard checkpoints, documents on file, and the
// requests HR is waiting on. The four tiles describe *that cabinet*, because
// that is the only scope this page can honestly count: the company list endpoint
// carries no document counts, so a company-wide "48 files" would be invented.
//
// The reference layout asked for a storage quota, a ZIP export, an "edit record"
// action, an automatic reminder and a completion percentage. None of those exist
// in this API, so none of them are here; the checkpoints are labelled as a
// standard set, not as a compliance score.
//
// Phase 14 · Phase 32.8 (private bytes) · Phase 35.1 (toasts)
// ============================================================
import { useEffect, useRef, useState } from 'react';
import {
  Check, ChevronRight, Download, FileText, FolderOpen, Hourglass, Inbox, Lock,
  Paperclip, ShieldCheck, Trash2, Upload, Users,
} from 'lucide-react';
import { useSelector } from 'react-redux';
import Modal from '../../components/Modal.jsx';
import {
  getEmployees, getEmployeeCabinet, getDocCategories,
  hrUploadDocument, createDocRequest, cancelDocRequest, deleteDocument, downloadDocument,
  fulfillHrDocRequest, cancelHrDocRequest,
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

// The API returns the department name as the designation for many people, which
// would print as "Human Resource · Human Resource". Keep the first of a repeat.
const uniqueParts = (parts) => parts.filter((part, i) => part && parts.indexOf(part) === i);

// The four documents an HR cabinet is normally expected to hold. This is a
// checklist, not a compliance rule: nothing in the API marks a document as
// mandatory, so the page never scores the cabinet against it.
const STANDARD_CHECKS = ['OFFER_LETTER', 'AADHAAR_ID', 'SALARY_DOCUMENT', 'CONTRACT'];

const fmtSize = (n) => {
  if (!n) return '—';
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
};
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const bytesOf = (docs) => docs.reduce((sum, d) => sum + (Number(d.size) || 0), 0);
const daysTo = (d) => (d ? Math.ceil((new Date(d) - Date.now()) / 86400000) : null);

const chip = (txt, cls) => (
  <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${cls}`}>{txt}</span>
);

const REQ_CHIP = {
  PENDING: 'bg-crewly-accent/20 text-crewly-text',
  FULFILLED: 'bg-crewly-green/15 text-crewly-green',
  CANCELLED: 'bg-crewly-inset-strong text-crewly-dim',
};

const initials = (name = '') => name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '—';

const ExpiryBadge = ({ expiryDate }) => {
  if (!expiryDate) return null;
  const days = daysTo(expiryDate);
  if (days < 0) return chip('Expired', 'bg-crewly-red/15 text-crewly-red');
  if (days <= 30) return chip(<><Hourglass className="mr-1 inline h-3 w-3" />{days}d left</>, 'bg-crewly-orange/15 text-crewly-orange');
  return chip(`Exp ${fmtDate(expiryDate)}`, 'bg-crewly-inset-strong text-crewly-dim');
};

// Phase 32.8 — documents are PRIVATE: bytes flow through the gated
// GET /documents/:id/file endpoint with the caller's authentication.
const download = async (d) => {
  try {
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

const Tile = ({ icon: Icon, label, value, sub }) => (
  <div className="flex items-start gap-3 p-4 sm:p-5">
    <div className="min-w-0 flex-1">
      <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">{label}</p>
      <p className="mt-1.5 text-xl font-bold leading-tight sm:text-2xl">{value}</p>
      {sub ? <p className="mt-1 text-xs leading-snug text-crewly-dim">{sub}</p> : null}
    </div>
    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-crewly-dim" aria-hidden="true" />
  </div>
);

const EmptyCabinet = { employee: null, documents: [], requests: [] };

export default function EmployeeFilesPage() {
  const me = useSelector((s) => s.auth.user);
  const allowed = ['COMPANY_ADMIN', 'HR_MANAGER'].includes(me?.role);

  const [employees, setEmployees] = useState([]);
  const [search, setSearch] = useState('');
  const [dept, setDept] = useState('ALL');
  const [cats, setCats] = useState(FALLBACK_CATS);
  const [cabinet, setCabinet] = useState(EmptyCabinet);
  const [busy, setBusy] = useState(false);

  const [showUpload, setShowUpload] = useState(false);
  const [showRequest, setShowRequest] = useState(false);
  const [form, setForm] = useState({ name: '', category: 'OTHER', expiryDate: '', note: '' });
  const [reqForm, setReqForm] = useState({ category: 'AADHAAR_ID', note: '', dueDate: '' });
  const fileRef = useRef(null);

  const labelOf = (v) => cats.find((c) => c.value === v)?.label || v || 'Other';
  const flash = (ok, text) => {
    const body = typeof text === 'string' && text ? text : '';

    if (!body) return;

    if (ok) notify.success(body);
    else notify.error(body);
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
  const docs = cabinet.documents || [];
  const requests = cabinet.requests || [];
  // Two directions in one array: HR asking the employee for a file, and the
  // employee asking HR to issue one. Split them, or the same list would show
  // "waiting on the employee" for a request that is waiting on HR.
  const fromEmployee = requests.filter((r) => r.direction === 'TO_HR');
  const toEmployee = requests.filter((r) => r.direction !== 'TO_HR');
  const pendingFromEmployee = fromEmployee.filter((r) => r.status === 'PENDING');
  const pendingToEmployee = toEmployee.filter((r) => r.status === 'PENDING');
  const pending = [...pendingFromEmployee, ...pendingToEmployee];

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
      flash(true, 'Document uploaded — employee notified');
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
      flash(true, 'Request sent — employee notified');
      await openCabinet(cabinet.employee);
    } catch (e) {
      flash(false, e?.response?.data?.message || 'Could not create request');
    } finally { setBusy(false); }
  };

  const doDelete = async (doc) => {
    if (!window.confirm(`Delete "${doc.name}"? This cannot be undone.`)) return;
    try {
      await deleteDocument(doc._id);
      flash(true, 'Deleted');
      await openCabinet(cabinet.employee);
    } catch (e) {
      flash(false, e?.response?.data?.message || 'Delete failed');
    }
  };

  // HR provides what the employee asked for: the file lands in THEIR cabinet,
  // and the request closes in the same call.
  const doProvide = async (request, chosen) => {
    if (!chosen) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('document', chosen);
      fd.append('name', chosen.name);
      await fulfillHrDocRequest(request._id, fd);
      flash(true, 'Document provided — the employee has been notified');
      await openCabinet(cabinet.employee);
    } catch (e) {
      flash(false, e?.response?.data?.message || 'Could not attach the document');
    } finally { setBusy(false); }
  };

  const doDecline = async (request) => {
    if (!window.confirm(`Decline the request for ${labelOf(request.category)}?`)) return;
    try {
      await cancelHrDocRequest(request._id);
      flash(true, 'Request declined');
      await openCabinet(cabinet.employee);
    } catch (e) {
      flash(false, e?.response?.data?.message || 'Could not decline the request');
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
      <div className="card flex items-center gap-2 p-8 text-sm text-crewly-dim">
        <Lock className="h-4 w-4" />Only HR or the company admin can open employee files.
      </div>
    );
  }

  const deptName = (e) => e.department?.name || 'Unassigned';
  const deptTabs = Object.entries(
    employees.reduce((acc, e) => {
      const key = deptName(e);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  ).sort((a, b) => b[1] - a[1]);

  const filtered = employees
    .filter((e) => dept === 'ALL' || deptName(e) === dept)
    .filter((e) => `${e.name} ${e.email} ${e.designation || ''} ${deptName(e)}`.toLowerCase().includes(search.toLowerCase()));

  const covered = STANDARD_CHECKS.filter((c) => docs.some((d) => (d.category || 'OTHER') === c)).length;
  const expiring = docs.filter((d) => {
    const days = daysTo(d.expiryDate);
    return days !== null && days <= 30;
  }).length;

  return (
    <div className="space-y-5">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-crewly-green/15 text-crewly-green">
            <FolderOpen className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-bold sm:text-2xl">Employee Files</h1>
            <p className="mt-1 max-w-xl text-sm leading-relaxed text-crewly-dim">
              One cabinet per person: the documents HR holds, the requests still waiting on
              the employee, and what is due to expire.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
          <button
            type="button"
            className="btn-ghost w-full justify-center gap-2 text-sm sm:w-auto"
            onClick={() => setShowRequest(true)}
            disabled={!empId}
            title={empId ? 'Ask this employee for a document' : 'Pick an employee first'}
          >
            <Inbox className="h-4 w-4" />Request document
          </button>
          <button
            type="button"
            className="btn-primary w-full justify-center gap-2 text-sm sm:w-auto"
            onClick={() => setShowUpload(true)}
            disabled={!empId}
            title={empId ? 'Upload into this cabinet' : 'Pick an employee first'}
          >
            <Upload className="h-4 w-4" />Upload document
          </button>
        </div>
      </div>

      {/* ── tiles: this cabinet, not the company ───────────────────────── */}
      <div className="card grid grid-cols-2 gap-px overflow-hidden border-crewly-border bg-crewly-border p-0 sm:grid-cols-2 xl:grid-cols-4">
        <div className="bg-crewly-card">
          <Tile
            icon={FileText}
            label="Files on file"
            value={empId ? docs.length : '—'}
            sub={empId ? `${fmtSize(bytesOf(docs))} in this cabinet` : 'Pick an employee'}
          />
        </div>
        <div className="bg-crewly-card">
          <Tile
            icon={Hourglass}
            label="Expiring soon"
            value={empId ? expiring : '—'}
            sub={expiring ? 'Within 30 days, or already expired' : empId ? 'Nothing expiring' : 'Pick an employee'}
          />
        </div>
        <div className="bg-crewly-card">
          <Tile
            icon={ShieldCheck}
            label="Checkpoints covered"
            value={empId ? `${covered} / ${STANDARD_CHECKS.length}` : '—'}
            sub="The standard four, as a checklist"
          />
        </div>
        <div className="bg-crewly-card">
          <Tile
            icon={Inbox}
            label="Pending requests"
            value={empId ? pending.length : '—'}
            sub={!pending.length
              ? (empId ? 'Nothing outstanding' : 'Pick an employee')
              : pendingFromEmployee.length
                ? `${pendingFromEmployee.length} waiting on you`
                : `Waiting on ${cabinet.employee?.name || 'the employee'}`}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[330px_1fr]">
        {/* ── picker ───────────────────────────────────────────────────── */}
        <aside className="card h-fit p-3">
          <div className="relative mb-2">
            <Users className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-crewly-dim" />
            <input
              className="input pl-9"
              placeholder="Search employees…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search employees"
            />
          </div>

          <div className="-mx-1 mb-2 flex items-center gap-1 overflow-x-auto px-1 pb-1">
            <button
              type="button"
              onClick={() => setDept('ALL')}
              aria-pressed={dept === 'ALL'}
              className={`shrink-0 rounded-lg px-2.5 py-1 text-xs transition ${
                dept === 'ALL' ? 'bg-crewly-selected font-semibold text-crewly-selected-text' : 'text-crewly-dim hover:bg-crewly-inset'
              }`}
            >
              All ({employees.length})
            </button>
            {deptTabs.map(([name, count]) => (
              <button
                key={name}
                type="button"
                onClick={() => setDept(name)}
                aria-pressed={dept === name}
                className={`shrink-0 rounded-lg px-2.5 py-1 text-xs transition ${
                  dept === name ? 'bg-crewly-selected font-semibold text-crewly-selected-text' : 'text-crewly-dim hover:bg-crewly-inset'
                }`}
              >
                {name} ({count})
              </button>
            ))}
          </div>

          <div className="max-h-[58vh] space-y-1 overflow-y-auto">
            {filtered.map((e) => {
              const active = empId === e._id;
              return (
                <button
                  key={e._id}
                  type="button"
                  onClick={() => openCabinet(e)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition ${
                    active ? 'bg-crewly-selected' : 'hover:bg-crewly-inset'
                  }`}
                >
                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold ${
                    active ? 'bg-crewly-card text-crewly-selected-text' : 'bg-crewly-inset text-crewly-dim'
                  }`}>
                    {initials(e.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-sm font-semibold ${active ? 'text-crewly-selected-text' : ''}`}>{e.name}</span>
                    <span className={`block truncate text-xs ${active ? 'text-crewly-selected-text/80' : 'text-crewly-dim'}`}>
                      {e.designation || e.role} · {deptName(e)}
                    </span>
                  </span>
                  <ChevronRight className={`h-4 w-4 shrink-0 ${active ? 'text-crewly-selected-text' : 'text-crewly-dim'}`} />
                </button>
              );
            })}
            {filtered.length === 0 && (
              <EmptyState
                illustration="search"
                title="No employees found"
                description="Nothing matches that search or department. Clear them to list everyone in your company."
                size="sm"
              />
            )}
          </div>
        </aside>

        {/* ── cabinet ──────────────────────────────────────────────────── */}
        <section className="space-y-4">
          {!cabinet.employee ? (
            <div className="card">
              <EmptyState
                illustration="documents"
                title="Pick an employee"
                description="Choose someone on the left to open their file cabinet — contracts, IDs, certificates and anything HR has requested."
              />
            </div>
          ) : (
            <>
              <div className="card">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-crewly-green/15 text-base font-bold text-crewly-green">
                    {initials(cabinet.employee.name)}
                  </span>
                  <div className="min-w-[12rem] flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-lg font-bold">{cabinet.employee.name}</h2>
                      <span className="badge bg-crewly-inset-strong text-crewly-dim">
                        {cabinet.employee.role?.replaceAll('_', ' ')}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-crewly-dim">
                      {uniqueParts([cabinet.employee.designation, deptName(cabinet.employee), cabinet.employee.email]).join(' · ')}
                    </p>
                    {cabinet.employee.employeeCode ? (
                      <p className="mt-0.5 text-[11px] uppercase tracking-wide text-crewly-dim">ID {cabinet.employee.employeeCode}</p>
                    ) : null}
                  </div>
                  <button type="button" className="btn-ghost gap-1.5 px-3 py-1.5 text-xs" onClick={() => setShowRequest(true)}>
                    <Inbox className="h-3.5 w-3.5" />Request
                  </button>
                  <button type="button" className="btn-primary gap-1.5 px-3 py-1.5 text-xs" onClick={() => setShowUpload(true)}>
                    <Upload className="h-3.5 w-3.5" />Upload
                  </button>
                </div>
              </div>

              {/* checkpoints */}
              <div className="card">
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="card-title text-sm font-bold">Standard document checkpoints</h3>
                  <p className="text-xs text-crewly-dim">A checklist, not a compliance score</p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {STANDARD_CHECKS.map((code) => {
                    const onFile = docs.some((d) => (d.category || 'OTHER') === code);
                    return (
                      <div key={code} className="flex items-center gap-2.5 rounded-lg border border-crewly-border bg-crewly-inset/50 px-3 py-2">
                        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
                          onFile ? 'bg-crewly-green/15 text-crewly-green' : 'bg-crewly-inset-strong text-crewly-dim'
                        }`}>
                          {onFile ? <Check className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm">{labelOf(code)}</span>
                        {onFile ? (
                          <span className="text-[11px] font-semibold text-crewly-green">On file</span>
                        ) : (
                          <button
                            type="button"
                            className="text-[11px] font-semibold text-crewly-orange hover:underline"
                            onClick={() => { setForm((f) => ({ ...f, category: code })); setShowUpload(true); }}
                          >
                            Upload
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* documents */}
              <div className="card p-0">
                <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4">
                  <h3 className="card-title flex items-center gap-2 text-sm font-bold">
                    <Paperclip className="h-4 w-4 text-crewly-dim" />
                    Documents on file
                    <span className="text-crewly-dim">({docs.length})</span>
                  </h3>
                  <button type="button" className="text-xs font-semibold text-crewly-orange hover:underline" onClick={() => setShowUpload(true)}>
                    + Add file directly
                  </button>
                </div>
                {docs.length === 0 ? (
                  <EmptyState
                    illustration="documents"
                    title="Nothing on file yet"
                    description="Upload a document or ask the employee for one — it lands here by category, with its expiry date."
                    size="sm"
                  />
                ) : (
                  <div className="mt-2 divide-y divide-crewly-border/60">
                    {docs.map((d) => (
                      <div key={d._id} className="flex items-start gap-3 px-4 py-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-crewly-inset text-crewly-dim">
                          <FileText className="h-4 w-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold" title={d.name}>{d.name}</p>
                          <p className="truncate text-xs text-crewly-dim">
                            {labelOf(d.category || 'OTHER')} · {fmtSize(d.size)} · {fmtDate(d.createdAt)}
                            {d.uploadedBy?.name ? ` · by ${d.uploadedBy.name}` : ' · self-uploaded'}
                            {d.note ? ` · ${d.note}` : ''}
                          </p>
                          {d.expiryDate ? <div className="mt-1"><ExpiryBadge expiryDate={d.expiryDate} /></div> : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <button type="button" onClick={() => download(d)} className="btn-ghost px-2 py-1" title={`Download ${d.name}`}>
                            <Download className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => doDelete(d)}
                            className="inline-flex items-center rounded-lg border border-crewly-red/40 px-2 py-1 text-crewly-red transition hover:bg-crewly-red/10"
                            title={`Delete ${d.name}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* the employee asked HR for something — this is the HR inbox */}
              {fromEmployee.length > 0 && (
                <div className="card p-0 border-crewly-accent/40">
                  <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4">
                    <h3 className="card-title flex items-center gap-2 text-sm font-bold">
                      <Inbox className="h-4 w-4 text-crewly-orange" />
                      Requested by {cabinet.employee.name.split(' ')[0]}
                      <span className="text-crewly-dim">({fromEmployee.length})</span>
                    </h3>
                    <span className="text-xs text-crewly-dim">
                      {pendingFromEmployee.length ? 'Attach the file to close it' : 'Nothing waiting on you'}
                    </span>
                  </div>
                  <div className="mt-2 divide-y divide-crewly-border/60">
                    {fromEmployee.map((r) => (
                      <div key={r._id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                        <div className="min-w-[12rem] flex-1">
                          <p className="text-sm font-semibold">{labelOf(r.category)}</p>
                          <p className="text-xs text-crewly-dim">
                            {r.note ? `“${r.note}”` : 'No note'}
                            {r.dueDate ? ` · needed by ${fmtDate(r.dueDate)}` : ''}
                            {` · asked ${fmtDate(r.createdAt)}`}
                          </p>
                        </div>
                        {chip(r.status, REQ_CHIP[r.status] || REQ_CHIP.CANCELLED)}
                        {r.status === 'PENDING' && (
                          <>
                            <label
                              htmlFor={`provide-${r._id}`}
                              className={`cursor-pointer rounded-lg bg-crewly-accent px-2.5 py-1 text-[11px] font-bold text-crewly-accent-ink ${busy ? 'pointer-events-none opacity-50' : ''}`}
                            >
                              <Upload className="mr-1 inline h-3 w-3" />Provide
                            </label>
                            <input
                              id={`provide-${r._id}`}
                              type="file"
                              className="hidden"
                              onChange={(e) => doProvide(r, e.target.files?.[0])}
                            />
                            <button type="button" onClick={() => doDecline(r)} className="btn-ghost px-2.5 py-1 text-[11px]">
                              Decline
                            </button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* requests HR raised with the employee */}
              <div className="card p-0">
                <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4">
                  <h3 className="card-title flex items-center gap-2 text-sm font-bold">
                    <Inbox className="h-4 w-4 text-crewly-dim" />
                    Asked of {cabinet.employee.name.split(' ')[0]}
                    <span className="text-crewly-dim">({toEmployee.length})</span>
                  </h3>
                  <button type="button" className="text-xs font-semibold text-crewly-orange hover:underline" onClick={() => setShowRequest(true)}>
                    + New request
                  </button>
                </div>
                {toEmployee.length === 0 ? (
                  <EmptyState
                    illustration="inbox"
                    title="No requests yet"
                    description="Ask for a missing document and it is tracked here until the employee uploads it."
                    size="sm"
                  />
                ) : (
                  <div className="mt-2 divide-y divide-crewly-border/60">
                    {toEmployee.map((r) => (
                      <div key={r._id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                        <div className="min-w-[10rem] flex-1">
                          <p className="text-sm font-semibold">{labelOf(r.category)}</p>
                          <p className="text-xs text-crewly-dim">
                            {r.note ? `“${r.note}”` : 'No note'}
                            {r.dueDate ? ` · due ${fmtDate(r.dueDate)}` : ''}
                            {` · raised ${fmtDate(r.createdAt)}`}
                          </p>
                        </div>
                        {chip(r.status, REQ_CHIP[r.status] || REQ_CHIP.CANCELLED)}
                        {r.status === 'PENDING' && (
                          <button type="button" onClick={() => doCancel(r)} className="btn-ghost px-2.5 py-1 text-[11px]">
                            Withdraw
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      {showUpload && (
        <Modal title={`Upload for ${cabinet.employee?.name || 'employee'}`} onClose={() => setShowUpload(false)}>
          <div className="space-y-3">
            <div>
              <label className="label" htmlFor="ef-category">Category</label>
              <select id="ef-category" className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {cats.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="ef-name">Document name (optional)</label>
              <input id="ef-name" className="input" placeholder="Defaults to the file name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="ef-expiry">Expiry date (optional)</label>
              <input id="ef-expiry" type="date" className="input" value={form.expiryDate} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="ef-note">Note (optional)</label>
              <input id="ef-note" className="input" placeholder="Shows in the employee's notification" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </div>
            <input ref={fileRef} type="file" className="w-full text-sm text-crewly-dim file:mr-3 file:rounded-lg file:border-0 file:bg-crewly-inset-strong file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-crewly-text" />
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setShowUpload(false)} className="btn-ghost text-sm">Cancel</button>
              <button type="button" onClick={doUpload} disabled={busy} className="btn-primary text-sm">
                {busy ? 'Uploading…' : 'Upload'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {showRequest && (
        <Modal title={`Request from ${cabinet.employee?.name || 'employee'}`} onClose={() => setShowRequest(false)}>
          <div className="space-y-3">
            <div>
              <label className="label" htmlFor="ef-req-cat">Document</label>
              <select id="ef-req-cat" className="input" value={reqForm.category} onChange={(e) => setReqForm({ ...reqForm, category: e.target.value })}>
                {cats.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="ef-req-note">Note (optional)</label>
              <input id="ef-req-note" className="input" placeholder="e.g. please upload the back side too" value={reqForm.note} onChange={(e) => setReqForm({ ...reqForm, note: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="ef-req-due">Due date (optional)</label>
              <input id="ef-req-due" type="date" className="input" value={reqForm.dueDate} onChange={(e) => setReqForm({ ...reqForm, dueDate: e.target.value })} />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setShowRequest(false)} className="btn-ghost text-sm">Cancel</button>
              <button type="button" onClick={doRequest} disabled={busy} className="btn-primary text-sm">
                {busy ? 'Sending…' : 'Send request'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
