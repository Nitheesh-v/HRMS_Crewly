import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  FileSpreadsheet,
  FileText,
  Globe2,
  History,
  MonitorSmartphone,
  RefreshCw,
  Search,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import attendanceCaptureService from '../../services/attendanceCaptureService.js';
import usePermission from '../../hooks/usePermission.js';
import { notify } from '../../utils/notify.js';
import { TableEmpty } from '../../components/common/EmptyState.jsx';

// Phase 31.14 — CSV attendance import (HR/admin). This screen is the
// FRONT DOOR of the batch: file → schema → staging. Parsing, row
// validation and the commit itself live on the validation screen
// (/app/attendance/imports/validation), which receives the file and
// the preview through router state — the raw CSV is never persisted
// server-side, so there is nothing to re-fetch later.
//
// Everything printed about limits comes from the import rules:
// 5,000 rows, 2,000,000 characters, a 12-month window, four event
// types, workMode on CLOCK_IN only. Device telemetry (heartbeats,
// firmware, MDM) has no endpoint — the strip says so instead of
// drawing a sync trace.

const PAGE_SIZE = 8;
const ACCEPT = '.csv,text/csv';
const MAX_ROWS = 5000;

const SCHEMA = [
  {
    column: 'employeeCode',
    required: true,
    note: 'Must match an ACTIVE employee’s code (case-insensitive).',
  },
  {
    column: 'timestamp',
    required: true,
    note: 'ISO-8601 with an offset (2026-10-27T09:00:00+05:30) or Z.',
  },
  {
    column: 'eventType',
    required: true,
    note: 'CLOCK_IN · BREAK_START · BREAK_END · CLOCK_OUT.',
  },
  {
    column: 'workMode',
    required: false,
    note: 'CLOCK_IN only. OFFICE · WFH · FIELD · CLIENT_SITE. Blank means OFFICE.',
  },
  {
    column: 'sourceReference',
    required: false,
    note: 'Free text (≤120 chars) kept on the punch for audit.',
  },
];

const RULES = [
  ['5,000 rows / file', 'The parser stops there and flags the file as truncated — never a silent partial import.'],
  ['12-month window', 'A row older than twelve months, or dated in the future, is rejected with that reason.'],
  ['workMode on CLOCK_IN only', 'Any other event type carrying a work mode is rejected.'],
  ['Finalized months refuse rows', 'Reopen the month on Attendance Finalization, then re-import.'],
  ['Already-recorded rows are skipped', 'The same employee, event and exact instant is a replay, not a duplicate.'],
  ['Valid rows only', 'One bad row never poisons a file; rejections are listed line by line on the staging screen.'],
];

const STATUS_STYLE = {
  DRAFT: 'bg-st-high text-st-on-variant',
  CONFIRMING: 'bg-st-primary-fixed text-st-on-primary-fixed-variant',
  CONFIRMED: 'bg-st-secondary-container text-st-on-secondary-container',
  FAILED: 'bg-st-error-container text-st-on-error-container',
};

