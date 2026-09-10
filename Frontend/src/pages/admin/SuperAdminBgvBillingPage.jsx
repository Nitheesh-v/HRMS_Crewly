import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ban, CreditCard, Hourglass, IndianRupee, Loader2, ReceiptText } from 'lucide-react';
import superAdminService from '../../services/superAdminService.js';

// Phase 30.12 — BGV Billing (platform reporting, read-only).
// Amounts are SERVER-CONFIRMED snapshot values (minor units rendered by the
// backend); this page never prices anything and never mutates payments.
// No prepaid/subscription/postpaid model exists — see NOT-implemented list.

const STATUS_BADGE = {
  PAID: 'bg-crewly-green/10 text-crewly-green',
  PENDING_PAYMENT: 'bg-amber-500/10 text-amber-300',
  CREATED: 'bg-slate-500/10 text-slate-300',
  CANCELLED: 'bg-rose-500/10 text-rose-300',
  EXPIRED: 'bg-rose-500/10 text-rose-300',
};

const SuperAdminBgvBillingPage = () => {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  // HR initiated, candidate never replied.
  const [awaiting, setAwaiting] = useState(null);
  const [awaitingError, setAwaitingError] = useState('');
  const [cancelFor, setCancelFor] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [cancelBusy, setCancelBusy] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const result = await superAdminService.bgvBillingOverview({
        status,
        page,
        pageSize: 20,
      });
      setData(result);
    } catch (requestError) {
      setError(requestError?.message || 'Could not load BGV billing');
    }
    setAwaitingError('');
    try {
      setAwaiting(await superAdminService.bgvBillingAwaiting({ pageSize: 50 }));
    } catch (requestError) {
      setAwaitingError(requestError?.message || 'Could not load awaiting-candidate requests');
    }
  }, [status, page]);

  const submitCancel = async (orderId) => {
    if (cancelReason.trim().length < 10) return;
    setCancelBusy(true);
    try {
      await superAdminService.bgvBillingCancel(orderId, { reason: cancelReason.trim() });
      setCancelFor('');
      setCancelReason('');
      await load();
    } catch (requestError) {
      setAwaitingError(requestError?.message || 'Could not cancel the request');
    } finally {
      setCancelBusy(false);
    }
  };

  useEffect(() => {
    load();
  }, [load]);

  const statusOptions = useMemo(
    () => (data?.summary?.byStatus || []).map((entry) => entry.status),
    [data]
  );
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-crewly-text">BGV Billing</h1>
        <p className="mt-1 text-sm text-crewly-dim">
          Read-only revenue reporting over immutable BGV order snapshots — server-confirmed amounts only. No wallets, plans, or
          subscriptions exist; future billing models remain NOT implemented.
        </p>
      </div>

      {error ? <div className="card border-rose-500/40 text-sm text-rose-300">{error}</div> : null}

      {data ? (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="card">
              <p className="flex items-center gap-2 text-xs text-crewly-dim">
                <IndianRupee className="h-4 w-4 text-crewly-green" /> Collected (PAID orders)
              </p>
              <p className="mt-2 text-2xl font-black text-crewly-green">{data.summary.collectedDisplay}</p>
              <p className="mt-1 text-[11px] text-crewly-dim">{data.summary.paidOrderCount} paid order(s)</p>
            </div>
            <div className="card">
              <p className="flex items-center gap-2 text-xs text-crewly-dim">
                <ReceiptText className="h-4 w-4 text-crewly-green" /> BGV orders
              </p>
              <p className="mt-2 text-2xl font-black text-crewly-text">{data.summary.orderCount}</p>
              <p className="mt-1 text-[11px] text-crewly-dim">all tenants · all statuses</p>
            </div>
            <div className="card">
              <p className="flex items-center gap-2 text-xs text-crewly-dim">
                <CreditCard className="h-4 w-4 text-crewly-green" /> By status
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {data.summary.byStatus.map((entry) => (
                  <span key={entry.status} className={`badge ${STATUS_BADGE[entry.status] || 'bg-slate-500/10 text-slate-300'}`}>
                    {entry.status} · {entry.count} · {entry.totalDisplay}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="card">
            <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-crewly-text">
              <Hourglass className="h-4 w-4 text-amber-300" /> Awaiting candidate response
            </h2>
            <p className="mb-4 text-xs text-crewly-dim">
              Paid BGV requests where the consent invitation got no candidate reply. Cancel becomes available only after the
              response window expired; cancelling releases the candidate so the tenant can initiate a fresh request. No refund
              path exists — refunds remain NOT implemented.
            </p>
            {awaitingError ? <div className="mb-3 text-xs text-rose-300">{awaitingError}</div> : null}
            {!awaiting ? (
              <p className="text-sm text-crewly-dim">Loading…</p>
            ) : awaiting.rows.length === 0 ? (
              <p className="text-sm text-crewly-dim">No unanswered BGV requests right now.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-crewly-border text-[11px] uppercase tracking-wide text-crewly-dim">
                      <th className="py-2 pr-4">Order</th>
                      <th className="py-2 pr-4">Tenant</th>
                      <th className="py-2 pr-4">Candidate</th>
                      <th className="py-2 pr-4">Invited</th>
                      <th className="py-2 pr-4">Window ended</th>
                      <th className="py-2 pr-4">Waiting</th>
                      <th className="py-2 pr-4">Views</th>
                      <th className="py-2">Cancel</th>
                    </tr>
                  </thead>
                  <tbody>
                    {awaiting.rows.map((row) => (
                      <tr key={row.orderId} className="border-b border-crewly-border/60 align-top">
                        <td className="py-3 pr-4 font-mono text-xs text-crewly-text">{row.orderCode}</td>
                        <td className="py-3 pr-4 text-crewly-text">{row.companyName || '—'}</td>
                        <td className="py-3 pr-4 text-crewly-text">{row.candidateName || '—'}</td>
                        <td className="py-3 pr-4 text-xs text-crewly-dim">{row.sentAt ? new Date(row.sentAt).toLocaleDateString() : '—'}</td>
                        <td className="py-3 pr-4 text-xs">
                          <span className={`badge ${row.expired ? 'bg-rose-500/10 text-rose-300' : 'bg-amber-500/10 text-amber-300'}`}>
                            {row.expiresAt ? new Date(row.expiresAt).toLocaleDateString() : '—'}
                          </span>
                        </td>
                        <td className="py-3 pr-4 text-xs text-crewly-dim">{row.daysWaiting} day(s)</td>
                        <td className="py-3 pr-4 text-xs text-crewly-dim">
                          {row.viewCount}
                          {row.lastViewedAt ? ` · last ${new Date(row.lastViewedAt).toLocaleDateString()}` : ''}
                        </td>
                        <td className="py-3">
                          <button
                            type="button"
                            className="btn-ghost gap-1 !px-2.5 !py-1 text-xs text-rose-300 disabled:cursor-not-allowed disabled:opacity-40"
                            disabled={!row.cancellable || cancelBusy}
                            title={row.cancellable ? 'Cancel this unanswered request' : 'Available only after the response window expired'}
                            onClick={() => {
                              setCancelFor((current) => (current === row.orderId ? '' : row.orderId));
                              setCancelReason('');
                            }}
                          >
                            <Ban className="h-3.5 w-3.5" /> Cancel
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {cancelFor ? (
              <div className="mt-4 rounded-lg border border-rose-500/40 bg-rose-500/5 p-3">
                <p className="text-xs font-semibold text-rose-300">
                  Cancel the unanswered request {awaiting.rows.find((row) => row.orderId === cancelFor)?.orderCode}?
                </p>
                <textarea
                  className="input mt-2 min-h-[64px] text-sm"
                  placeholder="Reason (at least 10 characters) — recorded in the platform audit trail"
                  value={cancelReason}
                  onChange={(event) => setCancelReason(event.target.value)}
                />
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    className="btn-primary !px-3 !py-1.5 text-xs"
                    disabled={cancelReason.trim().length < 10 || cancelBusy}
                    onClick={() => submitCancel(cancelFor)}
                  >
                    {cancelBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />} Confirm cancel
                  </button>
                  <button type="button" className="btn-ghost !px-3 !py-1.5 text-xs" disabled={cancelBusy} onClick={() => setCancelFor('')}>
                    Back
                  </button>
                  <span className="text-[11px] text-crewly-dim">Order becomes CANCELLED, the consent link dies, candidate is released for a new request.</span>
                </div>
              </div>
            ) : null}
          </div>

          <div className="card">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <label className="label !mb-0" htmlFor="billing-status">Status</label>
              <select
                id="billing-status"
                className="input !w-auto"
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value);
                  setPage(1);
                }}
              >
                <option value="">All statuses</option>
                {statusOptions.map((entry) => (
                  <option key={entry} value={entry}>{entry}</option>
                ))}
              </select>
            </div>

            {data.rows.length === 0 ? (
              <p className="text-sm text-crewly-dim">No BGV orders match these filters.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-crewly-border text-[11px] uppercase tracking-wide text-crewly-dim">
                      <th className="py-2 pr-4">Order</th>
                      <th className="py-2 pr-4">Tenant</th>
                      <th className="py-2 pr-4">Purchased checks</th>
                      <th className="py-2 pr-4">Total (server-confirmed)</th>
                      <th className="py-2 pr-4">Gateway</th>
                      <th className="py-2 pr-4">Status</th>
                      <th className="py-2">Paid at</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row) => (
                      <tr key={row.orderId} className="border-b border-crewly-border/60 align-top">
                        <td className="py-3 pr-4 font-mono text-xs text-crewly-text">{row.orderCode}</td>
                        <td className="py-3 pr-4 text-crewly-text">{row.companyName || '—'}</td>
                        <td className="py-3 pr-4 text-xs text-crewly-dim">
                          {row.items.map((item) => `${item.name} (${item.priceDisplay})`).join(', ')}
                        </td>
                        <td className="py-3 pr-4 font-semibold text-crewly-text">{row.totalDisplay}</td>
                        <td className="py-3 pr-4 text-xs text-crewly-dim">{row.gateway || '—'}</td>
                        <td className="py-3 pr-4">
                          <span className={`badge ${STATUS_BADGE[row.status] || 'bg-slate-500/10 text-slate-300'}`}>{row.status}</span>
                        </td>
                        <td className="py-3 text-xs text-crewly-dim">
                          {row.paidAt ? new Date(row.paidAt).toLocaleString() : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-4 flex items-center justify-between text-sm">
              <button type="button" className="btn-ghost gap-2 !px-3 !py-1.5 text-xs" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </button>
              <span className="text-xs text-crewly-dim">Page {data.page} of {pages} · {data.total} order(s)</span>
              <button type="button" className="btn-ghost gap-2 !px-3 !py-1.5 text-xs" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                Next
              </button>
            </div>
          </div>
        </>
      ) : (
        !error && (
          <div className="card flex items-center gap-2 text-sm text-crewly-dim">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading BGV billing…
          </div>
        )
      )}
    </div>
  );
};

export default SuperAdminBgvBillingPage;
