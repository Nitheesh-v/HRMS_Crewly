// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.5 — WORK-LOCATION REQUEST DIALOG (employee self-service)
//
//  A modal that lets an employee submit a WFH request for one or more
//  days under a tenant whose wfhMode is "approval_required". Renders
//  only when the parent signals it should.
//
//  • No companyId / userId / employeeId / reviewedBy in the payload
//  • No localStorage
//  • Double-click guard on submit
//  • Server-confirmed Pending in the parent list after submit
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useState, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { X } from 'lucide-react';

import {
  submitWorkLocationRequest,
} from '../../redux/slices/presenceSlice.js';
import notify from '../../utils/notify.js';

const todayIso = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const addDaysIso = (start, days) => {
  const [y, m, d] = start.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
};

const isValidDay = (s) =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export default function WorkLocationRequestDialog({ open, onClose, today }) {
  const dispatch = useDispatch();
  const { submitting, error } = useSelector(
    (state) => state.presence?.workLocationRequests || {},
  );
  const serverToday = today || todayIso();
  const [startDate, setStartDate] = useState(serverToday);
  const [endDate, setEndDate] = useState(serverToday);
  const [decisionNote, setDecisionNote] = useState('');
  const [clientError, setClientError] = useState(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (open) {
      setStartDate(serverToday);
      setEndDate(serverToday);
      setDecisionNote('');
      setClientError(null);
    }
  }, [open, serverToday]);

  useEffect(() => {
    if (error && open) {
      notify.error(error.message || 'WFH request failed');
      setClientError(null);
    }
  }, [error, open]);

  if (!open) return null;

  const handleSubmit = async (ev) => {
    ev.preventDefault();
    if (submittingRef.current) return;
    setClientError(null);

    if (!isValidDay(startDate) || !isValidDay(endDate)) {
      setClientError('Please enter valid YYYY-MM-DD day strings.');
      return;
    }
    if (endDate < startDate) {
      setClientError('End date must be the same as or after start date.');
      return;
    }
    if (startDate < serverToday) {
      setClientError('Start date cannot be in the past.');
      return;
    }
    if (decisionNote.length > 300) {
      setClientError('Decision note must be at most 300 characters.');
      return;
    }

    submittingRef.current = true;
    try {
      const action = await dispatch(
        submitWorkLocationRequest({
          location: 'wfh',
          startDate,
          endDate,
          // Note: NO companyId / userId / employeeId / reviewedBy here.
          // Decision note is optional; we send it only when the user
          // typed one.
          ...(decisionNote.trim() ? { decisionNote: decisionNote.trim() } : {}),
        }),
      );
      if (action.error) {
        setClientError(
          action.payload?.message || 'WFH request could not be submitted',
        );
        return;
      }
      notify.success('WFH request submitted for review');
      onClose?.();
    } finally {
      submittingRef.current = false;
    }
  };

  const rangeHint =
    startDate === endDate
      ? startDate
      : `${startDate} → ${endDate}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-label="Request WFH"
      data-testid="wlr-dialog-root"
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-xl border border-crewly-border bg-crewly-card p-4 shadow-xl"
        data-testid="wlr-dialog-form"
      >
        <div className="flex items-center justify-between border-b border-crewly-border pb-2">
          <h2 className="text-sm font-semibold text-crewly-text">
            Request Work From Home
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-crewly-dim hover:bg-crewly-bg hover:text-crewly-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-3 space-y-3 text-xs text-crewly-text">
          <div>
            <label className="mb-1 block text-crewly-dim">Start date</label>
            <input
              type="date"
              value={startDate}
              min={serverToday}
              onChange={(e) => {
                setStartDate(e.target.value);
                if (e.target.value > endDate) setEndDate(e.target.value);
              }}
              disabled={submitting === 'pending'}
              required
              className="w-full rounded-md border border-crewly-border bg-crewly-bg px-2 py-1.5"
              data-testid="wlr-start-date"
            />
          </div>
          <div>
            <label className="mb-1 block text-crewly-dim">End date</label>
            <input
              type="date"
              value={endDate}
              min={startDate}
              onChange={(e) => setEndDate(e.target.value)}
              disabled={submitting === 'pending'}
              required
              className="w-full rounded-md border border-crewly-border bg-crewly-bg px-2 py-1.5"
              data-testid="wlr-end-date"
            />
          </div>
          <div>
            <label className="mb-1 block text-crewly-dim">
              Note for reviewer (optional, ≤ 300 chars)
            </label>
            <textarea
              value={decisionNote}
              onChange={(e) => setDecisionNote(e.target.value)}
              maxLength={300}
              rows={3}
              disabled={submitting === 'pending'}
              className="w-full rounded-md border border-crewly-border bg-crewly-bg px-2 py-1.5"
              data-testid="wlr-note"
            />
            <div className="mt-1 text-right text-[10px] text-crewly-dim">
              {decisionNote.length}/300
            </div>
          </div>

          <p className="rounded-md border border-crewly-border bg-crewly-bg p-2 text-[11px] text-crewly-dim">
            <strong>Range:</strong> {rangeHint}
            <br />
            Your manager or HR will review this request. You will see the
            status update in <em>My WFH requests</em>.
          </p>

          {clientError ? (
            <p
              className="rounded-md border border-crewly-red/30 bg-crewly-red/10 p-2 text-[11px] text-crewly-red"
              data-testid="wlr-client-error"
            >
              {clientError}
            </p>
          ) : null}
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting === 'pending'}
            className="inline-flex items-center rounded-md border border-crewly-border bg-crewly-bg px-3 py-1.5 text-xs font-medium text-crewly-dim hover:border-crewly-red/50 hover:text-crewly-red disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting === 'pending'}
            data-testid="wlr-submit"
            className="btn-primary inline-flex items-center px-3 py-1.5 text-xs disabled:opacity-50"
          >
            {submitting === 'pending' ? 'Submitting…' : 'Submit request'}
          </button>
        </div>
      </form>
    </div>
  );
}
