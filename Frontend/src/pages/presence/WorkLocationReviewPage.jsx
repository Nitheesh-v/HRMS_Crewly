// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.5 — WORK-LOCATION REVIEW PAGE
//
//  Reviewer queue for pending WFH requests. PENDING only. The
//  page reads from `state.presence.workLocationRequests.reviewQueue`
//  and dispatches `fetchWorkLocationReviewQueue` on mount, plus
//  `decideWorkLocationRequest` on Approve / Reject.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useState, useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Check, X, AlertCircle } from 'lucide-react';

import {
  fetchWorkLocationReviewQueue,
  decideWorkLocationRequest,
} from '../../redux/slices/presenceSlice.js';
import notify from '../../utils/notify.js';

const formatRange = (start, end) =>
  start === end ? start : `${start} → ${end}`;

export default function WorkLocationReviewPage() {
  const dispatch = useDispatch();
  const { reviewQueue, loadingQueue, decisionPending, error } = useSelector(
    (state) => state.presence?.workLocationRequests || {},
  );
  const [decisionNote, setDecisionNote] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [actionKind, setActionKind] = useState(null);

  useEffect(() => {
    dispatch(fetchWorkLocationReviewQueue());
  }, [dispatch]);

  useEffect(() => {
    if (error) {
      notify.error(error.message || 'Review queue error');
    }
  }, [error]);

  const handleDecide = useCallback(
    async (requestId, kind) => {
      if (busyId) return; // double-click guard
      setBusyId(requestId);
      setActionKind(kind);
      try {
        const action = await dispatch(
          decideWorkLocationRequest({
            requestId,
            action: kind,
            decisionNote: decisionNote.trim() || null,
          }),
        );
        if (action.error) {
          notify.error(
            action.payload?.message ||
              (kind === 'approve'
                ? 'Could not approve WFH request'
                : 'Could not reject WFH request'),
          );
          return;
        }
        notify.success(
          kind === 'approve'
            ? 'WFH request approved'
            : 'WFH request rejected',
        );
        setDecisionNote('');
      } finally {
        setBusyId(null);
        setActionKind(null);
      }
    },
    [dispatch, decisionNote, busyId],
  );

  const isLoading = loadingQueue === 'pending';

  return (
    <div className="space-y-3" data-testid="wlr-review-root">
      <div className="flex items-center justify-between">
        <h1 className="text-base font-semibold text-crewly-text">
          WFH review queue
        </h1>
        <button
          type="button"
          onClick={() => dispatch(fetchWorkLocationReviewQueue())}
          disabled={isLoading}
          className="inline-flex items-center rounded-md border border-crewly-border bg-crewly-bg px-2.5 py-1 text-xs font-medium text-crewly-dim hover:border-crewly-green/50 hover:text-crewly-text disabled:opacity-50"
          data-testid="wlr-review-refresh"
        >
          Refresh
        </button>
      </div>

      <p className="rounded-md border border-crewly-border bg-crewly-bg p-2 text-[11px] text-crewly-dim">
        Only requests for employees in your team are shown. The server
        enforces this scope; this page never overrides identity.
      </p>

      <div>
        <label className="mb-1 block text-xs text-crewly-dim">
          Optional decision note (≤ 300 chars) — applies to the next
          Approve / Reject action.
        </label>
        <textarea
          value={decisionNote}
          onChange={(e) => setDecisionNote(e.target.value)}
          maxLength={300}
          rows={2}
          className="w-full rounded-md border border-crewly-border bg-crewly-bg px-2 py-1.5 text-xs"
          data-testid="wlr-review-note"
        />
        <div className="mt-1 text-right text-[10px] text-crewly-dim">
          {decisionNote.length}/300
        </div>
      </div>

      {isLoading ? (
        <p className="rounded-md border border-crewly-border bg-crewly-bg p-3 text-xs text-crewly-dim">
          Loading review queue…
        </p>
      ) : reviewQueue.length === 0 ? (
        <p
          className="rounded-md border border-crewly-border bg-crewly-bg p-3 text-xs text-crewly-dim"
          data-testid="wlr-review-empty"
        >
          No pending WFH requests in your team right now.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="wlr-review-list">
          {reviewQueue.map((row) => {
            const isBusy = busyId === row.id;
            return (
              <li
                key={row.id}
                className="rounded-md border border-crewly-border bg-crewly-card p-3 text-xs"
                data-testid="wlr-review-item"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium text-crewly-text">
                      {row.requesterName || 'Unknown employee'}
                    </div>
                    <div className="text-[11px] text-crewly-dim">
                      WFH · {formatRange(row.startDate, row.endDate)}
                    </div>
                    <div className="text-[10px] text-crewly-dim">
                      Requested{' '}
                      {row.requestedAt
                        ? new Date(row.requestedAt).toLocaleString()
                        : '—'}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleDecide(row.id, 'approve')}
                      disabled={isBusy || decisionPending === 'pending'}
                      data-testid="wlr-review-approve"
                      className="inline-flex items-center gap-1 rounded-md border border-crewly-green/40 bg-crewly-green/10 px-2.5 py-1 text-[11px] font-medium text-crewly-green hover:border-crewly-green/60 disabled:opacity-50"
                    >
                      <Check className="h-3.5 w-3.5" /> Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDecide(row.id, 'reject')}
                      disabled={isBusy || decisionPending === 'pending'}
                      data-testid="wlr-review-reject"
                      className="inline-flex items-center gap-1 rounded-md border border-crewly-red/40 bg-crewly-red/10 px-2.5 py-1 text-[11px] font-medium text-crewly-red hover:border-crewly-red/60 disabled:opacity-50"
                    >
                      <X className="h-3.5 w-3.5" /> Reject
                    </button>
                  </div>
                </div>
                {isBusy && actionKind ? (
                  <p className="mt-2 inline-flex items-center gap-1 text-[11px] text-crewly-dim">
                    <AlertCircle className="h-3 w-3" />
                    Submitting {actionKind}…
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
