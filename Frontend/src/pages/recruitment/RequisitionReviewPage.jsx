import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Loader2,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import requisitionService from '../../services/requisitionService';
import Modal from '../../components/Modal';
import {
  PRIORITY_STYLE,
  RequisitionDetail,
  STATUS_STYLE,
  isoDate,
  money,
  pretty,
} from './RequisitionsPage';

const TABS = [
  { key: 'PENDING_HR', label: 'Pending', icon: Clock },
  { key: 'APPROVED', label: 'Approved', icon: CheckCircle2 },
  { key: 'SENT_BACK', label: 'Sent back', icon: RotateCcw },
  { key: 'REJECTED', label: 'Rejected', icon: XCircle },
];

const DECISIONS = [
  { key: 'APPROVE', label: 'Approve', className: 'btn-primary' },
  { key: 'SEND_BACK', label: 'Send back', className: 'btn-ghost' },
  { key: 'REJECT', label: 'Reject', className: 'btn-ghost text-crewly-red' },
];

const RequisitionReviewPage = () => {
  const [tab, setTab] = useState('PENDING_HR');
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState(null);
  const [review, setReview] = useState(null);
  const [reason, setReason] = useState('');

  const flash = (type, text) => {
    setBanner({ type, text });
    setTimeout(() => setBanner(null), 5000);
  };

  const load = useCallback(async () => {
    setLoading(true);

    try {
      const res = await requisitionService.list({ status: tab });

      setRows(Array.isArray(res) ? res : res?.data || []);
      setSummary(res?.meta?.summary || {});
    } catch (err) {
      flash('error', err?.message || 'Failed to load requisitions');
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    load();
  }, [load]);

  const decide = async (decision) => {
    if (decision !== 'APPROVE' && !reason.trim()) {
      return flash('error', 'A reason is required to reject or send back');
    }

    setBusy(true);

    try {
      await requisitionService.decide(review._id, decision, reason.trim());

      flash('success', `${review.code} ${pretty(decision).toLowerCase()}d`);
      setReview(null);
      setReason('');
      load();
    } catch (err) {
      flash('error', err?.message || 'Decision failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <ClipboardCheck size={22} className="text-indigo-400" />
          Requisition Review
        </h1>

        <p className="text-sm text-crewly-dim">
          Approve, reject or send back hiring requests raised by Managers and Team Leads.
        </p>
      </div>

      {banner && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            banner.type === 'error'
              ? 'border-crewly-red/40 bg-crewly-red/10 text-crewly-red'
              : 'border-crewly-green/40 bg-crewly-green/10 text-crewly-green'
          }`}
        >
          {banner.text}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {TABS.map((item) => (
          <button
            key={item.key}
            onClick={() => setTab(item.key)}
            className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm transition ${
              tab === item.key
                ? 'border-indigo-400 text-indigo-300'
                : 'border-crewly-border text-crewly-dim hover:border-indigo-400/60'
            }`}
          >
            <item.icon size={15} />
            {item.label}
            <span className="badge bg-white/10 text-crewly-dim">{summary[item.key] || 0}</span>
          </button>
        ))}
      </div>

      <div className="card overflow-x-auto p-0">
        {loading ? (
          <p className="flex items-center gap-2 p-6 text-sm text-crewly-dim">
            <Loader2 size={16} className="animate-spin" /> Loading…
          </p>
        ) : rows.length === 0 ? (
          <p className="p-6 text-sm text-crewly-dim">Nothing here right now.</p>
        ) : (
          <table className="w-full min-w-[900px] text-sm">
            <thead className="border-b border-crewly-border text-left text-xs uppercase text-crewly-dim">
              <tr>
                <th className="p-3">Reference</th>
                <th className="p-3">Position</th>
                <th className="p-3">Requester</th>
                <th className="p-3">Department</th>
                <th className="p-3">Openings</th>
                <th className="p-3">Budget</th>
                <th className="p-3">Priority</th>
                <th className="p-3">Joining</th>
                <th className="p-3 text-right">Action</th>
              </tr>
            </thead>

            <tbody>
              {rows.map((row) => (
                <tr key={row._id} className="border-b border-crewly-border/60 last:border-0">
                  <td className="p-3 font-mono text-xs">{row.code}</td>

                  <td className="p-3 font-medium">{row.position}</td>

                  <td className="p-3 text-crewly-dim">
                    {row.requester?.name || '—'}
                    <p className="text-xs">{pretty(row.requesterRole)}</p>
                  </td>

                  <td className="p-3 text-crewly-dim">{row.department?.name || '—'}</td>

                  <td className="p-3">{row.openings}</td>

                  <td className="p-3">{money(row.hiringBudget || row.maxSalary)}</td>

                  <td className="p-3">
                    <span className={`badge ${PRIORITY_STYLE[row.priority] || ''}`}>
                      {pretty(row.priority)}
                    </span>
                  </td>

                  <td className="p-3 text-crewly-dim">{isoDate(row.expectedJoiningDate) || '—'}</td>

                  <td className="p-3 text-right">
                    <button
                      onClick={() => {
                        setReview(row);
                        setReason('');
                      }}
                      className="rounded-lg border border-crewly-border px-3 py-1.5 text-xs hover:border-indigo-400"
                    >
                      {['PENDING_HR', 'SUBMITTED'].includes(row.status) ? 'Review' : 'View'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {review && (
        <Modal
          title={`${review.code} · ${review.position}`}
          onClose={() => setReview(null)}
        >
          <RequisitionDetail row={review} />

          {['PENDING_HR', 'SUBMITTED'].includes(review.status) && (
            <div className="mt-4 space-y-3 border-t border-crewly-border pt-4">
              <div>
                <label className="label">Reason / comments (required to reject or send back)</label>

                <textarea
                  rows="2"
                  className="input"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Budget approved for 2 openings only…"
                />
              </div>

              <div className="flex flex-wrap justify-end gap-2">
                {DECISIONS.map((decision) => (
                  <button
                    key={decision.key}
                    disabled={busy}
                    onClick={() => decide(decision.key)}
                    className={`${decision.className} gap-2`}
                  >
                    {busy && <Loader2 size={16} className="animate-spin" />}
                    {decision.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <p className="mt-3 text-xs text-crewly-dim">
            Approved requests become available for job creation in Phase 27.3.
          </p>
        </Modal>
      )}
    </div>
  );
};

export default RequisitionReviewPage;