const fmtStamp = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const fmtBytes = (bytes) => {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const PILL = 'rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider';

const FieldLabel = ({ children }) => (
  <span className="block text-[9px] font-bold uppercase tracking-[0.12em] text-st-on-variant">{children}</span>
);

const AttendanceImportPage = () => {
  const { hasPermission, loading: permissionsLoading } = usePermission();
  const canManage = hasPermission('ATTENDANCE_CAPTURE_MANAGE');
  const navigate = useNavigate();

  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [template, setTemplate] = useState('');
  const [stations, setStations] = useState([]);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const inputRef = useRef(null);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const res = await attendanceCaptureService.listImports();
      setHistory(res.data?.imports || []);
    } catch (err) {
      setHistory([]);
      setHistoryError(err?.message || 'Could not read the import ledger');
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canManage) return undefined;
    let active = true;
    attendanceCaptureService.listImports()
      .then((res) => { if (active) setHistory(res.data?.imports || []); })
      .catch((err) => {
        if (!active) return;
        setHistory([]);
        setHistoryError(err?.message || 'Could not read the import ledger');
      })
      .finally(() => { if (active) setHistoryLoading(false); });
    attendanceCaptureService.templateText().then(
      (text) => { if (active) setTemplate(text); },
      () => { if (active) setTemplate(''); },
    );
    attendanceCaptureService.listStations()
      .then((res) => { if (active) setStations(res.data?.stations || []); })
      .catch(() => { if (active) setStations([]); });
    return () => { active = false; };
  }, [canManage]);

  const pick = (next) => {
    setError('');
    if (!next) return;
    if (!/\.csv$/i.test(next.name)) {
      setError(`${next.name} is not a .csv file. The parser reads comma-separated text only.`);
      return;
    }
    setFile(next);
  };

  const onDrop = (event) => {
    event.preventDefault();
    setDragging(false);
    pick(event.dataTransfer.files?.[0] || null);
  };

  const goToStaging = async () => {
    if (!file) return;
    setBusy('preview');
    setError('');
    try {
      const res = await attendanceCaptureService.previewImport(file);
      const preview = res.data;
      if (!preview) throw new Error('The server returned no preview');
      // Router state carries the File itself: the raw bytes are never
      // persisted server-side, so the staging screen must hold them.
      navigate('/app/attendance/imports/validation', {
        state: { fileName: file.name, fileSize: file.size, file, preview },
      });
    } catch (err) {
      setError(err?.message || 'Could not validate the file');
    } finally {
      setBusy('');
    }
  };

  const openBatch = async (batchId) => {
    setDetailLoading(true);
    setDetail({ id: batchId });
    try {
      const res = await attendanceCaptureService.getImport(batchId);
      setDetail(res.data?.import || res.data || null);
    } catch (err) {
      setDetail(null);
      notify.error(err?.message || 'Could not load that batch');
    } finally {
      setDetailLoading(false);
    }
  };

  const downloadOutcomes = (batch) => {
    const outcomes = batch?.outcomes || [];
    const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const lines = [
      ['Line', 'Employee', 'Event', 'Outcome', 'Detail', 'At'].map(cell).join(','),
      ...outcomes.map((row) => [
        row.line,
        row.employeeCode,
        row.eventType || '',
        row.status || 'UNKNOWN',
        row.message || '',
        row.at ? new Date(row.at).toISOString() : '',
      ].map(cell).join(',')),
    ];
    const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `attendance-import-${batch?.id || 'batch'}-outcomes.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return history.filter((batch) => {
      if (status && batch.status !== status) return false;
      if (!needle) return true;
      return [batch.sourceLabel, batch.fingerprint, ...(batch.months || [])]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [history, query, status]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Filtering narrows paging by clamping, not by a state-setting effect.
  const safePage = Math.min(page, totalPages);
  const visible = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const activeStations = stations.filter((station) => station.status === 'ACTIVE').length;
  const lastStationUse = stations
    .map((station) => (station.lastUsedAt ? new Date(station.lastUsedAt).getTime() : 0))
    .reduce((max, value) => Math.max(max, value), 0);

  if (permissionsLoading) {
    return (
      <div className="st-surface min-h-screen">
        <div className="rounded-xl bg-st-lowest p-6 text-sm text-st-on-variant shadow-sm">Loading import tools…</div>
      </div>
    );
  }

  if (!canManage) {
    return (
      <div className="st-surface min-h-screen">
        <div className="rounded-xl bg-st-lowest p-6 shadow-sm">
          <h1 className="text-xl font-bold text-st-on">Attendance Import</h1>
          <p className="mt-2 text-sm text-st-on-variant">
            Bulk imports are run by HR. You don’t have the attendance-capture permission for this page.
          </p>
        </div>
      </div>
    );
  }

  const sample = (template || 'employeeCode,timestamp,eventType,workMode,sourceReference\n').trim().split('\n');

  return (
    <div className="st-surface min-h-screen">
      <div className="flex flex-col gap-5">
        {/* ── hero ─────────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-st-on-variant">
              Time &amp; Leave · Attendance Import
            </span>
            <h1 className="mt-1 text-3xl font-bold tracking-tight text-st-on lg:text-[2rem]">Attendance Import</h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-st-on-variant">
              Bulk-load external biometric hardware exports and device punch logs as verified attendance
              events. Up to {MAX_ROWS.toLocaleString('en-IN')} rows per file, validated before anything is
              written.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => attendanceCaptureService.downloadTemplate()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-st-lowest px-3 py-2 text-[11px] font-bold text-st-on shadow-sm transition hover:bg-st-low"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" /> Download template CSV
            </button>
            <a
              href="#csv-schema"
              className="inline-flex items-center gap-1.5 rounded-lg bg-st-lowest px-3 py-2 text-[11px] font-bold text-st-on shadow-sm transition hover:bg-st-low"
            >
              <FileText className="h-3.5 w-3.5" aria-hidden="true" /> Format guide
            </a>
          </div>
        </section>

        {error ? (
          <div className="flex items-center gap-3 rounded-lg bg-st-error-container px-4 py-2.5 text-xs font-medium text-st-on-error-container">
            {error}
            <button type="button" onClick={() => setError('')} className="rounded bg-st-lowest px-2 py-1 text-[11px] font-bold text-st-on">
              Dismiss
            </button>
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1fr)_22rem]">
          {/* ── left: upload + rules ─────────────────────────────────── */}
          <div className="flex min-w-0 flex-col gap-4">
            <section className="rounded-xl bg-st-lowest p-4 shadow-sm">
              <div className="flex items-start gap-2">
                <span className="rounded-lg bg-st-low p-1.5">
                  <Upload className="h-4 w-4 text-st-outline" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <h2 className="text-sm font-bold text-st-on">Upload batch file</h2>
                  <p className="text-[10px] text-st-on-variant">
                    Validated against the live employee directory, work-mode policy and finalized periods.
                  </p>
                </div>
                <span className={`ml-auto shrink-0 ${PILL} bg-st-secondary-container text-st-on-secondary-container`}>
                  Parser · CSV
                </span>
              </div>

              <div
                onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                className={`mt-3 flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition ${
                  dragging ? 'border-st-secondary bg-st-container' : 'border-st-high bg-st-low'
                }`}
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-st-lowest shadow-sm">
                  <FileSpreadsheet className="h-5 w-5 text-st-secondary" aria-hidden="true" />
                </span>
                <p className="mt-2 text-xs font-bold text-st-on">Drag a CSV here, or choose a file</p>
                <p className="mt-0.5 text-[10px] text-st-on-variant">
                  CSV only · ≤ {MAX_ROWS.toLocaleString('en-IN')} rows · ≤ 2,000,000 characters · UTF-8
                </p>
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="mt-3 rounded-lg bg-st-lowest px-3 py-1.5 text-[11px] font-bold text-st-on shadow-sm transition hover:bg-st-container"
                >
                  Choose CSV file
                </button>
                <input
                  ref={inputRef}
                  type="file"
                  accept={ACCEPT}
                  className="hidden"
                  aria-label="Choose a CSV file"
                  onChange={(event) => pick(event.target.files?.[0] || null)}
                />
              </div>

              {file ? (
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-st-primary-fixed/40 px-3 py-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded bg-st-primary-container text-st-on-primary-container">
                    <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-bold text-st-on">{file.name}</span>
                    <span className="block text-[10px] text-st-on-variant">
                      {fmtBytes(file.size)} · not read yet — validation happens on the next screen
                    </span>
                  </span>
                  <span className={`${PILL} bg-st-secondary-container text-st-on-secondary-container`}>Ready</span>
                  <button
                    type="button"
                    onClick={() => setFile(null)}
                    className="rounded p-1 text-st-on-variant transition hover:text-st-on"
                    aria-label="Remove the chosen file"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={goToStaging}
                    disabled={busy === 'preview'}
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-st-primary px-3 py-2 text-[11px] font-bold text-st-on-primary shadow-sm transition hover:opacity-95 disabled:opacity-60 sm:w-auto"
                  >
                    {busy === 'preview' ? 'Validating…' : 'Preview & validate'}
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              ) : (
                <p className="mt-2 text-[10px] leading-relaxed text-st-on-variant">
                  Nothing is uploaded to storage: the parser reads the file in memory, validates it, and the
                  staging screen decides whether any row is written.
                </p>
              )}

              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div className="rounded-lg bg-st-low px-3 py-2">
                  <FieldLabel>Target scope</FieldLabel>
                  <p className="mt-0.5 text-[11px] font-bold text-st-on">
                    {file ? 'Resolved at validation' : 'Whole company'}
                  </p>
                  <p className="text-[9px] leading-snug text-st-on-variant">
                    Months come from the row timestamps, not from this screen.
                  </p>
                </div>
                <div className="rounded-lg bg-st-low px-3 py-2">
                  <FieldLabel>Default work mode</FieldLabel>
                  <p className="mt-0.5 text-[11px] font-bold text-st-on">OFFICE</p>
                  <p className="text-[9px] leading-snug text-st-on-variant">
                    Applied only when a CLOCK_IN row leaves workMode blank.
                  </p>
                </div>
                <div className="rounded-lg bg-st-low px-3 py-2">
                  <FieldLabel>Timezone normalisation</FieldLabel>
                  <p className="mt-0.5 flex items-center gap-1 text-[11px] font-bold text-st-on">
                    <Globe2 className="h-3 w-3 text-st-outline" aria-hidden="true" /> Company policy zone
                  </p>
                  <p className="text-[9px] leading-snug text-st-on-variant">
                    Every row must carry its own offset; the policy zone decides the session day.
                  </p>
                </div>
              </div>
            </section>

            {/* Fleet strip: the mock draws a device sync trace. There is no
                device endpoint, so the strip reports the fleet we can read
                and says the rest out loud. */}
            <section className="flex flex-col gap-3 rounded-xl bg-st-low px-4 py-3 shadow-sm sm:flex-row sm:items-center">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-st-lowest text-st-secondary shadow-sm">
                <MonitorSmartphone className="h-4 w-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-st-on">
                  {activeStations} kiosk station{activeStations === 1 ? '' : 's'} active
                  {stations.length - activeStations > 0 ? ` · ${stations.length - activeStations} inactive` : ''}
                </p>
                <p className="text-[10px] leading-snug text-st-on-variant">
                  {lastStationUse
                    ? `Last kiosk activity ${fmtStamp(new Date(lastStationUse).toISOString())}. `
                    : 'No station has been used yet. '}
                  A CSV import is a file, not a device read: no terminal heartbeat, firmware or MDM state is
                  claimed here.
                </p>
              </div>
              <Link
                to="/app/attendance/kiosks"
                className="shrink-0 rounded-lg bg-st-lowest px-3 py-1.5 text-[10px] font-bold text-st-on shadow-sm transition hover:bg-st-container"
              >
                Kiosk stations
              </Link>
            </section>

            <section className="rounded-xl bg-st-lowest p-4 shadow-sm">
              <h2 className="flex items-center gap-1.5 text-sm font-bold text-st-on">
                <ShieldCheck className="h-3.5 w-3.5 text-st-outline" aria-hidden="true" /> Batch engine rules
              </h2>
              <p className="mt-0.5 text-[10px] text-st-on-variant">
                Enforced server-side on both the preview and the commit — the client cannot skip one.
              </p>
              <dl className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {RULES.map(([title, note]) => (
                  <div key={title} className="rounded-lg bg-st-low px-2.5 py-1.5">
                    <dt className="text-[10px] font-bold text-st-on">{title}</dt>
                    <dd className="text-[9px] leading-snug text-st-on-variant">{note}</dd>
                  </div>
                ))}
              </dl>
            </section>

            {/* ── history ledger ────────────────────────────────────── */}
            <section id="import-history" className="overflow-hidden rounded-xl bg-st-lowest shadow-sm">
              <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                <h2 className="flex items-center gap-1.5 text-sm font-bold text-st-on">
                  <History className="h-3.5 w-3.5 text-st-outline" aria-hidden="true" /> Import history ledger
                </h2>
                <span className="text-[10px] text-st-on-variant">
                  {history.length} batch{history.length === 1 ? '' : 'es'} · archived, row-level outcomes kept
                </span>
                <div className="ml-auto flex flex-wrap items-center gap-1.5">
                  <label className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-st-outline" aria-hidden="true" />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      maxLength={60}
                      placeholder="File or month…"
                      className="w-40 rounded-lg bg-st-low py-1.5 pl-7 pr-2 text-[10px] text-st-on placeholder:text-st-on-variant/60 focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                      aria-label="Search import history"
                    />
                  </label>
                  <select
                    value={status}
                    onChange={(event) => setStatus(event.target.value)}
                    className="rounded-lg bg-st-low px-2 py-1.5 text-[10px] font-semibold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                    aria-label="Batch status"
                  >
                    <option value="">All statuses</option>
                    <option value="DRAFT">Draft</option>
                    <option value="CONFIRMING">Confirming</option>
                    <option value="CONFIRMED">Confirmed</option>
                    <option value="FAILED">Failed</option>
                  </select>
                  <button
                    type="button"
                    onClick={loadHistory}
                    className="rounded-lg bg-st-low p-1.5 text-st-on-variant transition hover:text-st-on"
                    aria-label="Reload history"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${historyLoading ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              </div>

              {historyError ? (
                <p className="border-t border-st-high/60 px-4 py-2 text-[11px] text-st-on-error-container">{historyError}</p>
              ) : null}

              <div className="overflow-x-auto border-t border-st-high/60">
                <table className="w-full min-w-[46rem] text-left">
                  <thead>
                    <tr className="bg-st-container text-[9px] font-bold uppercase tracking-wider text-st-on-variant">
                      <th className="py-2 pl-4 pr-2 font-bold">File name</th>
                      <th className="px-2 py-2 font-bold">Scoped month</th>
                      <th className="px-2 py-2 font-bold">Status</th>
                      <th className="px-2 py-2 text-right font-bold">Imported</th>
                      <th className="px-2 py-2 text-right font-bold">Skipped</th>
                      <th className="px-2 py-2 text-right font-bold">Rejected</th>
                      <th className="px-2 py-2 font-bold">Uploaded at</th>
                      <th className="py-2 pl-2 pr-4 text-right font-bold">Artifact</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((batch) => (
                      <tr
                        key={batch.id}
                        className="cursor-pointer border-b border-st-high/50 transition hover:bg-st-low"
                        onClick={() => openBatch(batch.id)}
                      >
                        <td className="py-2 pl-4 pr-2">
                          <span className="flex items-center gap-1.5">
                            <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-st-outline" aria-hidden="true" />
                            <span className="min-w-0">
                              <span className="block max-w-[15rem] truncate text-[11px] font-bold text-st-on">
                                {batch.sourceLabel || `batch ${String(batch.fingerprint || '').slice(0, 10)}`}
                              </span>
                              <span className="block text-[9px] text-st-on-variant">
                                {String(batch.fingerprint || '').slice(0, 16)}…
                              </span>
                            </span>
                          </span>
                        </td>
                        <td className="px-2 py-2 text-[10px] text-st-on-variant">{(batch.months || []).join(', ') || '—'}</td>
                        <td className="px-2 py-2">
                          <span className={`${PILL} ${STATUS_STYLE[batch.status] || STATUS_STYLE.DRAFT}`}>{batch.status}</span>
                        </td>
                        <td className="px-2 py-2 text-right text-[11px] font-semibold tabular-nums text-st-secondary">{batch.importedCount ?? 0}</td>
                        <td className="px-2 py-2 text-right text-[11px] tabular-nums text-st-on-variant">{batch.skippedCount ?? 0}</td>
                        <td className="px-2 py-2 text-right text-[11px] tabular-nums">
                          {batch.rejectedCount ? (
                            <span className="font-bold text-st-error">{batch.rejectedCount}</span>
                          ) : (
                            <span className="text-st-on-variant">0</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-[10px] text-st-on-variant">{fmtStamp(batch.confirmedAt || batch.createdAt)}</td>
                        <td className="py-2 pl-2 pr-4 text-right">
                          <button
                            type="button"
                            onClick={(event) => { event.stopPropagation(); openBatch(batch.id).then(() => {}); }}
                            className="inline-flex items-center gap-1 rounded bg-st-low px-1.5 py-1 text-[9px] font-bold text-st-on-variant transition hover:text-st-on"
                            title="Open this batch to download its outcome ledger"
                          >
                            <Download className="h-2.5 w-2.5" aria-hidden="true" /> Open
                          </button>
                        </td>
                      </tr>
                    ))}
                    {!historyLoading && visible.length === 0 ? (
                      <TableEmpty
                        colSpan={8}
                        illustration="documents"
                        title={history.length ? 'No batch matches that filter' : 'No imports yet'}
                        description={
                          history.length
                            ? 'Clear the search or the status filter to see every archived batch.'
                            : 'Upload a biometric or device export above — every file you bring in is archived here with its row-level outcome.'
                        }
                      />
                    ) : null}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between border-t border-st-high/60 px-4 py-2 text-[10px] text-st-on-variant">
                <span>
                  Showing <strong className="font-bold text-st-on">{visible.length}</strong> of {filtered.length} archived batch
                  {filtered.length === 1 ? '' : 'es'}
                  {history.length > filtered.length ? ` (${history.length} in the ledger)` : ''}
                </span>
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    className="rounded bg-st-low p-1.5 transition hover:text-st-on disabled:opacity-40"
                    disabled={safePage <= 1}
                    onClick={() => setPage((value) => Math.max(1, value - 1))}
                    aria-label="Previous page"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </button>
                  <span className="px-1 text-st-on">Page {safePage} of {totalPages}</span>
                  <button
                    type="button"
                    className="rounded bg-st-low p-1.5 transition hover:text-st-on disabled:opacity-40"
                    disabled={safePage >= totalPages}
                    onClick={() => setPage((value) => value + 1)}
                    aria-label="Next page"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </span>
              </div>
            </section>
          </div>

          {/* ── right: schema ────────────────────────────────────────── */}
          <div className="flex flex-col gap-4">
            <section id="csv-schema" className="rounded-xl bg-st-lowest p-4 shadow-sm">
              <div className="flex items-start gap-2">
                <span className="rounded-lg bg-st-low p-1.5">
                  <FileText className="h-4 w-4 text-st-outline" aria-hidden="true" />
                </span>
                <div>
                  <h2 className="text-sm font-bold text-st-on">Required CSV schema</h2>
                  <p className="text-[10px] text-st-on-variant">Five columns, this exact first row.</p>
                </div>
                <span className={`ml-auto shrink-0 ${PILL} bg-st-high text-st-on-variant`}>{SCHEMA.length} columns</span>
              </div>

              <ul className="mt-2.5 space-y-1.5">
                {SCHEMA.map((row) => (
                  <li key={row.column} className="rounded-lg bg-st-low px-2.5 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <code className="font-mono text-[10px] font-bold text-st-on">{row.column}</code>
                      <span className={`ml-auto ${PILL} ${
                        row.required
                          ? 'bg-st-primary-fixed text-st-on-primary-fixed-variant'
                          : 'bg-st-high text-st-on-variant'
                      }`}>
                        {row.required ? 'Required' : 'Optional'}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[9px] leading-snug text-st-on-variant">{row.note}</p>
                  </li>
                ))}
              </ul>

              <div className="mt-3">
                <div className="flex items-center justify-between">
                  <FieldLabel>Live template from the API</FieldLabel>
                  <button
                    type="button"
                    onClick={() => attendanceCaptureService.downloadTemplate()}
                    className="text-[9px] font-bold text-st-primary hover:underline"
                  >
                    Download
                  </button>
                </div>
                <pre className="mt-1 overflow-x-auto rounded-lg bg-st-inverse px-2.5 py-2 text-[9px] leading-relaxed text-st-inverse-on">
                  {sample.map((line) => `${line}\n`).join('')}
                </pre>
                <p className="mt-1 text-[9px] text-st-on-variant">
                  Fetched from <code className="font-mono">/attendance/imports/template.csv</code> — not a
                  hand-typed sample.
                </p>
              </div>
            </section>

            <section className="rounded-xl bg-st-primary-fixed/40 p-4 shadow-sm">
              <h2 className="flex items-center gap-1.5 text-sm font-bold text-st-on">
                <BadgeCheck className="h-3.5 w-3.5 text-st-on-primary-fixed-variant" aria-hidden="true" />
                Provenance, never overwrite
              </h2>
              <p className="mt-1 text-[10px] leading-relaxed text-st-on-primary-fixed-variant">
                Imported events are attributed to the <code className="font-mono">IMPORT</code> capture source
                with the file’s fingerprint, so an auditor can trace a punch back to the file it came from.
                Existing punches are never overwritten — a file can only add facts, and a row that would
                contradict the ledger is rejected with its reason.
              </p>
              <p className="mt-1.5 flex items-center gap-1 text-[9px] font-bold text-st-on-primary-fixed-variant">
                <Clock className="h-3 w-3" aria-hidden="true" /> A commit is resumable: an interrupted import
                continues where it stopped.
              </p>
            </section>

            <section className="rounded-xl bg-st-lowest p-4 shadow-sm">
              <h2 className="text-sm font-bold text-st-on">What this screen will not claim</h2>
              <ul className="mt-1.5 space-y-1 text-[10px] leading-relaxed text-st-on-variant">
                <li className="flex gap-1.5">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-st-outline" aria-hidden="true" />
                  No device sync trace: the batch is a file, and no terminal heartbeat or firmware state is
                  exposed by the API.
                </li>
                <li className="flex gap-1.5">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-st-outline" aria-hidden="true" />
                  No “9 kiosks operational” badge unless the station records actually say so — the fleet line
                  above counts real ACTIVE stations.
                </li>
                <li className="flex gap-1.5">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-st-outline" aria-hidden="true" />
                  No XLSX/TSV parsing: the parser reads comma-separated UTF-8 text.
                </li>
              </ul>
            </section>
          </div>
        </div>

        <p className="flex items-start gap-2 rounded-xl bg-st-low px-4 py-3 text-[10px] leading-relaxed text-st-on-variant">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-st-secondary" aria-hidden="true" />
          <span>
            <strong className="font-semibold text-st-on">Nothing is written from this screen.</strong> Choosing a
            file only sends its bytes to the validator, which returns a staged preview. The commit happens on
            the next screen, after you have seen every rejected row.
          </span>
        </p>
      </div>

      {/* ── batch detail drawer ────────────────────────────────────────── */}
      {detail ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-3 sm:items-center"
          onClick={() => setDetail(null)}
        >
          <div
            className="w-full max-w-2xl rounded-xl bg-st-lowest p-4 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-bold text-st-on">
                  {detail.sourceLabel || detail.id || 'Batch'}
                </h2>
                <p className="text-[10px] text-st-on-variant">
                  {detail.status ? `${detail.status} · ` : ''}
                  {(detail.months || []).join(', ') || 'no months resolved'} · {detail.rowCount ?? 0} rows
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDetail(null)}
                className="ml-auto rounded p-1 text-st-on-variant transition hover:text-st-on"
                aria-label="Close batch"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-2 grid grid-cols-3 gap-2">
              {[
                ['Imported', detail.importedCount ?? 0, 'text-st-secondary'],
                ['Skipped', detail.skippedCount ?? 0, 'text-st-on-variant'],
                ['Rejected', detail.rejectedCount ?? 0, 'text-st-error'],
              ].map(([label, value, tone]) => (
                <div key={label} className="rounded-lg bg-st-low px-2.5 py-1.5 text-center">
                  <p className={`text-base font-bold tabular-nums ${tone}`}>{value}</p>
                  <p className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">{label}</p>
                </div>
              ))}
            </div>

            {detailLoading ? (
              <p className="mt-2 text-[11px] text-st-on-variant">Loading outcomes…</p>
            ) : (
              <>
                <div className="mt-2 max-h-64 overflow-auto rounded-lg bg-st-low">
                  {(detail.outcomes || []).length ? (
                    <table className="w-full text-left">
                      <thead className="sticky top-0 bg-st-container text-[9px] font-bold uppercase tracking-wider text-st-on-variant">
                        <tr>
                          <th className="px-2 py-1.5 font-bold">Line</th>
                          <th className="px-2 py-1.5 font-bold">Employee</th>
                          <th className="px-2 py-1.5 font-bold">Outcome</th>
                          <th className="px-2 py-1.5 font-bold">Detail</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(detail.outcomes || []).map((row) => (
                          <tr key={`${row.line}-${row.status}`} className="border-t border-st-high/50">
                            <td className="px-2 py-1 text-[10px] tabular-nums text-st-on-variant">{row.line}</td>
                            <td className="px-2 py-1 text-[10px] font-semibold text-st-on">{row.employeeCode}</td>
                            <td className="px-2 py-1">
                              <span className={`${PILL} ${
                                row.status === 'IMPORTED'
                                  ? 'bg-st-secondary-container text-st-on-secondary-container'
                                  : row.status === 'SKIPPED'
                                    ? 'bg-st-high text-st-on-variant'
                                    : 'bg-st-error-container text-st-on-error-container'
                              }`}>
                                {row.status || 'UNKNOWN'}
                              </span>
                            </td>
                            <td className="px-2 py-1 text-[10px] text-st-on-variant">
                              {row.message || `${row.eventType || ''} ${row.at ? fmtStamp(row.at) : ''}`.trim() || '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="px-2 py-3 text-[11px] text-st-on-variant">
                      This batch has no stored outcomes yet — it was never confirmed.
                    </p>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => downloadOutcomes(detail)}
                    disabled={!(detail.outcomes || []).length}
                    className="inline-flex items-center gap-1 rounded-lg bg-st-low px-2.5 py-1.5 text-[10px] font-bold text-st-on transition hover:bg-st-container disabled:opacity-50"
                  >
                    <Download className="h-3 w-3" aria-hidden="true" /> Outcome ledger CSV
                  </button>
                  <span className="text-[9px] text-st-on-variant">
                    Fingerprint {String(detail.fingerprint || '').slice(0, 24)}…
                  </span>
                  <Link
                    to="/app/attendance/analytics"
                    className="ml-auto inline-flex items-center gap-1 text-[10px] font-bold text-st-primary hover:underline"
                  >
                    Capture mix in analytics <ArrowRight className="h-3 w-3" aria-hidden="true" />
                  </Link>
                </div>
              </>
            )}
            {!detailLoading && (detail.status === 'CONFIRMED') ? (
              <p className="mt-2 flex items-center gap-1 text-[9px] text-st-secondary">
                <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> Stored result — a replay of this file
                returns this same ledger.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default AttendanceImportPage;
