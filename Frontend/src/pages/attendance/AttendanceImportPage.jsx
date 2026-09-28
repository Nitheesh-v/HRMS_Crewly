import { useCallback, useEffect, useState } from 'react';
import {
  Download,
  FileUp,
  History,
  RefreshCw,
  Upload,
} from 'lucide-react';
import attendanceCaptureService from '../../services/attendanceCaptureService.js';
import usePermission from '../../hooks/usePermission.js';
import { notify } from '../../utils/notify.js';

// Phase 31.14 — CSV attendance import (HR/admin).
// UPLOAD → PARSE → PREVIEW → VALIDATE → CONFIRM → IMPORT. Preview
// computes without writing; confirm re-uploads the same file (the
// server re-validates and ingests VALID_ROWS_ONLY). Finalized
// months refuse rows with reopen guidance — there is no skip.

const PREVIEW_ROWS = 50;

const fmtInstant = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
};

const AttendanceImportPage = () => {
  const { hasPermission } = usePermission();
  const canManage = hasPermission('ATTENDANCE_CAPTURE_MANAGE');

  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(null);
  const [outcomeFilter, setOutcomeFilter] = useState('ALL');

  const loadHistory = useCallback(async () => {
    try {
      const res = await attendanceCaptureService.listImports();
      setHistory(res.data?.imports || []);
    } catch {
      setHistory([]);
    }
  }, []);

  useEffect(() => {
    if (canManage) loadHistory();
  }, [canManage, loadHistory]);

  if (!canManage) {
    return (
      <div className="p-6">
        <div className="rounded-xl border border-crewly-line bg-crewly-card p-6 text-crewly-dim">
          Attendance imports are run by HR. You don&apos;t have access to this page.
        </div>
      </div>
    );
  }

  const resetRun = () => {
    setPreview(null);
    setResult(null);
    setDetail(null);
    setProgress(null);
    /* 35.1 — nothing to report (failure state cleared) */
    /* 35.1 — nothing to report (failure state cleared) */
  };

  const handlePreview = async () => {
    if (!file) return;
    resetRun();
    setBusy('preview');
    try {
      const res = await attendanceCaptureService.previewImport(file);
      setPreview(res.data);
      notify.info('Preview ready — nothing was saved. Review, then confirm to import.');
    } catch (previewError) {
      notify.error(previewError?.message || 'Could not preview the file');
    } finally {
      setBusy('');
    }
  };

  /*
   * 35.7 — an import runs in CHUNKS on the server and each call is bounded by
   * its own time budget, so this loop is what finishes the job. It keeps
   * calling confirm until the server says the batch is done, showing progress
   * as it goes. Every row is idempotent server-side, so a retried or
   * duplicated call can only ever replay a row — never double-write it.
   */
  const MAX_CHUNK_CALLS = 400;
  const MAX_TRANSIENT_RETRIES = 2;

  const runConfirmChunks = async () => {
    let transientRetries = 0;

    for (let call = 0; call < MAX_CHUNK_CALLS; call += 1) {
      let response;
      try {
        response = await attendanceCaptureService.confirmImport(file);
      } catch (error) {
        // A timeout or a dropped connection is not a failed import: the
        // server keeps whatever it already stored, and the next call
        // continues from there.
        const transient = !error?.response;
        if (!transient || transientRetries >= MAX_TRANSIENT_RETRIES) throw error;
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

    throw new Error('The import is taking longer than expected — press Confirm to continue');
  };

  const handleConfirm = async () => {
    if (!file) return;
    setBusy('confirm');
    setProgress(null);
    /* 35.1 — nothing to report (failure state cleared) */
    try {
      const res = { data: await runConfirmChunks() };
      setResult(res.data);
      // Open on what failed, when something failed.
      setOutcomeFilter(Number(res.data?.rejectedCount || 0) > 0 ? 'REJECTED' : 'ALL');
      /*
       * 31.14 fix — this said `notify.error` for a SUCCESSFUL import, so a
       * working import reported itself in red. A duplicate replay is a
       * notice, not a failure: the stored result is what is on screen.
       */
      if (res.data?.duplicate) {
        notify.warning('This file was already imported — showing the stored result.');
      } else if (res.data?.rejectedCount) {
        notify.warning(
          `Imported ${res.data?.importedCount || 0} events — ${res.data.rejectedCount} row(s) could not be imported. See the result table for the reason.`
        );
      } else {
        notify.success(
          `Imported ${res.data?.importedCount || 0} events (${res.data?.skippedCount || 0} skipped).`
        );
      }
      await loadHistory();
    } catch (confirmError) {
      notify.error(confirmError?.message || 'Could not confirm the import');
    } finally {
      setBusy('');
    }
  };

  const handleDetail = async (importId) => {
    /* 35.1 — nothing to report (failure state cleared) */
    try {
      const res = await attendanceCaptureService.getImport(importId);
      const batch = res.data?.import || res.data;
      setDetail(batch);
      setOutcomeFilter(Number(batch?.rejectedCount || 0) > 0 ? 'REJECTED' : 'ALL');
    } catch (detailError) {
      notify.error(detailError?.message || 'Could not load the import');
    }
  };

  const outcomes = result?.outcomes || detail?.outcomes || [];

  /*
   * 31.14 fix — outcome rows were persisted without their status for every
   * batch confirmed before the model/schema was aligned, so an old history
   * entry renders a blank pill. Show the honest unknown instead.
   */
  const outcomeLabel = (status) => status || 'UNKNOWN';

  /*
   * 35.9 — "why did those rows fail?" must be one click, not a scroll hunt.
   * A 156-row result buried its failures in the middle of the table, so the
   * counts said 21 rejected and the reasons were effectively invisible. The
   * table now filters by outcome, and it OPENS on the failures when there are
   * any: after a confirm, the first thing on screen is what did not import.
   */
  const outcomeCounts = outcomes.reduce(
    (acc, outcome) => {
      const key = outcomeLabel(outcome.status);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    },
    { IMPORTED: 0, SKIPPED: 0, REJECTED: 0, UNKNOWN: 0 }
  );
  const visibleOutcomes =
    outcomeFilter === 'ALL'
      ? outcomes
      : outcomes.filter((outcome) => outcomeLabel(outcome.status) === outcomeFilter);

  /*
   * The reasons only exist here (the raw CSV is never persisted), so the
   * result is downloadable as a CSV the person can keep, mail, or attach to a
   * support question. Excel-friendly: UTF-8 BOM, quoted cells.
   */
  const downloadOutcomes = () => {
    const batchId = result?.id || detail?.id || 'import';
    const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const lines = [
      ['Line', 'Employee', 'Event', 'Outcome', 'Detail', 'At'].map(cell).join(','),
      ...outcomes.map((outcome) =>
        [
          outcome.line,
          outcome.employeeCode,
          outcome.eventType,
          outcomeLabel(outcome.status),
          outcome.message || '',
          outcome.at ? new Date(outcome.at).toISOString() : '',
        ]
          .map(cell)
          .join(',')
      ),
    ];
    const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `attendance-import-${batchId}-outcomes.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-crewly-ink">
            <FileUp className="h-5 w-5" /> Attendance Import
          </h1>
          <p className="mt-1 text-sm text-crewly-dim">
            Bulk-load device exports as attendance events. Up to 5,000 rows per file; only valid rows import.
          </p>
        </div>
        <button
          type="button"
          onClick={() => attendanceCaptureService.downloadTemplate()}
          className="inline-flex items-center gap-2 rounded-lg border border-crewly-line px-3 py-2 text-sm text-crewly-ink hover:bg-crewly-card"
        >
          <Download className="h-4 w-4" /> Template CSV
        </button>
      </div>


      <div className="rounded-xl border border-crewly-line bg-crewly-card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-crewly-line px-3 py-2 text-sm text-crewly-ink hover:bg-crewly-card">
            <Upload className="h-4 w-4" /> {file ? file.name : 'Choose CSV file'}
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(event) => {
                setFile(event.target.files?.[0] || null);
                resetRun();
              }}
            />
          </label>
          <button
            type="button"
            disabled={!file || !!busy}
            onClick={handlePreview}
            className="rounded-lg bg-crewly-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy === 'preview' ? 'Validating…' : 'Preview'}
          </button>
          {preview && (
            <button
              type="button"
              disabled={!preview.validCount || !!busy}
              onClick={handleConfirm}
              className="rounded-lg border border-green-500/50 bg-green-500/15 px-4 py-2 text-sm font-semibold text-green-200 disabled:opacity-50"
            >
              {busy === 'confirm'
                ? progress?.total
                  ? `Importing… ${progress.processed}/${progress.total}`
                  : 'Importing…'
                : `Confirm — import ${preview.validCount} rows`}
            </button>
          )}
        </div>
        <p className="mt-2 text-xs text-crewly-dim">
          Columns: employeeCode, timestamp (ISO with zone), eventType, workMode (CLOCK_IN only), sourceReference.
          Blank workMode means OFFICE. Finalized months refuse rows until reopened in Attendance Finalization.
        </p>
      </div>

      {preview && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-green-500/40 bg-green-500/5 p-4">
            <div className="text-sm font-semibold text-green-200">Valid rows — {preview.validCount}</div>
            <div className="mt-1 text-xs text-crewly-dim">
              Months: {(preview.months || []).join(', ') || '—'}
              {preview.truncated ? ' · File exceeded 5,000 rows — only the first 5,000 were read.' : ''}
            </div>
            <div className="mt-2 max-h-64 overflow-auto text-xs">
              <table className="w-full text-left">
                <thead className="sticky top-0 bg-crewly-card text-crewly-dim">
                  <tr><th className="px-2 py-1">Line</th><th className="px-2 py-1">Employee</th><th className="px-2 py-1">Event</th><th className="px-2 py-1">At</th></tr>
                </thead>
                <tbody>
                  {preview.valid.slice(0, PREVIEW_ROWS).map((row) => (
                    <tr key={row.line} className="border-t border-crewly-line text-crewly-ink">
                      <td className="px-2 py-1">{row.line}</td>
                      <td className="px-2 py-1">{row.employeeCode}</td>
                      <td className="px-2 py-1">{row.eventType}</td>
                      <td className="px-2 py-1">{fmtInstant(row.occurredAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.validCount > PREVIEW_ROWS && (
                <div className="px-2 py-1 text-crewly-dim">Showing {PREVIEW_ROWS} of {preview.validCount}…</div>
              )}
            </div>
          </div>
          <div className="rounded-xl border border-crewly-red/40 bg-crewly-red/5 p-4">
            <div className="text-sm font-semibold text-crewly-red">Rejected rows — {preview.invalidCount}</div>
            <div className="mt-2 max-h-64 overflow-auto text-xs">
              {preview.invalidCount === 0 && <div className="px-2 py-1 text-crewly-dim">None — clean file.</div>}
              <table className="w-full text-left">
                <tbody>
                  {preview.invalid.slice(0, PREVIEW_ROWS).map((row) => (
                    <tr key={row.line} className="border-t border-crewly-line">
                      <td className="px-2 py-1 text-crewly-ink">L{row.line} · {row.employeeCode}</td>
                      <td className="px-2 py-1 text-crewly-red">{row.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.invalidCount > PREVIEW_ROWS && (
                <div className="px-2 py-1 text-crewly-dim">Showing {PREVIEW_ROWS} of {preview.invalidCount}…</div>
              )}
            </div>
          </div>
        </div>
      )}

      {busy === 'confirm' && progress?.total ? (
        <div className="rounded-xl border border-crewly-line bg-crewly-card px-4 py-3 text-sm text-crewly-dim">
          Importing — {progress.processed} of {progress.total} rows saved. Keep this tab open; the
          import continues in the background and can be resumed with Confirm if it is interrupted.
        </div>
      ) : null}

      {outcomes.length > 0 && (
        <div className="rounded-xl border border-crewly-line p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold text-crewly-ink">
              {/* 35.6 — a count that was never stored prints as a number, never as a dangling word */}
              {result ? 'Import result' : `Batch ${detail?.id || ''}`} —{' '}
              {result?.importedCount ?? detail?.importedCount ?? 0} imported,{' '}
              {result?.skippedCount ?? detail?.skippedCount ?? 0} skipped,{' '}
              {result?.rejectedCount ?? detail?.rejectedCount ?? 0} rejected
            </div>
            <button
              type="button"
              onClick={downloadOutcomes}
              className="inline-flex items-center gap-1 rounded-lg border border-crewly-line px-2 py-1 text-xs text-crewly-ink hover:bg-crewly-card"
            >
              <Download className="h-3.5 w-3.5" /> Download results CSV
            </button>
          </div>

          {/* 35.9 — every reason is one click away, never a scroll hunt */}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            {['ALL', 'REJECTED', 'IMPORTED', 'SKIPPED', 'UNKNOWN']
              .filter((key) => key === 'ALL' || outcomeCounts[key] > 0)
              .map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setOutcomeFilter(key)}
                  className={`rounded-full border px-2 py-0.5 ${
                    outcomeFilter === key
                      ? 'border-crewly-accent text-crewly-accent'
                      : 'border-crewly-line text-crewly-dim hover:bg-crewly-card'
                  }`}
                >
                  {key === 'ALL' ? `All ${outcomes.length}` : `${key} ${outcomeCounts[key]}`}
                </button>
              ))}
            {outcomeFilter !== 'ALL' && (
              <span className="text-crewly-dim">
                showing {visibleOutcomes.length} of {outcomes.length}
              </span>
            )}
          </div>

          <div className="mt-2 max-h-72 overflow-auto text-xs">
            <table className="w-full text-left">
              <thead className="sticky top-0 bg-crewly-card text-crewly-dim">
                <tr><th className="px-2 py-1">Line</th><th className="px-2 py-1">Employee</th><th className="px-2 py-1">Outcome</th><th className="px-2 py-1">Detail</th></tr>
              </thead>
              <tbody>
                {visibleOutcomes.map((outcome) => (
                  <tr key={outcome.line} className="border-t border-crewly-line text-crewly-ink">
                    <td className="px-2 py-1">{outcome.line}</td>
                    <td className="px-2 py-1">{outcome.employeeCode}</td>
                    <td className="px-2 py-1">
                      <span className={`rounded-full px-2 py-0.5 ${
                        outcome.status === 'IMPORTED' ? 'bg-green-500/15 text-green-300'
                          : outcome.status === 'SKIPPED' ? 'bg-blue-400/15 text-blue-300'
                            : 'bg-crewly-red/15 text-crewly-red'
                      }`}>
                        {outcomeLabel(outcome.status)}
                      </span>
                    </td>
                    <td className="px-2 py-1 text-crewly-dim">{outcome.message || `${outcome.eventType || ''} ${outcome.at ? fmtInstant(outcome.at) : ''}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-crewly-line">
        <div className="flex items-center justify-between border-b border-crewly-line px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-crewly-ink">
            <History className="h-4 w-4" /> Import history
          </div>
          <button
            type="button"
            onClick={loadHistory}
            className="inline-flex items-center gap-1 rounded-lg border border-crewly-line px-2 py-1 text-xs text-crewly-ink hover:bg-crewly-card"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
        {history.length === 0 && <div className="px-4 py-6 text-center text-sm text-crewly-dim">No imports yet.</div>}
        {history.map((batch) => (
          <button
            key={batch.id}
            type="button"
            onClick={() => handleDetail(batch.id)}
            className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 border-b border-crewly-line px-4 py-3 text-left text-sm last:border-0 hover:bg-crewly-card"
          >
            <span className="font-medium text-crewly-ink">{batch.sourceLabel || batch.fingerprint.slice(0, 12)}</span>
            <span className="text-crewly-dim">{(batch.months || []).join(', ')}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs ${batch.status === 'CONFIRMED' ? 'bg-green-500/15 text-green-300' : 'bg-crewly-orange/15 text-crewly-orange'}`}>
              {batch.status}
            </span>
            <span className="text-crewly-dim">
              {batch.importedCount || 0} imported · {batch.skippedCount || 0} skipped ·{' '}
              {batch.rejectedCount || 0} rejected
            </span>
            <span className="ml-auto text-xs text-crewly-dim">{fmtInstant(batch.confirmedAt || batch.createdAt)}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

export default AttendanceImportPage;
