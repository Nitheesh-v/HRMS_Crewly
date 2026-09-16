import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileUp,
  History,
  RefreshCw,
  Upload,
} from 'lucide-react';
import attendanceCaptureService from '../../services/attendanceCaptureService.js';
import usePermission from '../../hooks/usePermission.js';

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
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

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
    setError('');
    setNotice('');
  };

  const handlePreview = async () => {
    if (!file) return;
    resetRun();
    setBusy('preview');
    try {
      const res = await attendanceCaptureService.previewImport(file);
      setPreview(res.data);
      setNotice('Preview ready — nothing was saved. Review, then confirm to import.');
    } catch (previewError) {
      setError(previewError?.message || 'Could not preview the file');
    } finally {
      setBusy('');
    }
  };

  const handleConfirm = async () => {
    if (!file) return;
    setBusy('confirm');
    setError('');
    try {
      const res = await attendanceCaptureService.confirmImport(file);
      setResult(res.data);
      setNotice(
        res.data?.duplicate
          ? 'This file was already imported — showing the stored result.'
          : `Imported ${res.data?.importedCount || 0} events (${res.data?.skippedCount || 0} skipped, ${res.data?.rejectedCount || 0} rejected).`
      );
      await loadHistory();
    } catch (confirmError) {
      setError(confirmError?.message || 'Could not confirm the import');
    } finally {
      setBusy('');
    }
  };

  const handleDetail = async (importId) => {
    setError('');
    try {
      const res = await attendanceCaptureService.getImport(importId);
      setDetail(res.data?.import || res.data);
    } catch (detailError) {
      setError(detailError?.message || 'Could not load the import');
    }
  };

  const outcomes = result?.outcomes || detail?.outcomes || [];

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

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-crewly-red/40 bg-crewly-red/10 p-4 text-sm text-crewly-red">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 rounded-xl border border-green-500/40 bg-green-500/10 p-4 text-sm text-green-300">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> {notice}
        </div>
      )}

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
              {busy === 'confirm' ? 'Importing…' : `Confirm — import ${preview.validCount} rows`}
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

      {outcomes.length > 0 && (
        <div className="rounded-xl border border-crewly-line p-4">
          <div className="text-sm font-semibold text-crewly-ink">
            {result ? 'Import result' : `Batch ${detail?.id || ''}`} — {result?.importedCount ?? detail?.importedCount} imported,{' '}
            {result?.skippedCount ?? detail?.skippedCount} skipped, {result?.rejectedCount ?? detail?.rejectedCount} rejected
          </div>
          <div className="mt-2 max-h-72 overflow-auto text-xs">
            <table className="w-full text-left">
              <thead className="sticky top-0 bg-crewly-card text-crewly-dim">
                <tr><th className="px-2 py-1">Line</th><th className="px-2 py-1">Employee</th><th className="px-2 py-1">Outcome</th><th className="px-2 py-1">Detail</th></tr>
              </thead>
              <tbody>
                {outcomes.map((outcome) => (
                  <tr key={outcome.line} className="border-t border-crewly-line text-crewly-ink">
                    <td className="px-2 py-1">{outcome.line}</td>
                    <td className="px-2 py-1">{outcome.employeeCode}</td>
                    <td className="px-2 py-1">
                      <span className={`rounded-full px-2 py-0.5 ${
                        outcome.status === 'IMPORTED' ? 'bg-green-500/15 text-green-300'
                          : outcome.status === 'SKIPPED' ? 'bg-blue-400/15 text-blue-300'
                            : 'bg-crewly-red/15 text-crewly-red'
                      }`}>
                        {outcome.status}
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
              {batch.importedCount} imported · {batch.skippedCount} skipped · {batch.rejectedCount} rejected
            </span>
            <span className="ml-auto text-xs text-crewly-dim">{fmtInstant(batch.confirmedAt || batch.createdAt)}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

export default AttendanceImportPage;
