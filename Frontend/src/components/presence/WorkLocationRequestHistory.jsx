// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.5 — WORK-LOCATION REQUEST HISTORY
//
//  Compact list of the current user's WFH requests. Mirrors 31.4
//  AttendanceWorkModePage's history list. Used inside the
//  PresenceMenu history panel (optional) and as a stand-alone block.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import {
  fetchMyWorkLocationRequests,
  cancelMyWorkLocationRequest,
} from '../../redux/slices/presenceSlice.js';
import notify from '../../utils/notify.js';

const STATUS_LABEL = {
  pending: { text: 'Pending', className: 'border-crewly-amber/40 bg-crewly-amber/10 text-crewly-amber' },
  approved: { text: 'Approved', className: 'border-crewly-green/40 bg-crewly-green/10 text-crewly-green' },
  rejected: { text: 'Rejected', className: 'border-crewly-red/40 bg-crewly-red/10 text-crewly-red' },
  cancelled: { text: 'Cancelled', className: 'border-crewly-border bg-crewly-bg text-crewly-dim' },
};

const formatRange = (start, end) =>
  start === end ? start : `${start} → ${end}`;

export default function WorkLocationRequestHistory() {
  const dispatch = useDispatch();
  const { myRequests, loading, error } = useSelector(
    (state) => state.presence?.workLocationRequests || {},
  );

  useEffect(() => {
    if (loading === 'idle') {
      dispatch(fetchMyWorkLocationRequests());
    }
  }, [dispatch, loading]);

  useEffect(() => {
    if (error) notify.error(error.message || 'Could not load WFH requests');
  }, [error]);

  const handleCancel = async (requestId) => {
    const action = await dispatch(cancelMyWorkLocationRequest(requestId));
    if (action.error) {
      notify.error(
        action.payload?.message || 'Could not cancel WFH request',
      );
      return;
    }
    notify.success('WFH request cancelled');
  };

  return (
    <div className="space-y-2" data-testid="wlr-history-root">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-crewly-dim">
          My WFH requests
        </h3>
        <button
          type="button"
          onClick={() => dispatch(fetchMyWorkLocationRequests())}
          disabled={loading === 'pending'}
          className="inline-flex items-center rounded-md border border-crewly-border bg-crewly-bg px-2 py-0.5 text-[11px] font-medium text-crewly-dim hover:border-crewly-green/50 hover:text-crewly-text disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      {loading === 'pending' ? (
        <p className="rounded-md border border-crewly-border bg-crewly-bg p-2 text-[11px] text-crewly-dim">
          Loading…
        </p>
      ) : !Array.isArray(myRequests) || myRequests.length === 0 ? (
        <p
          className="rounded-md border border-crewly-border bg-crewly-bg p-2 text-[11px] text-crewly-dim"
          data-testid="wlr-history-empty"
        >
          You have no WFH requests yet.
        </p>
      ) : (
        <ul className="space-y-1.5" data-testid="wlr-history-list">
          {myRequests.map((row) => {
            const badge = STATUS_LABEL[row.status] || {
              text: row.status,
              className: 'border-crewly-border bg-crewly-bg text-crewly-dim',
            };
            return (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-crewly-border bg-crewly-bg p-2 text-[11px]"
                data-testid="wlr-history-item"
              >
                <div>
                  <div className="font-medium text-crewly-text">
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
                  <span
                    className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${badge.className}`}
                    data-testid="wlr-status-badge"
                  >
                    {badge.text}
                  </span>
                  {row.isCancelable ? (
                    <button
                      type="button"
                      onClick={() => handleCancel(row.id)}
                      className="inline-flex items-center rounded-md border border-crewly-border bg-crewly-card px-1.5 py-0.5 text-[10px] font-medium text-crewly-dim hover:border-crewly-red/50 hover:text-crewly-red"
                      data-testid="wlr-history-cancel"
                    >
                      Cancel
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
