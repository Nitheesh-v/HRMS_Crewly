/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  Lock,
  Wallet,
} from 'lucide-react';

import usePermission from '../../hooks/usePermission.js';
import fnfService, { saveBlob } from '../../services/fnfService.js';

// ───────────────────────────────────────────────────────────────────────────
// Phase 29.11 §18 — My Payroll → Final Settlement
//
// Everything here is read-only and addressed to the signed-in employee: the
// employee id never leaves the server, because the backend reads it from the
// JWT (§3 / §24). An employee can see their own settlement and download the
// F&F statement once it has been paid — and nothing else.
//
// §18: status, final amount, leave encashment, recoveries, download PDF.
// ───────────────────────────────────────────────────────────────────────────

const money = (value) => `Rs ${Number(value || 0).toLocaleString('en-IN')}`;

const formatDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const STATUS_STYLES = {
  DRAFT: 'bg-slate-500/15 text-slate-300',
  CALCULATED: 'bg-sky-500/15 text-sky-300',
  HR_REVIEWED: 'bg-indigo-500/15 text-indigo-300',
  FINANCE_APPROVED: 'bg-amber-500/15 text-amber-300',
  PAID: 'bg-emerald-500/15 text-emerald-300',
  CLOSED: 'bg-violet-500/15 text-violet-300',
  REOPENED: 'bg-orange-500/15 text-orange-300',
};

// A short, human sentence for each stage — the employee should not have to
// learn the payroll team's vocabulary to know where their money is.
const STATUS_HELP = {
  DRAFT: 'Your settlement has been opened but the figures are not final yet.',
  CALCULATED: 'HR is verifying your last working day, attendance and leave balance.',
  HR_REVIEWED: 'HR has completed the review. Finance approval is pending.',
  FINANCE_APPROVED: 'Finance has approved your settlement. Payment is being processed.',
  PAID: 'Your settlement has been paid. The F&F statement is ready to download.',
  CLOSED: 'Your settlement is closed and archived.',
  REOPENED: 'Your settlement was reopened for a correction and is being recalculated.',
};

const NOTICE_LABELS = {
  COMPLETED: 'Completed Notice',
  BUYOUT: 'Notice Buyout',
  WAIVED: 'Notice Waived',
};

const Field = ({ label, value }) => (
  <div>
    <dt className="text-xs uppercase tracking-wide text-crewly-dim">{label}</dt>
    <dd className="mt-0.5 text-sm font-medium">
      {value === '' || value === null || value === undefined ? '—' : value}
    </dd>
  </div>
);

