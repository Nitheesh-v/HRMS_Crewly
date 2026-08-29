import { useCallback, useEffect, useState } from "react";
import {
  RefreshCw,
  AlertTriangle,
  Trash2,
  RotateCcw,
  Play,
  Eye,
  Database,
  Activity,
  Server,
  Inbox,
  Pause,
  X,
} from "lucide-react";
import useAuth from "../../hooks/useAuth.jsx";
import superAdminService from "../../services/superAdminService.js";

// ============================================================
// 28.8 — Background Operations (Super Admin)
//
// Platform tooling for queue / worker / cache visibility.
// Read-only for PLATFORM_ADMIN; mutating actions (retry,
// remove, pause, reconcile run, cache invalidation) are
// Super Admin only — the backend enforces the same policy.
//
// Metadata only: queue names, job ids/types, states, attempts,
// safe failure categories, redacted references. No candidate
// PII, no job payloads, no raw stack traces — the backend
// serializer guarantees this.
// ============================================================

const panel =
  "rounded-xl border border-slate-800 bg-slate-900/60 p-5";

const RECONCILE_LABELS = {
  email: "Email deliveries",
  resume: "Resume parsing",
  ats: "ATS matching",
  scheduled: "Scheduled reminders & offer expiry",
  documents: "Document processing",
  bgv: "Background verification",
};

// ---- Human ages (frontend-side, per spec) -------------------

const formatAgeLong = (ms) => {
  if (ms === null || ms === undefined) return "—";
  const n = Math.max(0, Math.trunc(ms));
  if (n < 15000) return "a few seconds";
  if (n < 60000) return `${Math.round(n / 1000)} seconds`;
  if (n < 3600000) return `${Math.round(n / 60000)} minutes`;
  if (n < 86400000) return `${Math.round(n / 3600000)} hours`;
  return `${Math.round(n / 86400000)} days`;
};

const formatAgeShort = (ms) => {
  if (ms === null || ms === undefined) return "—";
  const n = Math.max(0, Math.trunc(ms));
  if (n < 15000) return "now";
  if (n < 60000) return `${Math.round(n / 1000)}s`;
  if (n < 3600000) return `${Math.round(n / 60000)}m`;
  if (n < 86400000) return `${Math.round(n / 3600000)}h`;
  return `${Math.round(n / 86400000)}d`;
};

const shortId = (id) =>
  String(id || "").length > 20 ? `…${String(id).slice(-10)}` : String(id || "—");

// ---- Status pills -------------------------------------------

const statusStyles = {
  HEALTHY: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  WARNING: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  CRITICAL: "bg-red-500/15 text-red-300 border-red-500/40",
  ONLINE: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  SHUTTING_DOWN: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  OFFLINE: "bg-slate-700/40 text-slate-300 border-slate-600",
  up: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  down: "bg-red-500/15 text-red-300 border-red-500/40",
  disabled: "bg-slate-700/40 text-slate-300 border-slate-600",
};

