import { useEffect, useState } from 'react';
import leaveService from '../../services/leaveService.js';
import Modal from '../../components/Modal.jsx';
import { ROLE_STYLES, roleLabel } from '../../utils/roles.js';

const STATUS_STYLE = {
  APPROVED: 'bg-crewly-green/15 text-crewly-green',
  REJECTED: 'bg-crewly-red/15 text-crewly-red',
  CANCELLED: 'bg-white/10 text-crewly-dim',
};

const TYPE_BADGE = {
  CASUAL: 'bg-blue-400/15 text-blue-300',
  SICK: 'bg-purple-400/15 text-purple-300',
  EARNED: 'bg-yellow-400/15 text-yellow-300',
};

const LeaveApprovalsPage = () => {
  const [tab, setTab] = useState('pending');
  const [pending, setPending] = useState([]);
  const [history, setHistory] = useState([]);
  const [deciding, setDeciding] = useState(null); // { leave, action }
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const loadPending = () => leaveService.pending().then(setPending).catch((e) => setError(e.message));
  const loadHistory = () => leaveService.requests('ALL').then(setHistory).catch((e) => setError(e.message));

  useEffect(() => { loadPending(); loadHistory(); }, []);

  const submitDecision = async () => {
    setError(''); setSaving(true);
    try {
      await leaveService.decide(deciding.leave._id, deciding.action, note);
      setDeciding(null);
      setNote('');
      loadPending();
      loadHistory();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  };

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">✅ Leave Approvals</h1>

      {error && <div className="rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">{error}</div>}

      <div className="flex gap-2">
        {[['pending', `Pending (${pending.length})`], ['history', 'History']].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`rounded-lg px-4 py-2 text-sm transition ${tab === key ? 'bg-crewly-green/15 text-crewly-green' : 'border border-crewly-border text-crewly-dim hover:text-crewly-text'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* PENDING TAB */}
      {tab === 'pending' && (
        <div className="space-y-3">
          {pending.map((l) => (
            <div key={l._id} className="card flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="font-medium">
                  {l.user?.name}
                  <span className={`badge ml-2 ${ROLE_STYLES[l.user?.role]}`}>{roleLabel(l.user?.role)}</span>
                  <span className={`badge ml-2 ${TYPE_BADGE[l.type]}`}>{l.type}</span>
                </div>
                <div className="mt-1 text-sm text-crewly-dim">
                  {l.startDate} → {l.endDate} · <span className="text-crewly-text">{l.days} day(s)</span>
                  {l.user?.department?.name ? ` · ${l.user.department.name}` : ''}
                </div>
                <div className="mt-1 text-sm text-crewly-dim">"{l.reason}"</div>
              </div>
              <div className="flex gap-2">
                <button className="btn-primary px-4 py-2 text-sm" onClick={() => { setDeciding({ leave: l, action: 'APPROVE' }); setNote(''); }}>
                  ✓ Approve
                </button>
                <button className="rounded-lg border border-crewly-red/40 px-4 py-2 text-sm text-crewly-red hover:bg-crewly-red/10"
                  onClick={() => { setDeciding({ leave: l, action: 'REJECT' }); setNote(''); }}>
                  ✕ Reject
                </button>
              </div>
            </div>
          ))}
          {pending.length === 0 && <div className="card py-10 text-center text-crewly-dim">🎉 No pending requests — queue is clear.</div>}
        </div>
      )}

      {/* HISTORY TAB */}
      {tab === 'history' && (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-crewly-border text-crewly-dim">
                <th className="px-5 py-3">Employee</th>
                <th className="px-5 py-3">Dates</th>
                <th className="px-5 py-3">Type</th>
                <th className="px-5 py-3">Days</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Decided By</th>
              </tr>
            </thead>
            <tbody>
              {history.map((l) => (
                <tr key={l._id} className="border-b border-crewly-border/50 last:border-0">
                  <td className="px-5 py-3 font-medium">{l.user?.name}</td>
                  <td className="px-5 py-3 whitespace-nowrap">{l.startDate} → {l.endDate}</td>
                  <td className="px-5 py-3"><span className={`badge ${TYPE_BADGE[l.type]}`}>{l.type}</span></td>
                  <td className="px-5 py-3">{l.days}</td>
                  <td className="px-5 py-3"><span className={`badge ${STATUS_STYLE[l.status]}`}>{l.status}</span></td>
                  <td className="px-5 py-3 text-crewly-dim">
                    {l.approver?.name || '—'}
                    {l.approverNote && <div className="text-xs">📝 {l.approverNote}</div>}
                  </td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-crewly-dim">Nothing decided yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* DECIDE MODAL */}
      {deciding && (
        <Modal
          title={`${deciding.action === 'APPROVE' ? '✓ Approve' : '✕ Reject'} — ${deciding.leave.user?.name}`}
          onClose={() => setDeciding(null)}
        >
          <div className="space-y-3">
            <p className="text-sm text-crewly-dim">
              {deciding.leave.startDate} → {deciding.leave.endDate} · {deciding.leave.days} day(s) · {deciding.leave.type}
            </p>
            <div>
              <label className="label">Note (optional)</label>
              <textarea className="input" rows={2} maxLength={300} placeholder="e.g. Approved — project deadline is next week"
                value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <button
              onClick={submitDecision}
              disabled={saving}
              className={`w-full ${deciding.action === 'APPROVE'
                ? 'btn-primary'
                : 'inline-flex items-center justify-center rounded-lg bg-crewly-red px-5 py-2.5 font-semibold text-white hover:opacity-90 disabled:opacity-50'}`}
            >
              {saving ? 'Saving…' : `Confirm ${deciding.action === 'APPROVE' ? 'Approval' : 'Rejection'}`}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default LeaveApprovalsPage;