// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.6 — ADMIN AI USAGE DASHBOARD
//
// Shows a COMPANY_ADMIN how much of the monthly AI token budget their own
// company has spent this month, split by feature, by status, and by the people
// who spent the most.
//
// WHY THIS IS SAFE TO BUILD AT ALL.
//
//   AIUsageLog stores counters — feature, provider, model, token counts,
//   latency, status — and nothing else. It has no field that could hold a
//   prompt or a reply, so this dashboard cannot leak a conversation. The only
//   two human-readable fields it surfaces are `name` and `designation`, both
//   of which this admin already sees on the employee screen, and the token
//   count, which is the number the quota is made of.
//
// WHAT IT DELIBERATELY DOES NOT DO.
//
//   · It does not show prompts or replies. There are none to show.
//   · It does not let the admin change the quota. That lives in AI settings.
//   · It does not read another company's data. The company comes from the
//     caller's own token server-side; this page sends no identifiers at all.
//
// Shape follows SecuritySettingsPage.jsx: plain useState, one service module,
// no Redux. This page reads a handful of aggregate numbers — a slice and a
// store would be ceremony.
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useState } from 'react';

import {
  AlertTriangle,
  BarChart2,
  CreditCard,
  FileText,
  RefreshCw,
  TrendingUp,
  Users,
} from 'lucide-react';

import { getAiUsage } from '../../services/aiService.js';

const STATUS_LABELS = Object.freeze({
  SUCCESS: 'Successful calls',
  FAILED: 'Failed calls',
  REJECTED: 'Rejected before the vendor',
  UNKNOWN: 'Unlabelled',
});

const numberFormat = new Intl.NumberFormat('en-IN');

const formatNumber = (value) => numberFormat.format(Number(value) || 0);

/**
 * A month window rendered as a human range.
 *
 * The server sends ISO strings for the window it actually used, so what is on
 * screen is the same window the numbers were computed over — not a date range
 * this page guessed.
 */
const formatWindow = (start, end) => {
  if (!start || !end) return 'this month';

  const from = new Date(start);

  const to = new Date(end);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return 'this month';
  }

  const day = (date) =>
    date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

  return `${day(from)} \u2013 ${day(to)}`;
};

const SectionCard = ({ icon: Icon, title, hint, children }) => (
  <section className="rounded-xl border border-crewly-border bg-crewly-card p-4">
    <header className="flex items-start gap-2">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-crewly-green/10 text-crewly-green">
        <Icon className="h-4 w-4" aria-hidden="true" strokeWidth={1.9} />
      </span>

      <div className="min-w-0">
        <h2 className="text-[13px] font-bold text-crewly-text">{title}</h2>

        {hint && (
          <p className="mt-0.5 text-[11px] leading-relaxed text-crewly-dim">
            {hint}
          </p>
        )}
      </div>
    </header>

    <div className="mt-3">{children}</div>
  </section>
);

/** A single horizontal bar. The width is the share of the largest row. */
const UsageBar = ({ label, value, max, caption }) => {
  const share = max > 0 ? Math.round((value / max) * 100) : 0;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[12px] font-semibold text-crewly-text">
          {label}
        </span>

        <span className="shrink-0 text-[11px] tabular-nums text-crewly-dim">
          {formatNumber(value)} tokens
        </span>
      </div>

      <div
        className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-crewly-border/60"
        role="presentation"
      >
        <div
          className="h-full rounded-full bg-crewly-green"
          style={{ width: `${Math.max(share, 2)}%` }}
        />
      </div>

      {caption && (
        <p className="mt-0.5 text-[10px] text-crewly-dim">{caption}</p>
      )}
    </div>
  );
};