const Pill = ({ kind, children }) => (
  <span
    className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
      statusStyles[kind] || statusStyles.OFFLINE
    }`}
  >
    {children}
  </span>
);

// ---- Confirmation modal -------------------------------------

const ConfirmModal = ({ state, busy, onConfirm, onClose }) => {
  if (!state) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            {state.danger ? (
              <AlertTriangle className="h-5 w-5 text-amber-400" />
            ) : (
              <RotateCcw className="h-5 w-5 text-cyan-400" />
            )}
            <h3 className="text-base font-bold text-white">{state.title}</h3>
          </div>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-white"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-3 space-y-1 text-sm text-slate-300">
          {state.lines.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className={`rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 ${
              state.danger ? "bg-amber-600 hover:bg-amber-500" : "bg-cyan-600 hover:bg-cyan-500"
            }`}
          >
            {busy ? "Working…" : state.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

// ---- Page ----------------------------------------------------

export default function SuperAdminBackgroundOperationsPage() {
  const { user } = useAuth();
  const canManage = user?.role === "SUPER_ADMIN";

  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const [selectedQueue, setSelectedQueue] = useState(null);
  const [failed, setFailed] = useState({ rows: [], meta: { page: 1, pages: 1, total: 0 } });
  const [failedLoading, setFailedLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);

  const [detail, setDetail] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);

  const [reconcileAreas, setReconcileAreas] = useState([]);
  const [reconcileLimits, setReconcileLimits] = useState({});
  const [reconcileResult, setReconcileResult] = useState({});
  const [allLimit, setAllLimit] = useState(25);

  const [cache, setCache] = useState(null);
  const [cacheCompanyId, setCacheCompanyId] = useState("");

  const flash = (message) => {
    setToast(message);
    setTimeout(() => setToast(""), 4000);
  };

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await superAdminService.opsOverview();
      setOverview(data?.data ?? data);
    } catch (e) {
      setError(e?.message || "Could not load the operations overview");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadFailed = useCallback(async (queueName, page = 1) => {
    if (!queueName) return;
    setFailedLoading(true);
    try {
      const data = await superAdminService.opsFailedJobs(queueName, { page, limit: 25 });
      const src = data?.data ?? data ?? {};
      setFailed({ rows: src.rows || [], meta: src.meta || { page: 1, pages: 1, total: 0 } });
      setSelectedIds([]);
    } catch (e) {
      flash(e?.message || "Could not load failed jobs");
    } finally {
      setFailedLoading(false);
    }
  }, []);

  const loadReconcilePreview = useCallback(async () => {
    try {
      const data = await superAdminService.opsReconcilePreview();
      const src = data?.data ?? data ?? {};
      setReconcileAreas(src.areas || []);
    } catch {
      setReconcileAreas([]);
    }
  }, []);

  const loadCache = useCallback(async () => {
    try {
      const data = await superAdminService.opsCacheStatus();
      setCache(data?.data ?? data ?? null);
    } catch {
      setCache(null);
    }
  }, []);

  useEffect(() => {
    loadOverview();
    loadReconcilePreview();
    loadCache();
  }, [loadOverview, loadReconcilePreview, loadCache]);

  const refresh = () => {
    loadOverview();
    loadReconcilePreview();
    loadCache();
    if (selectedQueue) loadFailed(selectedQueue, failed.meta.page);
  };

  const selectQueue = (name) => {
    if (name === selectedQueue) return;
    setSelectedQueue(name);
    loadFailed(name, 1);
  };

  const toggleSelect = (jobId) => {
    setSelectedIds((prev) =>
      prev.includes(jobId) ? prev.filter((id) => id !== jobId) : [...prev, jobId]
    );
  };

  const runConfirm = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      await confirm.action();
      flash(confirm.successMessage || "Done");
      setConfirm(null);
    } catch (e) {
      const reason = e?.response?.data?.data?.reason || e?.message || "Action failed";
      flash(reason);
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  const askRetry = (job) => {
    if (!job.retryable) {
      flash(`Not retryable: ${job.retryReason}`);
      return;
    }
    setConfirm({
      title: "Retry this job?",
      danger: false,
      confirmLabel: "Retry job",
      lines: [
        `Job ${shortId(job.jobId)} (${job.name}) in queue "${job.queue}".`,
        "The same job is re-queued — nothing is reconstructed.",
      ],
      successMessage: "Job retry requested",
      action: async () => {
        await superAdminService.opsRetryJob(job.queue, job.jobId);
        loadFailed(job.queue, failed.meta.page);
        loadOverview();
      },
    });
  };

  const askBatchRetry = () => {
    if (selectedIds.length === 0) return;
    setConfirm({
      title: `Retry ${selectedIds.length} failed jobs?`,
      danger: false,
      confirmLabel: "Retry selected",
      lines: [
        `Queue "${selectedQueue}".`,
        "Non-retryable jobs are skipped with a safe reason (no force option exists).",
      ],
      successMessage: "Batch retry completed",
      action: async () => {
        await superAdminService.opsBatchRetry(selectedQueue, selectedIds);
        loadFailed(selectedQueue, failed.meta.page);
        loadOverview();
      },
    });
  };

  const askRemove = (job) => {
    setConfirm({
      title: "Remove this job?",
      danger: true,
      confirmLabel: "Remove job",
      lines: [
        `Job ${shortId(job.jobId)} (${job.name}), state: ${job.state}.`,
        "This deletes the job record from the queue only — no business data is touched.",
        "Only failed/completed jobs can be removed; the backend re-checks the state.",
      ],
      successMessage: "Job removed",
      action: async () => {
        await superAdminService.opsRemoveJob(job.queue, job.jobId);
        loadFailed(job.queue, failed.meta.page);
        loadOverview();
      },
    });
  };

  const askPauseResume = (queueRow, pause) => {
    setConfirm({
      title: pause ? `Pause queue "${queueRow.name}"?` : `Resume queue "${queueRow.name}"?`,
      danger: true,
      confirmLabel: pause ? "Pause queue" : "Resume queue",
      lines: [
        pause
          ? "Workers keep running but this queue stops picking up jobs until resumed. Use it to stop a noisy queue; it does not cancel anything."
          : "The queue will start processing waiting jobs again.",
      ],
      successMessage: pause ? "Queue paused" : "Queue resumed",
      action: async () => {
        if (pause) await superAdminService.opsPauseQueue(queueRow.name);
        else await superAdminService.opsResumeQueue(queueRow.name);
        loadOverview();
      },
    });
  };

  const askReconcile = (area) => {
    const limit = Math.min(100, Math.max(1, Number(reconcileLimits[area]) || 25));
    setConfirm({
      title: `Run recovery: ${RECONCILE_LABELS[area] || area}?`,
      danger: false,
      confirmLabel: "Run recovery",
      lines: [
        `Re-derives missing background jobs from Mongo intent (bounded to ${limit} items).`,
        "Idempotent: deterministic job ids — running it twice never duplicates work.",
      ],
      successMessage: "Recovery run completed",
      action: async () => {
        const data = await superAdminService.opsReconcileRun(area, limit);
        const src = data?.data ?? data ?? {};
        setReconcileResult((prev) => ({ ...prev, [area]: src }));
        loadReconcilePreview();
      },
    });
  };

  const askReconcileAll = () => {
    const limit = Math.min(100, Math.max(1, Number(allLimit) || 25));
    setConfirm({
      title: "Run recovery for ALL domains?",
      danger: false,
      confirmLabel: "Run all",
      lines: [
        `Email, Resume, ATS, Scheduled, Documents and BGV — each bounded to ${limit} items.`,
        "Runs sequentially; one failing domain does not stop the others.",
        "Idempotent: deterministic job ids — running it twice never duplicates work.",
      ],
      successMessage: "Recovery run completed for all domains",
      action: async () => {
        const data = await superAdminService.opsReconcileRun("all", limit);
        const src = data?.data ?? data ?? {};
        const byArea = {};
        for (const d of src.domains || []) byArea[d.area] = d;
        setReconcileResult((prev) => ({ ...prev, ...byArea }));
        loadReconcilePreview();
      },
    });
  };

  const askInvalidateCache = () => {
    setConfirm({
      title: "Invalidate analytics cache for this company?",
      danger: false,
      confirmLabel: "Invalidate",
      lines: [
        `Company ${shortId(cacheCompanyId)}`,
        "Bumps the analytics generation — the next analytics read rebuilds fresh. Other companies are untouched.",
      ],
      successMessage: "Analytics cache invalidated",
      action: async () => {
        await superAdminService.opsInvalidateCache(cacheCompanyId.trim());
        loadCache();
        setCacheCompanyId("");
      },
    });
  };

  const askViewDetail = async (job) => {
    try {
      const data = await superAdminService.opsJobDetail(job.queue, job.jobId);
      setDetail(data?.data ?? data ?? job);
    } catch (e) {
      flash(e?.message || "Could not load the job detail");
    }
  };

  // ---- Render -------------------------------------------------

  const queues = Array.isArray(overview?.queues) ? overview.queues : [];
  const workers = overview?.workers;
  const redis = overview?.redis;
  const degraded = overview?.queues === "unavailable";

  return (
    <div className="space-y-5 p-4 md:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-black text-white">Background Operations</h1>
          <p className="text-xs text-slate-400">
            Queues, workers and cache — metadata only. No job payloads are ever shown.
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/60 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {!canManage && (
        <div className="rounded-lg border border-slate-700 bg-slate-800/40 px-4 py-2.5 text-xs text-slate-300">
          Your role can view this page. Retry, remove, pause, recovery runs and cache
          invalidation require the Super Admin role.
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {toast && (
        <div className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-100">
          {toast}
        </div>
      )}

      {/* Redis + Workers header */}
      <div className="grid gap-3 md:grid-cols-2">
        <div className={panel}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-slate-400">
              <Database className="h-4 w-4" />
              <span className="text-xs font-semibold uppercase tracking-wide">Redis</span>
            </div>
            {redis && <Pill kind={redis.state}>{String(redis.state).toUpperCase()}</Pill>}
          </div>
          <p className="mt-2 text-sm text-slate-300">
            {degraded
              ? `Queues unavailable (${redis?.reason || "Redis not reachable"})`
              : "Queues and jobs are reachable"}
          </p>
        </div>

        <div className={panel}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-slate-400">
              <Server className="h-4 w-4" />
              <span className="text-xs font-semibold uppercase tracking-wide">Workers</span>
            </div>
            {degraded ? (
              <Pill kind="OFFLINE">UNAVAILABLE</Pill>
            ) : (
              <Pill kind={workers?.online > 0 ? "ONLINE" : "OFFLINE"}>
                {workers?.online || 0} ONLINE
              </Pill>
            )}
          </div>
          <div className="mt-2 space-y-1">
            {degraded ? (
              <p className="text-sm text-slate-500">Worker state unavailable while Redis is down</p>
            ) : (workers?.workers?.length || 0) === 0 ? (
              <p className="text-sm text-slate-500">
                No worker heartbeats yet — start the worker process (npm run worker:dev)
              </p>
            ) : (
              workers.workers.slice(0, 5).map((w) => (
                <div key={w.workerId} className="flex items-center justify-between text-sm">
                  <span className="font-mono text-xs text-slate-400">
                    {w.workerId.slice(0, 14)}…
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-slate-500">
                      seen {formatAgeShort(w.lastSeenMs ? Date.now() - w.lastSeenMs : null)}
                    </span>
                    <Pill kind={w.status}>{w.status.replace("_", " ")}</Pill>
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Queue table */}
      <div className={panel}>
        <div className="mb-3 flex items-center gap-2 text-slate-400">
          <Inbox className="h-4 w-4" />
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-300">Queues</h2>
        </div>
        {degraded ? (
          <p className="text-sm text-slate-500">
            Queue counts unavailable — Redis is down or disabled.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-3">Queue</th>
                  <th className="py-2 pr-3">Waiting</th>
                  <th className="py-2 pr-3">Active</th>
                  <th className="py-2 pr-3">Delayed</th>
                  <th className="py-2 pr-3">Failed</th>
                  <th className="py-2 pr-3">Oldest Waiting</th>
                  <th className="py-2 pr-3">Status</th>
                  {canManage && <th className="py-2">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {queues.map((q) => (
                  <tr
                    key={q.name}
                    onClick={() => q.counts && selectQueue(q.name)}
                    className={`border-b border-slate-800/60 ${
                      q.counts ? "cursor-pointer hover:bg-slate-800/40" : ""
                    } ${selectedQueue === q.name ? "bg-slate-800/60" : ""}`}
                  >
                    <td className="py-2.5 pr-3">
                      <div className="font-semibold text-slate-200">{q.name}</div>
                      <div className="text-xs text-slate-500">{q.purpose}</div>
                    </td>
                    <td className="py-2.5 pr-3 text-slate-300">{q.counts?.waiting ?? "—"}</td>
                    <td className="py-2.5 pr-3 text-slate-300">{q.counts?.active ?? "—"}</td>
                    <td className="py-2.5 pr-3 text-slate-300">{q.counts?.delayed ?? "—"}</td>
                    <td className="py-2.5 pr-3">
                      <span
                        className={
                          q.counts?.failed > 0 ? "font-semibold text-amber-300" : "text-slate-300"
                        }
                      >
                        {q.counts?.failed ?? "—"}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-slate-300">
                      {q.counts?.waiting > 0 ? formatAgeLong(q.oldestWaitingMs) : "—"}
                    </td>
                    <td className="py-2.5 pr-3">
                      <div className="flex flex-col gap-1">
                        <Pill kind={q.health?.status}>{q.health?.status}</Pill>
                        {q.health?.reasons?.slice(0, 2).map((reason, i) => (
                          <span key={i} className="text-xs text-slate-400">
                            {reason}
                          </span>
                        ))}
                      </div>
                    </td>
                    {canManage && (
                      <td className="py-2.5" onClick={(e) => e.stopPropagation()}>
                        {q.counts && (
                          <button
                            onClick={() => askPauseResume(q, !q.paused)}
                            className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
                          >
                            {q.paused ? (
                              <>
                                <Play className="h-3.5 w-3.5" /> Resume
                              </>
                            ) : (
                              <>
                                <Pause className="h-3.5 w-3.5" /> Pause
                              </>
                            )}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Delayed jobs are scheduled one-time work, not an incident. Click a row to view its
          failed jobs.
        </p>
      </div>

      {/* Failed jobs */}
      {selectedQueue && !degraded && (
        <div className={panel}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-bold uppercase tracking-wide text-slate-300">
              Failed jobs — {selectedQueue}
            </h2>
            {canManage && selectedIds.length > 0 && (
              <button
                onClick={askBatchRetry}
                className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Retry selected ({selectedIds.length})
              </button>
            )}
          </div>
          {failedLoading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : failed.rows.length === 0 ? (
            <p className="text-sm text-slate-500">No failed jobs in this queue.</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                      {canManage && (
                        <th className="py-2 pr-2">
                          <input
                            type="checkbox"
                            aria-label="Select all"
                            checked={selectedIds.length === failed.rows.length}
                            onChange={(e) =>
                              setSelectedIds(
                                e.target.checked
                                  ? failed.rows.map((r) => r.jobId)
                                  : []
                              )
                            }
                            className="accent-cyan-500"
                          />
                        </th>
                      )}
                      <th className="py-2 pr-3">Job</th>
                      <th className="py-2 pr-3">Type</th>
                      <th className="py-2 pr-3">Category</th>
                      <th className="py-2 pr-3">Attempts</th>
                      <th className="py-2 pr-3">Failed</th>
                      <th className="py-2 pr-3">Company</th>
                      <th className="py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {failed.rows.map((job) => (
                      <tr key={job.jobId} className="border-b border-slate-800/60">
                        {canManage && (
                          <td className="py-2.5 pr-2">
                            <input
                              type="checkbox"
                              aria-label={`Select ${job.jobId}`}
                              checked={selectedIds.includes(job.jobId)}
                              onChange={() => toggleSelect(job.jobId)}
                              className="accent-cyan-500"
                            />
                          </td>
                        )}
                        <td className="py-2.5 pr-3 font-mono text-xs text-slate-300">
                          {shortId(job.jobId)}
                        </td>
                        <td className="py-2.5 pr-3 text-slate-300">{job.name}</td>
                        <td className="py-2.5 pr-3">
                          <span
                            className={`text-xs font-semibold ${
                              job.retryable ? "text-slate-300" : "text-amber-300"
                            }`}
                            title={job.retryReason}
                          >
                            {job.safeFailureCategory}
                          </span>
                        </td>
                        <td className="py-2.5 pr-3 text-slate-300">
                          {job.attemptsMade}/{job.maxAttempts || "∞"}
                        </td>
                        <td className="py-2.5 pr-3 text-slate-300">
                          {formatAgeLong(job.failedAt ? Date.now() - job.failedAt : null)}
                        </td>
                        <td className="py-2.5 pr-3 font-mono text-xs text-slate-400">
                          {job.tenantRef ? shortId(job.tenantRef) : "—"}
                        </td>
                        <td className="py-2.5">
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => askViewDetail(job)}
                              className="flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
                            >
                              <Eye className="h-3.5 w-3.5" /> View
                            </button>
                            {canManage && (
                              <>
                                <button
                                  onClick={() => askRetry(job)}
                                  disabled={!job.retryable}
                                  title={job.retryable ? "Retry this job" : job.retryReason}
                                  className="flex items-center gap-1 rounded-lg border border-cyan-600/50 px-2 py-1 text-xs text-cyan-300 hover:bg-cyan-600/20 disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  <RotateCcw className="h-3.5 w-3.5" /> Retry
                                </button>
                                <button
                                  onClick={() => askRemove(job)}
                                  className="flex items-center gap-1 rounded-lg border border-red-600/50 px-2 py-1 text-xs text-red-300 hover:bg-red-600/20"
                                >
                                  <Trash2 className="h-3.5 w-3.5" /> Remove
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
                <span>
                  Page {failed.meta.page} of {failed.meta.pages} — {failed.meta.total} failed
                  jobs (queue keeps the latest 500)
                </span>
                <div className="flex gap-1">
                  <button
                    disabled={failed.meta.page <= 1}
                    onClick={() => loadFailed(selectedQueue, failed.meta.page - 1)}
                    className="rounded-lg border border-slate-700 px-2.5 py-1 hover:bg-slate-800 disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <button
                    disabled={failed.meta.page >= failed.meta.pages}
                    onClick={() => loadFailed(selectedQueue, failed.meta.page + 1)}
                    className="rounded-lg border border-slate-700 px-2.5 py-1 hover:bg-slate-800 disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Recovery (reconciliation ops) */}
      <div className={panel}>
        <div className="mb-3 flex items-center gap-2 text-slate-400">
          <Activity className="h-4 w-4" />
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-300">
            Recovery — re-derive missing background jobs
          </h2>
        </div>
        <p className="mb-3 text-xs text-slate-500">
          Calls the existing reconciliation services. Preview shows how much work is stuck;
          each run is bounded (backend caps at 100 per domain) and idempotent.
        </p>
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2.5">
          <Play className="h-4 w-4 text-cyan-400" />
          <span className="text-sm text-slate-300">Recovery runbook (after an outage):</span>
          <span className="text-xs text-slate-500">
            restore Redis → start worker → preview → run
          </span>
          <span className="ml-auto flex items-center gap-2">
            <label className="text-xs text-slate-500" htmlFor="all-limit">
              up to per domain
            </label>
            <input
              id="all-limit"
              type="number"
              min="1"
              max="100"
              value={allLimit}
              onChange={(e) => setAllLimit(e.target.value)}
              className="w-20 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200"
            />
            <button
              onClick={askReconcileAll}
              disabled={!canManage}
              className="rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Run all (bounded)
            </button>
          </span>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {reconcileAreas.map((area) => {
            const result = reconcileResult[area.area];
            return (
              <div key={area.area} className="rounded-lg border border-slate-800 bg-slate-950/40 p-4">
                <div className="flex items-center justify-between">
                  <b className="text-sm text-slate-200">{area.label}</b>
                  {area.unavailable ? (
                    <span className="text-xs text-slate-500">preview unavailable</span>
                  ) : (
                    <span className="text-xs text-slate-400">
                      {area.eligible === null
                        ? "—"
                        : area.capped
                          ? `≥${area.eligible}`
                          : area.eligible}
                      {area.estimate ? " (estimate)" : ""} stuck
                    </span>
                  )}
                </div>
                {result ? (
                  <div
                    className={`mt-2 rounded-lg px-3 py-2 text-xs ${
                      result.error
                        ? "bg-amber-500/10 text-amber-200"
                        : "bg-slate-800/50 text-slate-300"
                    }`}
                  >
                    {result.error
                      ? `Last run: ${result.error}`
                      : `Last run: checked ${result.checked} · requeued ${result.requeued} · skipped ${result.skipped} · failed ${result.failed}`}
                  </div>
                ) : (
                  <div className="mt-3 flex items-center gap-2">
                    <label className="text-xs text-slate-500" htmlFor={`limit-${area.area}`}>
                      up to
                    </label>
                    <input
                      id={`limit-${area.area}`}
                      type="number"
                      min="1"
                      max="100"
                      defaultValue={25}
                      onChange={(e) =>
                        setReconcileLimits((prev) => ({ ...prev, [area.area]: e.target.value }))
                      }
                      className="w-20 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200"
                    />
                    <button
                      onClick={() => askReconcile(area.area)}
                      disabled={!canManage || area.unavailable}
                      className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Play className="h-3.5 w-3.5" /> Run
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {reconcileAreas.length === 0 && (
            <p className="text-sm text-slate-500">
              Could not load the recovery preview — refresh when services recover.
            </p>
          )}
        </div>
      </div>

      {/* Cache */}
      <div className={panel}>
        <div className="mb-3 flex items-center gap-2 text-slate-400">
          <Database className="h-4 w-4" />
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-300">
            Analytics cache
          </h2>
        </div>
        {cache ? (
          <>
            <div className="flex flex-wrap gap-2">
              <Pill kind={cache.enabled ? "ONLINE" : "OFFLINE"}>
                {cache.enabled ? "ENABLED" : "DISABLED"}
              </Pill>
              <Pill kind={cache.redis}>{String(cache.redis).toUpperCase()}</Pill>
              <span className="text-xs text-slate-400">
                TTL {cache.ttlSeconds}s · prefix {cache.keyPrefix}
              </span>
            </div>
            <div className="mt-3 grid gap-2 text-xs text-slate-400 md:grid-cols-3">
              <p>
                Hits {cache.stats?.hits ?? 0} · Misses {cache.stats?.misses ?? 0}
              </p>
              <p>
                Writes {cache.stats?.writes ?? 0} · Skipped {cache.stats?.writeSkips ?? 0}
              </p>
              <p>
                Invalidations {cache.stats?.invalidations ?? 0}
                {cache.stats?.lastEventAt
                  ? ` · last event ${formatAgeShort(Date.now() - cache.stats.lastEventAt)} ago`
                  : ""}
              </p>
            </div>
            <p className="mt-2 text-xs text-slate-600">
              Per-process counters only; no cache contents are ever shown.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={cacheCompanyId}
                onChange={(e) => setCacheCompanyId(e.target.value)}
                placeholder="Company id (24 hex characters)"
                className="w-72 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600"
              />
              <button
                onClick={askInvalidateCache}
                disabled={!canManage || !/^[a-f0-9]{24}$/i.test(cacheCompanyId.trim())}
                className="rounded-lg bg-cyan-600 px-3 py-2 text-xs font-semibold text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Invalidate for company
              </button>
            </div>
          </>
        ) : (
          <p className="text-sm text-slate-500">Cache status unavailable.</p>
        )}
      </div>

      {/* Job detail modal */}
      {detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-white">Job detail</h3>
              <button onClick={() => setDetail(null)} className="text-slate-500 hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </div>
            <dl className="mt-4 space-y-2 text-sm">
              {[
                ["Job ID", detail.jobId],
                ["Type", detail.name],
                ["Queue", detail.queue],
                ["State", detail.state],
                ["Category", detail.safeFailureCategory],
                ["Message", detail.message || "(none)"],
                [
                  "Attempts",
                  `${detail.attemptsMade} / ${detail.maxAttempts || "∞"}`,
                ],
                ["Created", detail.createdAt ? new Date(detail.createdAt).toLocaleString() : "—"],
                ["Failed", detail.failedAt ? new Date(detail.failedAt).toLocaleString() : "—"],
                [
                  "Entity",
                  detail.correlationRef
                    ? `${detail.correlationRef.type} ${shortId(detail.correlationRef.id)}`
                    : "—",
                ],
                ["Company", detail.tenantRef ? shortId(detail.tenantRef) : "—"],
                [
                  "Retryable",
                  detail.retryable ? "Yes" : `No — ${detail.retryReason}`,
                ],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-4">
                  <dt className="shrink-0 text-slate-500">{label}</dt>
                  <dd className="break-all text-right text-slate-200">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 text-xs text-slate-600">
              Metadata only — job payloads are never loaded or shown.
            </p>
          </div>
        </div>
      )}

      <ConfirmModal
        state={confirm}
        busy={busy}
        onConfirm={runConfirm}
        onClose={() => !busy && setConfirm(null)}
      />
    </div>
  );
}
