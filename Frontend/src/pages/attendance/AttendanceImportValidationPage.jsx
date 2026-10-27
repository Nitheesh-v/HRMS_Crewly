import { useCallback, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Ban,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  FileSpreadsheet,
  Fingerprint,
  Globe2,
  Hash,
  RefreshCw,
  Search,
  ShieldCheck,
  SkipForward,
  TriangleAlert,
  X,
} from 'lucide-react';
import attendanceCaptureService from '../../services/attendanceCaptureService.js';
import usePermission from '../../hooks/usePermission.js';
import { notify } from '../../utils/notify.js';
import EmptyState from '../../components/common/EmptyState.jsx';

// Phase 31.14 — staging review for a CSV import. Reached from the
// import screen with the File and the preview in router state,
// because the raw bytes are never persisted server-side: there is
// nothing to re-fetch, and pretending otherwise would be a lie.
//
// REAL DATA ONLY. Everything on this page comes from the preview
// response (`rowCount`, `validCount`, `invalidCount`, `valid[]`,
// `invalid[]`, `months`, `timeZone`, `fingerprint`) or from the
// commit response (`importedCount`, `skippedCount`, `rejectedCount`,
// `outcomes[]`, `processedCount`/`totalCount`). The mock's "AI
// conflict", "sequence overlap" and "duplicate clock-out" buckets
// are replaced by the server's OWN rejection messages, grouped —
// the categories therefore cannot drift from the validator.
//
// There is no "ignore row" or "send to exception queue" endpoint:
// a rejected row is simply not imported, and the guidance under each
// card says how to fix it before re-uploading.

const PAGE_SIZE = 8;
const MAX_CHUNK_CALLS = 400;
const MAX_TRANSIENT_RETRIES = 2;

const EVENT_TONE = {
  CLOCK_IN: 'bg-st-secondary-container text-st-on-secondary-container',
  CLOCK_OUT: 'bg-st-primary-fixed text-st-on-primary-fixed-variant',
  BREAK_START: 'bg-st-tertiary-fixed text-st-on-tertiary-fixed',
  BREAK_END: 'bg-st-high text-st-on-variant',
};

const PILL = 'rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider';

const fmtClock = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
};

const fmtDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: 'numeric' });
};

// Guidance is ADVICE, not data — it never appears where a fact belongs.
const guidanceFor = (message = '') => {
  const text = message.toLowerCase();
  if (text.includes('unknown employee') || text.includes('inactive')) {
    return 'Check the code against the employee directory; inactive employees cannot receive punches.';
  }
  if (text.includes('12-month') || text.includes('window')) {
    return 'This timestamp is outside the import window — correct the date or enter it manually.';
  }
  if (text.includes('workmode applies')) {
    return 'Clear workMode on this row, or change the event type to CLOCK_IN.';
  }
  if (text.includes('not enabled in policy')) {
    return 'Either enable that work mode on the attendance policy, or correct the row.';
  }
  if (text.includes('finalized')) {
    return 'Reopen the month on Attendance Finalization, then re-import this row.';
  }
  if (text.includes('no open session') || text.includes('open session')) {
    return 'This punch closes or pauses a session that never opened — add the missing CLOCK_IN row first.';
  }
  if (text.includes('already') || text.includes('collision') || text.includes('duplicate')) {
    return 'The ledger already holds this fact. If it is wrong, correct it through a regularization.';
  }
  return 'Fix the row in the source file and upload again — nothing has been written for it.';
};

const KpiCard = ({ label, value, unit, hint, tone, accent, icon: Icon, meter = 100 }) => (
  <div className="rounded-xl bg-st-lowest p-4 shadow-sm">
    <div className="flex items-start justify-between gap-2">
      <span className="text-[10px] font-bold uppercase tracking-wider text-st-on-variant">{label}</span>
      <span className={`rounded-lg p-1 ${tone}`}>
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    </div>
    <div className="mt-1 flex items-baseline gap-1">
      <span className="text-2xl font-bold text-st-on tabular-nums">{value}</span>
      {unit ? <span className="text-[10px] font-bold uppercase tracking-wider text-st-on-variant">{unit}</span> : null}
    </div>
    <p className="mt-0.5 text-[10px] leading-snug text-st-on-variant">{hint}</p>
    <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-st-high">
      <div className={`h-full rounded-full ${accent}`} style={{ width: `${Math.max(0, Math.min(100, meter))}%` }} />
    </div>
  </div>
);