const AiUsagePage = () => {
  const [usage, setUsage] = useState(null);

  const [loading, setLoading] = useState(true);

  const [error, setError] = useState('');

  /**
   * The read itself. Contains NO synchronous setState — every write happens
   * after an `await`, which is what the react-hooks/set-state-in-effect rule
   * is actually about, and it is also just correct: this effect runs on mount,
   * and setting state before the request would render a spinner the browser
   * never paints.
   */
  const readUsage = useCallback(async () => {
    try {
      const data = await getAiUsage();

      setUsage(data);

      setError('');
    } catch (requestError) {
      // A failed read is stated as a failure. The page never shows zeros and
      // calls them usage — an empty dashboard and a broken one look the same
      // only if the code lies about it.
      setError(
        requestError?.message ||
          'The usage figures could not be loaded. Please try again.',
      );

      setUsage(null);
    }
  }, []);

  /** The refresh path: show the spinner, then read. */
  const load = useCallback(async () => {
    setLoading(true);

    await readUsage();

    setLoading(false);
  }, [readUsage]);

  /*
   * THE MOUNT EFFECT MUST CALL `load()`, NOT `readUsage()`.
   *
   * This is the SAME defect that was fixed on AiSettingsPage, and it survived
   * here because the fix and its pin were both scoped to that one file.
   *
   * `loading` starts as `true`, and `readUsage()` never touches it — only
   * `load()` clears it. Calling `readUsage()` here therefore left the flag
   * stuck at true forever, and the page is gated on it:
   *
   *   Refresh         onClick={load} disabled={loading}   <- dead
   *   the four tiles  {loading ? '\u2014' : tile.value}   <- dashes forever
   *   the empty state {loading ? 'Loading...' : ...}      <- "Loading..." forever
   *
   * So the dashboard rendered its detail rows from real data while the summary
   * tiles showed em-dashes and the Refresh spinner spun forever — and the one
   * control that could recover a failed read was itself disabled. A failed
   * request left the page permanently wedged: error banner up, Retry dead,
   * reload the only way out.
   *
   * On `react-hooks/set-state-in-effect`: this file reports one error on the
   * `load()` call below, and so would AiSettingsPage if the rule could see
   * through it — at ~985 lines the compiler's inference bails out there and
   * the rule never fires, which is the only reason that page looks clean. The
   * report is a false positive in substance (`loading` is already true, so
   * React bails out on the identical value and nothing re-renders), and the
   * shapes that satisfy the rule satisfy it by being untraceable rather than
   * correct. Both pages therefore keep the readable shape. One error, and it
   * moves with the effect rather than adding to the count.
   */
  useEffect(() => {
    load();
  }, [load]);

  const totals = usage || null;

  const maxFeature =
    totals && totals.byFeature.length > 0
      ? Math.max(...totals.byFeature.map((row) => row.totalTokens))
      : 0;

  const statusRows = totals
    ? Object.keys(totals.byStatus).map((key) => ({
        key,
        label: STATUS_LABELS[key] || key,
        ...totals.byStatus[key],
      }))
    : [];

  const quotaPercent =
    totals && totals.quotaTokens && totals.quotaTokens > 0
      ? Math.min(
          100,
          Math.round((totals.totalTokens / totals.quotaTokens) * 100),
        )
      : null;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-crewly-text">AI Usage</h1>

          <p className="mt-0.5 text-[12px] text-crewly-dim">
            Token usage for your company, {formatWindow(totals?.windowStart, totals?.windowEnd)}.
          </p>
        </div>

        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-lg border border-crewly-border px-3 py-1.5 text-[12px] font-semibold text-crewly-dim transition hover:text-crewly-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
            aria-hidden="true"
            strokeWidth={1.9}
          />

          Refresh
        </button>
      </header>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-crewly-red/40 bg-crewly-red/10 px-3 py-2.5 text-xs text-crewly-red">
          <AlertTriangle
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
            strokeWidth={1.9}
          />

          <div className="min-w-0 flex-1">
            <p className="font-semibold">Could not load the usage figures</p>

            <p className="mt-0.5 text-crewly-red/80">{error}</p>
          </div>
        </div>
      )}

      {/* The headline numbers. Four tiles, no charts, because four numbers are
          what an admin actually wants at a glance. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          {
            icon: CreditCard,
            label: 'Tokens used',
            value: formatNumber(totals?.totalTokens),
          },

          {
            icon: BarChart2,
            label: 'AI calls',
            value: formatNumber(totals?.calls),
          },

          {
            icon: FileText,
            label: 'Monthly quota',
            value:
              totals && totals.quotaTokens !== null
                ? formatNumber(totals.quotaTokens)
                : 'Platform default',
          },

          {
            icon: TrendingUp,
            label: 'Quota used',
            value: quotaPercent === null ? '\u2014' : `${quotaPercent}%`,
          },
        ].map((tile) => (
          <div
            key={tile.label}
            className="rounded-xl border border-crewly-border bg-crewly-card p-3"
          >
            <div className="flex items-center gap-1.5 text-crewly-dim">
              <tile.icon className="h-3.5 w-3.5" aria-hidden="true" strokeWidth={1.9} />

              <span className="text-[10px] font-semibold uppercase tracking-wide">
                {tile.label}
              </span>
            </div>

            <p className="mt-1.5 text-[18px] font-bold tabular-nums text-crewly-text">
              {loading ? '\u2014' : tile.value}
            </p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard
          icon={BarChart2}
          title="Tokens by feature"
          hint="Which surface of the product spent the budget."
        >
          {totals && totals.byFeature.length > 0 ? (
            <div className="space-y-3">
              {totals.byFeature.map((row) => (
                <UsageBar
                  key={row.feature}
                  label={row.feature}
                  value={row.totalTokens}
                  max={maxFeature}
                  caption={`${formatNumber(row.calls)} call${row.calls === 1 ? '' : 's'}`}
                />
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-crewly-dim">
              {loading
                ? 'Loading\u2026'
                : 'No AI calls recorded for this period.'}
            </p>
          )}
        </SectionCard>

        <SectionCard
          icon={FileText}
          title="Calls by outcome"
          hint="A rejected call never reached the vendor and never cost tokens."
        >
          {statusRows.length > 0 ? (
            <div className="space-y-2.5">
              {statusRows.map((row) => (
                <div
                  key={row.key}
                  className="flex items-center justify-between gap-3 border-b border-crewly-border/60 pb-2 last:border-0 last:pb-0"
                >
                  <span className="text-[12px] text-crewly-text">
                    {row.label}
                  </span>

                  <span className="shrink-0 text-[11px] tabular-nums text-crewly-dim">
                    {formatNumber(row.calls)} calls ·{' '}
                    {formatNumber(row.totalTokens)} tokens
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-crewly-dim">
              {loading ? 'Loading\u2026' : 'No calls recorded for this period.'}
            </p>
          )}
        </SectionCard>

        <div className="lg:col-span-2">
          <SectionCard
            icon={Users}
            title="Top users this month"
            hint="Token spend per person. A deleted employee keeps their spend so the total stays honest."
          >
            {totals && totals.topUsers.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12px]">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wide text-crewly-dim">
                      <th className="pb-2 pr-3 font-semibold">Employee</th>

                      <th className="pb-2 pr-3 font-semibold">Designation</th>

                      <th className="pb-2 pr-3 font-semibold">Calls</th>

                      <th className="pb-2 font-semibold">Tokens</th>
                    </tr>
                  </thead>

                  <tbody>
                    {totals.topUsers.map((row) => (
                      <tr
                        key={row.userId || row.name}
                        className="border-t border-crewly-border/60"
                      >
                        <td className="py-2 pr-3 text-crewly-text">
                          {row.name || 'Deleted employee'}
                        </td>

                        <td className="py-2 pr-3 text-crewly-dim">
                          {row.designation || '\u2014'}
                        </td>

                        <td className="py-2 pr-3 tabular-nums text-crewly-dim">
                          {formatNumber(row.calls)}
                        </td>

                        <td className="py-2 tabular-nums font-semibold text-crewly-text">
                          {formatNumber(row.totalTokens)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-[12px] text-crewly-dim">
                {loading
                  ? 'Loading\u2026'
                  : 'Nobody in your company has used the assistant this month.'}
              </p>
            )}
          </SectionCard>
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-crewly-dim">
        This dashboard shows token counts only. Prompts, replies and HR content
        are never stored, so there is nothing here that could expose a
        conversation.
      </p>
    </div>
  );
};

export default AiUsagePage;