const MyFinalSettlementPage = () => {
  const { loading: permsLoading, hasPermission } = usePermission();
  const canRead = hasPermission('FINAL_SETTLEMENT_READ_SELF');

  const [settlement, setSettlement] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [banner, setBanner] = useState(null);
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fnfService.mine();
      setSettlement(data || null);
      setError('');
    } catch (requestError) {
      setError(requestError?.message || 'Unable to load your final settlement');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!permsLoading && canRead) load();
    if (!permsLoading && !canRead) setLoading(false);
  }, [permsLoading, canRead, load]);

  const download = async () => {
    setDownloading(true);
    try {
      const blob = await fnfService.downloadMyStatement();
      saveBlob(blob, `FNF-${settlement?.settlementNumber || 'statement'}.pdf`);
      setBanner({ type: 'success', text: 'Your F&F statement has been downloaded.' });
      setTimeout(() => setBanner(null), 6000);
    } catch (requestError) {
      setBanner({ type: 'error', text: requestError?.message || 'Unable to download your statement' });
    } finally {
      setDownloading(false);
    }
  };

  const earnings = settlement?.earnings || {};
  const recoveries = settlement?.recoveries || {};
  const totals = settlement?.totals || {};

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Final Settlement</h1>
        <p className="text-sm text-crewly-dim">
          Your Full &amp; Final settlement — read-only, and visible only to you.
        </p>
      </div>

      {banner ? (
        <div
          className={`card flex items-center gap-2 text-sm ${
            banner.type === 'error' ? 'border-red-500/40 text-red-300' : 'border-emerald-500/40 text-emerald-300'
          }`}
        >
          {banner.type === 'error' ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
          {banner.text}
        </div>
      ) : null}

      {!permsLoading && !canRead ? (
        <div className="card space-y-2">
          <h2 className="text-lg font-semibold">Not available</h2>
          <p className="text-sm text-crewly-dim">
            You don&apos;t have permission to view final settlements. Contact your HR team.
          </p>
        </div>
      ) : null}

      {loading ? (
        <div className="card flex items-center gap-2 text-sm text-crewly-dim">
          <Loader2 size={16} className="animate-spin" /> Loading your settlement…
        </div>
      ) : null}

      {!loading && canRead && error ? (
        <div className="card flex items-center gap-2 text-sm text-red-300">
          <AlertTriangle size={16} /> {error}
        </div>
      ) : null}

      {!loading && canRead && !error && !settlement ? (
        <div className="card space-y-2">
          <h2 className="text-lg font-semibold">No final settlement</h2>
          <p className="text-sm text-crewly-dim">
            You have no final settlement on record. If you are leaving the company, HR will create one
            once your resignation has been approved.
          </p>
        </div>
      ) : null}

      {!loading && canRead && settlement ? (
        <>
          <div className="card flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold">{settlement.settlementNumber}</h2>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-[11px] ${
                    STATUS_STYLES[settlement.status] || STATUS_STYLES.DRAFT
                  }`}
                >
                  {settlement.statusLabel}
                </span>
              </div>
              <p className="mt-1 text-sm text-crewly-dim">{STATUS_HELP[settlement.status]}</p>
            </div>
            <button
              type="button"
              className="btn-primary flex items-center gap-2"
              onClick={download}
              disabled={!settlement.canDownload || downloading}
              title={settlement.canDownload ? '' : 'Available once the settlement has been paid'}
            >
              {downloading ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
              Download F&amp;F statement
            </button>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="card space-y-3 lg:col-span-2">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-crewly-dim">Exit details</h3>
                <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <Field label="Last Working Day" value={formatDate(settlement.exit?.lastWorkingDate)} />
                  <Field label="Resignation Date" value={formatDate(settlement.exit?.resignationDate)} />
                  <Field label="Notice Period" value={`${settlement.exit?.noticePeriodDays ?? '—'} days`} />
                  <Field label="Notice Decision" value={settlement.exit?.noticeDecisionLabel} />
                  <Field label="Reason" value={settlement.exit?.reason} />
                  <Field label="Payroll Month" value={settlement.monthLabel} />
                </dl>
              </div>

              <div className="border-t border-white/10 pt-3">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-crewly-dim">Earnings</h3>
                <ul className="mt-2 space-y-2 text-sm">
                  <li className="flex items-center justify-between gap-3">
                    <span>
                      Pending Salary
                      <span className="block text-xs text-crewly-dim">
                        {earnings.pendingSalary?.payableDays ?? 0} payable day(s) ×{' '}
                        {money(earnings.pendingSalary?.dailyRate)}
                      </span>
                    </span>
                    <span className="font-medium">{money(earnings.pendingSalary?.amount)}</span>
                  </li>
                  {(earnings.leaveEncashment?.amount || 0) > 0 ? (
                    <li className="flex items-center justify-between gap-3">
                      <span>
                        Leave Encashment
                        <span className="block text-xs text-crewly-dim">
                          {earnings.leaveEncashment?.encashedDays ?? 0} unused day(s) ×{' '}
                          {money(earnings.leaveEncashment?.dailyRate)}
                        </span>
                      </span>
                      <span className="font-medium">{money(earnings.leaveEncashment?.amount)}</span>
                    </li>
                  ) : null}
                  {(earnings.gratuity?.amount || 0) > 0 ? (
                    <li className="flex items-center justify-between gap-3">
                      <span>
                        Gratuity
                        <span className="block text-xs text-crewly-dim">
                          {earnings.gratuity?.creditedYears ?? 0} year(s) of service
                        </span>
                      </span>
                      <span className="font-medium">{money(earnings.gratuity?.amount)}</span>
                    </li>
                  ) : null}
                  {(earnings.additional || []).map((item, index) => (
                    <li key={`additional-${index}`} className="flex items-center justify-between gap-3">
                      <span>
                        {item.label}
                        {item.note ? <span className="block text-xs text-crewly-dim">{item.note}</span> : null}
                      </span>
                      <span className="font-medium">{money(item.amount)}</span>
                    </li>
                  ))}
                  <li className="flex items-center justify-between gap-3 border-t border-white/10 pt-2 font-semibold">
                    <span>Total Earnings</span>
                    <span>{money(totals.totalEarnings)}</span>
                  </li>
                </ul>
              </div>

              <div className="border-t border-white/10 pt-3">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-crewly-dim">Recoveries</h3>
                <ul className="mt-2 space-y-2 text-sm">
                  {(recoveries.notice?.amount || 0) > 0 ? (
                    <li className="flex items-center justify-between gap-3">
                      <span>
                        Notice Recovery
                        <span className="block text-xs text-crewly-dim">
                          {NOTICE_LABELS[recoveries.notice?.decision] || 'Notice'} ·{' '}
                          {recoveries.notice?.shortfallDays ?? 0} day(s) × {money(recoveries.notice?.dailyRate)}
                        </span>
                      </span>
                      <span className="font-medium">{money(recoveries.notice?.amount)}</span>
                    </li>
                  ) : null}
                  {(recoveries.items || []).map((item, index) => (
                    <li key={`recovery-${index}`} className="flex items-center justify-between gap-3">
                      <span>
                        {item.label}
                        {item.reason ? <span className="block text-xs text-crewly-dim">{item.reason}</span> : null}
                      </span>
                      <span className="font-medium">{money(item.amount)}</span>
                    </li>
                  ))}
                  {(recoveries.notice?.amount || 0) === 0 && !(recoveries.items || []).length ? (
                    <li className="text-sm text-crewly-dim">No recoveries.</li>
                  ) : null}
                  <li className="flex items-center justify-between gap-3 border-t border-white/10 pt-2 font-semibold">
                    <span>Total Recoveries</span>
                    <span>{money(totals.totalRecoveries)}</span>
                  </li>
                </ul>
              </div>
            </div>

            <div className="space-y-4">
              <div
                className={`card ${
                  Number(totals.netSettlement || 0) < 0 ? 'bg-red-500/10' : 'bg-emerald-500/10'
                }`}
              >
                <p className="flex items-center gap-2 text-xs uppercase tracking-wide text-crewly-dim">
                  <Wallet size={14} />
                  {Number(totals.netSettlement || 0) < 0
                    ? 'Amount recoverable from you'
                    : 'Net Settlement'}
                </p>
                <p
                  className={`mt-2 text-2xl font-semibold ${
                    Number(totals.netSettlement || 0) < 0 ? 'text-red-300' : 'text-emerald-300'
                  }`}
                >
                  {money(totals.netSettlement)}
                </p>
                {settlement.payment?.paidAt ? (
                  <p className="mt-2 text-xs text-crewly-dim">
                    Paid on {formatDate(settlement.payment.paidAt)}
                    {settlement.payment.reference ? ` · ${settlement.payment.reference}` : ''}
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-crewly-dim">Not paid yet.</p>
                )}
              </div>

              <div className="card space-y-2 text-sm">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-crewly-dim">
                  What happens next
                </h3>
                <ol className="ml-4 list-decimal space-y-1 text-crewly-dim">
                  <li>HR verifies your last working day, attendance and leave balance.</li>
                  <li>Finance reviews and approves the settlement.</li>
                  <li>The amount is paid and the F&amp;F statement is released here.</li>
                </ol>
                <p className="flex items-start gap-2 pt-1 text-xs text-crewly-dim">
                  <Lock size={13} className="mt-0.5" />
                  Employees cannot change settlement values. If something looks wrong, raise it with HR
                  before the settlement is closed.
                </p>
              </div>

              <div className="card flex items-start gap-2 text-xs text-crewly-dim">
                <FileText size={14} className="mt-0.5" />
                <span>
                  The F&amp;F statement is generated by Crewly from your payroll records. It is a
                  computer-generated statement, not a legal document.
                </span>
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
};

export default MyFinalSettlementPage;