const AttendanceImportValidationPage = () => {
  const { hasPermission, loading: permissionsLoading } = usePermission();
  const canManage = hasPermission('ATTENDANCE_CAPTURE_MANAGE');
  const navigate = useNavigate();
  const location = useLocation();

  const staged = location.state || null;
  const file = staged?.file || null;
  const preview = staged?.preview || null;

  const [search, setSearch] = useState('');
  const [validPage, setValidPage] = useState(1);
  const [messageFilter, setMessageFilter] = useState('');
  const [conflictPage, setConflictPage] = useState(1);
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [routeToQueue, setRouteToQueue] = useState(true);

  const validRows = useMemo(() => preview?.valid || [], [preview]);
  const invalidRows = useMemo(() => preview?.invalid || [], [preview]);

  const filteredValid = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return validRows;
    return validRows.filter((row) => [row.name, row.employeeCode, row.eventType, row.month]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle)));
  }, [validRows, search]);

  // Conflicts are grouped by the validator's own sentence. No invented
  // severity, no invented category: if the API says it, it is shown.
  const groups = useMemo(() => {
    const map = new Map();
    invalidRows.forEach((row) => {
      const key = row.message || 'Rejected';
      map.set(key, (map.get(key) || 0) + 1);
    });
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [invalidRows]);

  const validPages = Math.max(1, Math.ceil(filteredValid.length / PAGE_SIZE));
  const conflictPages = Math.max(1, Math.ceil(filteredInvalid.length / PAGE_SIZE));

  const filteredInvalid = useMemo(
    () => (messageFilter ? invalidRows.filter((row) => (row.message || 'Rejected') === messageFilter) : invalidRows),
    [invalidRows, messageFilter],
  );

  const impactedStaff = useMemo(() => {
    const codes = new Set();
    validRows.forEach((row) => row.employeeCode && codes.add(String(row.employeeCode).toUpperCase()));
    invalidRows.forEach((row) => row.employeeCode && codes.add(String(row.employeeCode).toUpperCase()));
    return codes.size;
  }, [validRows, invalidRows]);

  const visibleValid = filteredValid.slice((safeValidPage - 1) * PAGE_SIZE, safeValidPage * PAGE_SIZE);
  const visibleInvalid = filteredInvalid.slice((safeConflictPage - 1) * PAGE_SIZE, safeConflictPage * PAGE_SIZE);

  /* Filtering resets paging by CLAMPING rather than by an effect: an effect
     would set state on the render that changed the filter and cascade. */
  const safeValidPage = Math.min(validPage, validPages);
  const safeConflictPage = Math.min(conflictPage, conflictPages);

  const exportRejections = useCallback(() => {
    if (!invalidRows.length) return;
    const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const lines = [
      ['Line', 'Employee', 'Rejection', 'Guidance'].map(cell).join(','),
      ...invalidRows.map((row) => [row.line, row.employeeCode || '', row.message || '', guidanceFor(row.message)].map(cell).join(',')),
    ];
    const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `attendance-rejections-${String(preview?.fingerprint || 'batch').slice(0, 8)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, [invalidRows, preview]);

  /*
   * The commit is chunked server-side: every call does bounded work,
   * persists its outcomes and reports progress, and the next call
   * continues from where the stored outcomes end. Each row keeps its
   * own idempotency key, so a retry can only replay a row.
   */
  const runCommit = async () => {
    let transientRetries = 0;
    for (let call = 0; call < MAX_CHUNK_CALLS; call += 1) {
      let response;
      try {
        response = await attendanceCaptureService.confirmImport(file);
      } catch (err) {
        // api.js normalizes errors (`.status`, no `.response`): a missing
        // status is a dead network or a timeout, and a 5xx is the server
        // asking to be tried again. A 4xx is an answer — never retried.
        const transient = !err?.status || Number(err.status) >= 500;
        if (!transient || transientRetries >= MAX_TRANSIENT_RETRIES) throw err;
        transientRetries += 1;
        continue;
      }
      transientRetries = 0;
      const data = response.data;
      setProgress({
        processed: Number(data?.processedCount || 0),
        total: Number(data?.totalCount || data?.rowCount || 0),
      });
      if (data?.done || data?.status !== 'CONFIRMING') return data;
    }
    throw new Error('The import is taking longer than expected — press Confirm again to continue');
  };

  const commit = async () => {
    if (!file) return;
    setBusy('commit');
    setError('');
    setProgress(null);
    try {
      const data = await runCommit();
      setResult(data);
      if (data?.duplicate) notify.warning('This file was already imported — showing the stored result.');
      else if (data?.rejectedCount) {
        notify.warning(`Imported ${data.importedCount || 0} events — ${data.rejectedCount} row(s) could not be written.`);
      } else {
        notify.success(`Imported ${data.importedCount || 0} events (${data.skippedCount || 0} already recorded).`);
      }
    } catch (err) {
      setError(err?.message || 'Could not commit the batch');
      notify.error(err, 'Could not commit the batch');
    } finally {
      setBusy('');
    }
  };

  if (permissionsLoading) {
    return (
      <div className="st-surface min-h-screen">
        <div className="rounded-xl bg-st-lowest p-6 text-sm text-st-on-variant shadow-sm">Loading staging review…</div>
      </div>
    );
  }

  if (!canManage) {
    return (
      <div className="st-surface min-h-screen">
        <div className="rounded-xl bg-st-lowest p-6 shadow-sm">
          <h1 className="text-xl font-bold text-st-on">Attendance Import Validation</h1>
          <p className="mt-2 text-sm text-st-on-variant">
            Staged batches are reviewed by HR. You don’t have the attendance-capture permission for this page.
          </p>
        </div>
      </div>
    );
  }

  if (!preview || !file) {
    return (
      <div className="st-surface min-h-screen">
        <div className="rounded-xl bg-st-lowest p-6 shadow-sm">
          <EmptyState
            illustration="documents"
            title="No staged batch in this session"
            description="A staging review only exists while the chosen file is in the browser — the raw CSV is never stored on the server, so it cannot be reopened later. Choose the file again to validate it."
            action={(
              <button
                type="button"
                onClick={() => navigate('/app/attendance/imports')}
                className="inline-flex items-center gap-1.5 rounded-lg bg-st-primary px-3 py-2 text-[11px] font-bold text-st-on-primary"
              >
                Back to Attendance Import <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          />
        </div>
      </div>
    );
  }

  const total = preview.rowCount || (validRows.length + invalidRows.length);
  // A valid row the ledger already holds will be SKIPPED, so the commit
  // count must not include it — otherwise the button would promise writes
  // the server deliberately refuses.
  const alreadyCount = validRows.filter((row) => row.alreadyRecorded).length;
  const freshCount = validRows.length - alreadyCount;
  const cleanPct = total ? Math.round((validRows.length / total) * 1000) / 10 : 0;
  const flaggedPct = total ? Math.round((invalidRows.length / total) * 1000) / 10 : 0;

  /* ── committed: the batch is now a stored ledger entry ─────────── */
  if (result) {
    const outcomes = result.outcomes || [];
    return (
      <div className="st-surface min-h-screen">
        <div className="flex flex-col gap-4">
          <section className="rounded-xl bg-st-lowest p-5 shadow-sm">
            <div className="flex flex-wrap items-start gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-st-secondary-container text-st-on-secondary-container">
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h1 className="text-xl font-bold text-st-on">
                  {result.duplicate ? 'This file was already committed' : 'Batch committed'}
                </h1>
                <p className="text-[11px] text-st-on-variant">
                  {staged.fileName} · batch {String(result.id || '').slice(-6) || '—'} ·{' '}
                  {result.importedCount || 0} imported · {result.skippedCount || 0} already recorded ·{' '}
                  {result.rejectedCount || 0} rejected
                </p>
              </div>
              <span className={`ml-auto ${PILL} ${result.duplicate ? 'bg-st-high text-st-on-variant' : 'bg-st-secondary-container text-st-on-secondary-container'}`}>
                {result.duplicate ? 'Stored replay' : 'Confirmed'}
              </span>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {[
                ['Imported now', result.importedCount || 0, 'bg-st-secondary-container', 'text-st-on-secondary-container'],
                ['Already recorded', result.skippedCount || 0, 'bg-st-high', 'text-st-on-variant'],
                ['Rejected on write', result.rejectedCount || 0, 'bg-st-error-container', 'text-st-on-error-container'],
              ].map(([label, value, bg, tone]) => (
                <div key={label} className={`rounded-lg px-3 py-2 ${bg}`}>
                  <p className={`text-lg font-bold tabular-nums ${tone}`}>{value}</p>
                  <p className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">{label}</p>
                </div>
              ))}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
                  const lines = [
                    ['Line', 'Employee', 'Event', 'Outcome', 'Detail', 'At'].map(cell).join(','),
                    ...outcomes.map((row) => [row.line, row.employeeCode, row.eventType || '', row.status || 'UNKNOWN', row.message || '', row.at ? new Date(row.at).toISOString() : ''].map(cell).join(',')),
                  ];
                  const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
                  const url = URL.createObjectURL(blob);
                  const anchor = document.createElement('a');
                  anchor.href = url;
                  anchor.download = `attendance-import-${result.id || 'batch'}-outcomes.csv`;
                  document.body.appendChild(anchor);
                  anchor.click();
                  anchor.remove();
                  URL.revokeObjectURL(url);
                }}
                disabled={!outcomes.length}
                className="inline-flex items-center gap-1.5 rounded-lg bg-st-low px-3 py-1.5 text-[11px] font-bold text-st-on transition hover:bg-st-container disabled:opacity-50"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" /> Download outcome ledger
              </button>
              <Link
                to="/app/attendance/analytics"
                className="inline-flex items-center gap-1.5 rounded-lg bg-st-low px-3 py-1.5 text-[11px] font-bold text-st-on transition hover:bg-st-container"
              >
                Capture mix in analytics <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
              <button
                type="button"
                onClick={() => navigate('/app/attendance/imports')}
                className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-st-primary px-3 py-1.5 text-[11px] font-bold text-st-on-primary transition hover:opacity-95"
              >
                Back to the import ledger <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </section>

          <section className="overflow-hidden rounded-xl bg-st-lowest shadow-sm">
            <div className="px-4 py-3">
              <h2 className="text-sm font-bold text-st-on">Row outcomes</h2>
              <p className="text-[10px] text-st-on-variant">
                Every line of the file, with the status the server stored for it.
              </p>
            </div>
            <div className="max-h-[28rem] overflow-auto border-t border-st-high/60">
              <table className="w-full min-w-[40rem] text-left">
                <thead className="sticky top-0 bg-st-container text-[9px] font-bold uppercase tracking-wider text-st-on-variant">
                  <tr>
                    <th className="py-2 pl-4 pr-2 font-bold">Line</th>
                    <th className="px-2 py-2 font-bold">Employee</th>
                    <th className="px-2 py-2 font-bold">Event</th>
                    <th className="px-2 py-2 font-bold">Outcome</th>
                    <th className="py-2 pl-2 pr-4 font-bold">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {outcomes.map((row) => (
                    <tr key={`${row.line}-${row.status}`} className="border-b border-st-high/50">
                      <td className="py-1.5 pl-4 pr-2 text-[10px] tabular-nums text-st-on-variant">{row.line}</td>
                      <td className="px-2 py-1.5 text-[11px] font-semibold text-st-on">{row.employeeCode}</td>
                      <td className="px-2 py-1.5">
                        {row.eventType ? (
                          <span className={`${PILL} ${EVENT_TONE[row.eventType] || 'bg-st-high text-st-on-variant'}`}>
                            {row.eventType.replace('_', ' ')}
                          </span>
                        ) : <span className="text-[10px] text-st-on-variant">—</span>}
                      </td>
                      <td className="px-2 py-1.5">
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
                      <td className="py-1.5 pl-2 pr-4 text-[10px] text-st-on-variant">
                        {row.message || (row.at ? fmtClock(row.at) : '—')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    );
  }

  /* ── staging: nothing written yet ──────────────────────────────── */
  return (
    <div className="st-surface min-h-screen">
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-st-on-variant">
                Time &amp; Leave · Attendance Import · Batch review
              </span>
              <span className={`${PILL} bg-st-primary-fixed text-st-on-primary-fixed-variant`}>
                Staged · nothing written
              </span>
            </div>
            <h1 className="mt-1 text-3xl font-bold tracking-tight text-st-on lg:text-[2rem]">
              Attendance import validation
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-st-on-variant">
              Inspecting <span className="font-semibold text-st-on">{staged.fileName}</span> — {total} parsed
              row{total === 1 ? '' : 's'}. Review what will be committed and what the validator refused before
              anything reaches the attendance ledger.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => navigate('/app/attendance/imports')}
              className="inline-flex items-center gap-1.5 rounded-lg bg-st-lowest px-3 py-2 text-[11px] font-bold text-st-on shadow-sm transition hover:bg-st-low"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" /> Cancel batch
            </button>
            <button
              type="button"
              onClick={exportRejections}
              disabled={!invalidRows.length}
              className="inline-flex items-center gap-1.5 rounded-lg bg-st-lowest px-3 py-2 text-[11px] font-bold text-st-on shadow-sm transition hover:bg-st-low disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" /> Export rejection log
            </button>
            <button
              type="button"
              onClick={commit}
              disabled={!validRows.length || busy === 'commit'}
              className="inline-flex items-center gap-1.5 rounded-lg bg-st-primary px-3 py-2 text-[11px] font-bold text-st-on-primary shadow-sm transition hover:opacity-95 disabled:opacity-50"
            >
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              {busy === 'commit'
                ? progress?.total
                  ? `Committing ${progress.processed}/${progress.total}…`
                  : 'Committing…'
                : `Confirm & commit ${freshCount} new row${freshCount === 1 ? '' : 's'}${
                  alreadyCount ? ` (+${alreadyCount} already recorded)` : ''
                }`}
            </button>
          </div>
        </section>

        {error ? (
          <div className="flex items-center gap-3 rounded-lg bg-st-error-container px-4 py-2.5 text-xs font-medium text-st-on-error-container">
            {error}
            <button type="button" onClick={commit} className="rounded bg-st-lowest px-2 py-1 text-[11px] font-bold text-st-on">
              Retry the commit
            </button>
          </div>
        ) : null}

        {preview.truncated ? (
          <p className="flex items-start gap-2 rounded-lg bg-st-primary-fixed/50 px-3 py-2 text-[10px] leading-relaxed text-st-on-primary-fixed-variant">
            <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            The file exceeded 5,000 rows, so only the first 5,000 were read. Split the export and import the
            remainder separately — this batch will never silently drop the rest.
          </p>
        ) : null}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            label="Total parsed"
            value={total}
            unit="rows"
            icon={FileSpreadsheet}
            tone="bg-st-high text-st-on-variant"
            hint={`${staged.fileSize ? `${Math.max(1, Math.round(staged.fileSize / 1024))} KB · ` : ''}${(preview.months || []).join(', ') || 'no months resolved'}`}
            accent="bg-st-outline"
            meter={100}
          />
          <KpiCard
            label="Ready to commit"
            value={freshCount}
            unit="rows"
            icon={CheckCircle2}
            tone="bg-st-secondary-container text-st-on-secondary-container"
            hint={`${cleanPct}% of the file satisfies every rule${alreadyCount ? ` · ${alreadyCount} already in the ledger` : ''}`}
            accent="bg-st-secondary"
            meter={cleanPct}
          />
          <KpiCard
            label="Conflicts detected"
            value={invalidRows.length}
            unit="rows"
            icon={TriangleAlert}
            tone="bg-st-error-container text-st-on-error-container"
            hint={`${flaggedPct}% flagged · ${groups.length} distinct reason${groups.length === 1 ? '' : 's'}`}
            accent="bg-st-error"
            meter={flaggedPct}
          />
          <KpiCard
            label="Impacted staff"
            value={impactedStaff}
            unit="employees"
            icon={Hash}
            tone="bg-st-primary-fixed text-st-on-primary-fixed-variant"
            hint="Distinct employee codes across valid and rejected rows"
            accent="bg-st-primary-container"
            meter={100}
          />
        </div>

        {/* provenance strip — the mock's "telemetry diff comparator" */}
        <section className="flex flex-col gap-2 rounded-xl bg-st-low px-4 py-2.5 shadow-sm lg:flex-row lg:items-center">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-st-on">
            <Fingerprint className="h-3.5 w-3.5 text-st-outline" aria-hidden="true" /> File fingerprint
          </span>
          <code className="break-all rounded bg-st-lowest px-2 py-1 font-mono text-[9px] text-st-on-variant">
            sha-256 · {preview.fingerprint || '—'}
          </code>
          <span className="inline-flex items-center gap-1 text-[10px] text-st-on-variant">
            <Globe2 className="h-3 w-3" aria-hidden="true" /> session day resolved in {preview.timeZone}
          </span>
          <span className="text-[10px] text-st-on-variant">
            {preview.months?.length ? `touches ${preview.months.join(', ')}` : 'touches no month'}
          </span>
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-st-secondary-container px-2 py-0.5 text-[9px] font-bold text-st-on-secondary-container">
            <BadgeCheck className="h-2.5 w-2.5" aria-hidden="true" /> identity of the file, not of a device
          </span>
        </section>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          {/* ── valid rows ─────────────────────────────────────────── */}
          <section className="overflow-hidden rounded-xl bg-st-lowest shadow-sm">
            <div className="flex flex-wrap items-center gap-2 px-4 py-3">
              <h2 className="flex items-center gap-1.5 text-sm font-bold text-st-on">
                <span aria-hidden="true" className="h-2 w-2 rounded-full bg-st-secondary" />
                Valid rows
              </h2>
              <span className={`${PILL} bg-st-secondary-container text-st-on-secondary-container`}>
                {validRows.length} record{validRows.length === 1 ? '' : 's'}
              </span>
              <label className="relative ml-auto">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-st-outline" aria-hidden="true" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  maxLength={60}
                  placeholder="Filter employee…"
                  className="w-40 rounded-lg bg-st-low py-1.5 pl-7 pr-2 text-[10px] text-st-on placeholder:text-st-on-variant/60 focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                  aria-label="Filter valid rows"
                />
              </label>
            </div>

            <div className="overflow-x-auto border-t border-st-high/60">
              <table className="w-full min-w-[34rem] text-left">
                <thead>
                  <tr className="bg-st-container text-[9px] font-bold uppercase tracking-wider text-st-on-variant">
                    <th className="py-2 pl-4 pr-2 font-bold">Line</th>
                    <th className="px-2 py-2 font-bold">Employee</th>
                    <th className="px-2 py-2 font-bold">Event type</th>
                    <th className="px-2 py-2 font-bold">Timestamp</th>
                    <th className="py-2 pl-2 pr-4 font-bold">Mode</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleValid.map((row) => (
                    <tr key={row.line} className="border-b border-st-high/50 hover:bg-st-low">
                      <td className="py-2 pl-4 pr-2 text-[10px] tabular-nums text-st-on-variant">#{row.line}</td>
                      <td className="px-2 py-2">
                        <span className="block text-[11px] font-bold text-st-on">
                          {row.name || row.employeeCode}
                        </span>
                        <span className="block font-mono text-[9px] text-st-on-variant">{row.employeeCode}</span>
                      </td>
                      <td className="px-2 py-2">
                        <span className={`${PILL} ${EVENT_TONE[row.eventType] || 'bg-st-high text-st-on-variant'}`}>
                          {String(row.eventType || '').replace('_', ' ')}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-[10px] leading-tight text-st-on">
                        {fmtDate(row.occurredAt)}
                        <span className="block text-st-on-variant">{fmtClock(row.occurredAt)}</span>
                      </td>
                      <td className="py-2 pl-2 pr-4 text-[10px] text-st-on-variant">
                        {row.workMode || '—'}
                        {row.alreadyRecorded ? (
                          <span className="block text-[9px] text-st-primary">already recorded</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  {!visibleValid.length ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-[11px] text-st-on-variant">
                        {validRows.length ? 'No valid row matches that filter.' : 'No row in this file passed validation.'}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between border-t border-st-high/60 px-4 py-2 text-[10px] text-st-on-variant">
              <span>
                Showing {visibleValid.length} of {filteredValid.length} valid row{filteredValid.length === 1 ? '' : 's'}
              </span>
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  className="rounded bg-st-low p-1.5 transition hover:text-st-on disabled:opacity-40"
                  disabled={safeValidPage <= 1}
                  onClick={() => setValidPage((value) => Math.max(1, value - 1))}
                  aria-label="Previous valid rows page"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="px-1 text-st-on">Page {safeValidPage} of {validPages}</span>
                <button
                  type="button"
                  className="rounded bg-st-low p-1.5 transition hover:text-st-on disabled:opacity-40"
                  disabled={safeValidPage >= validPages}
                  onClick={() => setValidPage((value) => value + 1)}
                  aria-label="Next valid rows page"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
          </section>

          {/* ── rejected rows & conflicts ──────────────────────────── */}
          <section className="flex flex-col overflow-hidden rounded-xl bg-st-low p-3.5 shadow-sm">
            <div className="flex flex-wrap items-start gap-2">
              <span aria-hidden="true" className="mt-1 h-2 w-2 shrink-0 rounded-full bg-st-error" />
              <div className="min-w-0">
                <h2 className="text-sm font-bold text-st-on">
                  Rejected rows &amp; conflicts{' '}
                  <span className={`${PILL} bg-st-error-container text-st-on-error-container`}>{invalidRows.length}</span>
                </h2>
                <p className="text-[10px] leading-snug text-st-on-variant">
                  Rows conflicting with recorded events or schema rules. Each card names the validator’s own
                  reason — nothing is routed anywhere without an endpoint.
                </p>
              </div>
            </div>

            {groups.length ? (
              <div className="mt-2 flex flex-wrap gap-1">
                <button
                  type="button"
                  onClick={() => setMessageFilter('')}
                  aria-pressed={!messageFilter}
                  className={`rounded-full px-2 py-0.5 text-[9px] font-bold transition ${
                    messageFilter ? 'bg-st-lowest text-st-on-variant hover:text-st-on' : 'bg-st-primary-container text-st-on-primary-container'
                  }`}
                >
                  All reasons ({invalidRows.length})
                </button>
                {groups.map(([message, count]) => (
                  <button
                    key={message}
                    type="button"
                    onClick={() => setMessageFilter(messageFilter === message ? '' : message)}
                    aria-pressed={messageFilter === message}
                    title={message}
                    className={`max-w-[16rem] truncate rounded-full px-2 py-0.5 text-[9px] font-bold transition ${
                      messageFilter === message
                        ? 'bg-st-primary-container text-st-on-primary-container'
                        : 'bg-st-lowest text-st-on-variant hover:text-st-on'
                    }`}
                  >
                    {message} ({count})
                  </button>
                ))}
              </div>
            ) : (
              <p className="mt-2 rounded-lg bg-st-secondary-container/60 px-2.5 py-2 text-[10px] font-semibold text-st-on-secondary-container">
                Every row in this file passed validation — the commit will take all {validRows.length}.
              </p>
            )}

            <ul className="mt-2 flex-1 space-y-2 overflow-y-auto pr-0.5" style={{ maxHeight: '38rem' }}>
              {visibleInvalid.map((row) => (
                <li key={`${row.line}-${row.message}`} className="relative overflow-hidden rounded-lg bg-st-lowest p-2.5 shadow-sm">
                  <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-st-error" />
                  <div className="flex items-center gap-1.5">
                    <span className="rounded bg-st-low px-1.5 py-0.5 font-mono text-[9px] font-bold text-st-on-variant">
                      Line {row.line}
                    </span>
                    <span className="truncate text-[11px] font-bold text-st-on">{row.employeeCode || 'unknown code'}</span>
                    <span className={`ml-auto shrink-0 ${PILL} bg-st-error-container text-st-on-error-container`}>
                      Rejected
                    </span>
                  </div>
                  <p className="mt-1 text-[10px] font-semibold leading-snug text-st-on">
                    {row.message || 'Row failed validation'}
                  </p>
                  <p className="mt-1 flex items-start gap-1 text-[9px] leading-snug text-st-on-variant">
                    <ArrowRight className="mt-0.5 h-2.5 w-2.5 shrink-0 text-st-primary" aria-hidden="true" />
                    {guidanceFor(row.message)}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <Link
                      to="/app/attendance/regularizations"
                      className="inline-flex items-center gap-1 rounded bg-st-low px-1.5 py-0.5 text-[9px] font-bold text-st-on transition hover:bg-st-container"
                    >
                      Exception centre
                    </Link>
                    <Link
                      to="/app/attendance/report"
                      className="inline-flex items-center gap-1 rounded bg-st-low px-1.5 py-0.5 text-[9px] font-bold text-st-on transition hover:bg-st-container"
                    >
                      Roster audit
                    </Link>
                    <span className="ml-auto inline-flex items-center gap-1 text-[9px] text-st-on-variant">
                      <Ban className="h-2.5 w-2.5" aria-hidden="true" /> will not be written
                    </span>
                  </div>
                </li>
              ))}
              {!visibleInvalid.length && invalidRows.length ? (
                <li className="rounded-lg border border-dashed border-st-high px-3 py-4 text-center text-[10px] text-st-on-variant">
                  No rejected row carries that reason.
                </li>
              ) : null}
            </ul>

            <div className="mt-2 flex items-center justify-between border-t border-st-high/60 pt-2 text-[10px] text-st-on-variant">
              <span>
                Showing {visibleInvalid.length} of {filteredInvalid.length} anomalous row{filteredInvalid.length === 1 ? '' : 's'}
              </span>
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  className="rounded bg-st-lowest p-1.5 transition hover:text-st-on disabled:opacity-40"
                  disabled={safeConflictPage <= 1}
                  onClick={() => setConflictPage((value) => Math.max(1, value - 1))}
                  aria-label="Previous conflict page"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="px-1 text-st-on">Page {safeConflictPage} of {conflictPages}</span>
                <button
                  type="button"
                  className="rounded bg-st-lowest p-1.5 transition hover:text-st-on disabled:opacity-40"
                  disabled={safeConflictPage >= conflictPages}
                  onClick={() => setConflictPage((value) => value + 1)}
                  aria-label="Next conflict page"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
          </section>
        </div>

        {/* ── commit strip ─────────────────────────────────────────── */}
        <section className="flex flex-col gap-3 rounded-xl bg-st-lowest p-4 shadow-sm lg:flex-row lg:items-center">
          <div className="min-w-0">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={routeToQueue}
                onChange={(event) => setRouteToQueue(event.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 accent-[var(--color-st-primary)]"
              />
              <span className="text-[11px] font-bold text-st-on">
                Notify employees whose rows were rejected
                <span className="ml-1 text-[9px] font-semibold text-st-on-variant">(choice is not stored)</span>
              </span>
            </label>
            <p className="mt-1 pl-5 text-[10px] leading-snug text-st-on-variant">
              {routeToQueue
                ? 'There is no “route to exception queue” endpoint: a rejected row is simply not written. This note is a reminder for the HR operator, and the rejection log you can export is what employees are asked about.'
                : 'The rejection log is the only record of these rows — export it before you leave this screen.'}{' '}
              Committing {freshCount} new row{freshCount === 1 ? '' : 's'} updates attendance for{' '}
              {impactedStaff} employee{impactedStaff === 1 ? '' : 's'}; {invalidRows.length} row
              {invalidRows.length === 1 ? '' : 's'} stay out of the ledger.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
            <span className="text-[9px] font-mono text-st-on-variant">
              {String(preview.fingerprint || '').slice(0, 16)}…
            </span>
            <button
              type="button"
              onClick={exportRejections}
              disabled={!invalidRows.length}
              className="inline-flex items-center gap-1.5 rounded-lg bg-st-low px-3 py-2 text-[10px] font-bold text-st-on transition hover:bg-st-container disabled:opacity-50"
            >
              <Download className="h-3 w-3" aria-hidden="true" /> Save rejection log
            </button>
            <button
              type="button"
              onClick={commit}
              disabled={!validRows.length || busy === 'commit'}
              className="inline-flex items-center gap-1.5 rounded-lg bg-st-primary px-3 py-2 text-[10px] font-bold text-st-on-primary transition hover:opacity-95 disabled:opacity-50"
            >
              {busy === 'commit' ? (
                <>
                  <RefreshCw className="h-3 w-3 animate-spin" aria-hidden="true" />
                  {progress?.total ? `${progress.processed}/${progress.total} saved` : 'Committing…'}
                </>
              ) : (
                <>
                  <SkipForward className="h-3 w-3" aria-hidden="true" /> Execute commit ({freshCount} rows)
                </>
              )}
            </button>
          </div>
        </section>

        {busy === 'commit' && progress?.total ? (
          <div className="rounded-xl bg-st-low px-4 py-2.5 text-[10px] text-st-on-variant">
            Importing — {progress.processed} of {progress.total} rows saved. The commit is resumable: if this
            tab closes, pressing Confirm again continues from the last stored outcome.
          </div>
        ) : null}

        <p className="flex items-start gap-2 rounded-xl bg-st-low px-4 py-3 text-[10px] leading-relaxed text-st-on-variant">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-st-outline" aria-hidden="true" />
          <span>
            <strong className="font-semibold text-st-on">Staged, not saved.</strong> This preview is computed in
            memory and disappears with the tab: the API never stores the raw CSV, so a batch can only be
            reopened from the import ledger after it has been committed.
          </span>
        </p>
      </div>
    </div>
  );
};

export default AttendanceImportValidationPage;
