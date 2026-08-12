import { useCallback, useEffect, useState } from 'react';
import exitService from '../../services/exitService';
import Modal from '../../components/Modal';
import * as authHook from '../../hooks/useAuth';
import { ROLES, roleLabel } from '../../utils/roles';

const useAuth = authHook.useAuth || authHook.default;

const STATUS_STYLE = {
  PENDING: 'bg-crewly-orange/15 text-crewly-orange',
  APPROVED: 'bg-crewly-green/15 text-crewly-green',
  REJECTED: 'bg-crewly-red/15 text-crewly-red',
  WITHDRAWN: 'bg-crewly-border/40 text-crewly-dim',
};
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const todayInput = () => new Date().toISOString().slice(0, 10);

export default function ExitProcessPage() {
  const { user: me } = useAuth();
  const isHR = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER].includes(me?.role);

  const [mine, setMine] = useState([]);
  const [requests, setRequests] = useState([]);
  const [tab, setTab] = useState('PENDING');
  const [banner, setBanner] = useState(null);
  const [loading, setLoading] = useState(true);

  const [resignModal, setResignModal] = useState(false);
  const [form, setForm] = useState({ reason: '', lastWorkingDate: '' });
  const [decideModal, setDecideModal] = useState(null); // { resignation, action }
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const flash = (type, text) => { setBanner({ type, text }); setTimeout(() => setBanner(null), 6000); };
  const errText = (err) => err?.response?.data?.message || err?.message || 'Something went wrong';

  const loadMine = useCallback(async () => {
    try {
      const list = await exitService.my();
      setMine(Array.isArray(list) ? list : []);
    } catch (err) { flash('error', errText(err)); } finally { setLoading(false); }
  }, []);

  const loadRequests = useCallback(async () => {
    if (!isHR) return;
    try {
      const list = await exitService.requests(tab === 'ALL' ? '' : tab);
      setRequests(Array.isArray(list) ? list : []);
    } catch (err) { flash('error', errText(err)); }
  }, [isHR, tab]);

  useEffect(() => { loadMine(); }, [loadMine]);
  useEffect(() => { loadRequests(); }, [loadRequests]);

  const activeResignation = mine.find((r) => r.status === 'PENDING');

  const submitResign = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await exitService.resign(form);
      flash('success', 'Resignation submitted. HR will review it. 📨');
      setResignModal(false);
      setForm({ reason: '', lastWorkingDate: '' });
      loadMine();
      loadRequests();
    } catch (err) { flash('error', errText(err)); } finally { setBusy(false); }
  };

  const withdraw = async (r) => {
    try {
      await exitService.withdraw(r._id);
      flash('success', 'Resignation withdrawn');
      loadMine();
    } catch (err) { flash('error', errText(err)); }
  };

  const submitDecision = async () => {
    setBusy(true);
    try {
      const res = await exitService.decide(decideModal.resignation._id, {
        action: decideModal.action, note,
      });
      flash('success', res?.message || `Resignation ${decideModal.action.toLowerCase()}d`);
      setDecideModal(null);
      setNote('');
      loadRequests();
      loadMine();
    } catch (err) { flash('error', errText(err)); } finally { setBusy(false); }
  };

  const myId = String(me?._id || me?.id || '');

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">🚪 Exit Process</h1>
          <p className="text-sm text-crewly-dim">Resignations, approvals and account deactivation.</p>
        </div>
        {!activeResignation && (
          <button className="btn-primary" onClick={() => setResignModal(true)}>📝 Submit Resignation</button>
        )}
      </div>

      {banner && (
        <div className={`card px-4 py-3 text-sm ${banner.type === 'error' ? 'text-crewly-red' : 'text-crewly-green'}`}>{banner.text}</div>
      )}

      {/* ── my resignation ── */}
      <div className="card p-5 space-y-3">
        <h2 className="text-sm font-semibold">🙋 My Resignation</h2>
        {loading ? (
          <p className="text-sm text-crewly-dim">Loading…</p>
        ) : mine.length === 0 ? (
          <p className="text-sm text-crewly-dim">No resignation submitted. We hope it stays that way 💚</p>
        ) : (
          <div className="space-y-2">
            {mine.map((r) => (
              <div key={r._id} className="rounded-lg border border-crewly-border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`badge ${STATUS_STYLE[r.status]}`}>{r.status}</span>
                  <span className="text-crewly-dim text-xs">Last working day: {fmtDate(r.lastWorkingDate)}</span>
                  <span className="text-crewly-dim text-xs ml-auto">submitted {fmtDate(r.createdAt)}</span>
                  {r.status === 'PENDING' && (
                    <button className="btn-ghost px-2 py-0.5 text-[11px] text-crewly-red" onClick={() => withdraw(r)}>Withdraw</button>
                  )}
                </div>
                <p className="mt-1 text-crewly-text">{r.reason}</p>
                {r.decisionNote && <p className="mt-1 text-xs text-crewly-dim">HR note ({r.decidedBy?.name}): {r.decisionNote}</p>}
                {r.status === 'APPROVED' && (
                  <p className="mt-1 text-xs text-crewly-orange">Your account will be deactivated after {fmtDate(r.lastWorkingDate)}.</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── HR: team requests ── */}
      {isHR && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">🗂️ Team Requests</h2>
            <div className="flex gap-2">
              {[['PENDING', 'Pending'], ['ALL', 'All']].map(([key, label]) => (
                <button key={key} onClick={() => setTab(key)}
                  className={`rounded-lg px-3 py-1.5 text-xs transition ${tab === key ? 'bg-crewly-green/15 text-crewly-green' : 'border border-crewly-border text-crewly-dim'}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="card overflow-x-auto p-0">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-crewly-border text-crewly-dim">
                  <th className="px-4 py-3">Employee</th>
                  <th className="px-4 py-3">Reason</th>
                  <th className="px-4 py-3">Last Working Day</th>
                  <th className="px-4 py-3">Submitted</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Account</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {requests.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-crewly-dim">No resignation requests 🎉</td></tr>
                ) : requests.map((r) => (
                  <tr key={r._id} className="border-b border-crewly-border/50 last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-medium">{r.user?.name}</div>
                      <div className="text-xs text-crewly-dim">{r.user?.role ? roleLabel(r.user.role) : ''} · {r.user?.email}</div>
                    </td>
                    <td className="px-4 py-3 max-w-[220px] truncate" title={r.reason}>{r.reason}</td>
                    <td className="px-4 py-3">{fmtDate(r.lastWorkingDate)}</td>
                    <td className="px-4 py-3 text-crewly-dim text-xs">{fmtDate(r.createdAt)}</td>
                    <td className="px-4 py-3"><span className={`badge ${STATUS_STYLE[r.status]}`}>{r.status}</span></td>
                    <td className="px-4 py-3">
                      <span className={`badge ${r.user?.status === 'ACTIVE' ? 'text-crewly-green' : 'text-crewly-red'}`}>
                        {r.user?.status || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {r.status === 'PENDING' && String(r.user?._id) !== myId && (
                        <div className="flex justify-end gap-2">
                          <button className="rounded-lg border border-crewly-green/40 px-2 py-1 text-[11px] text-crewly-green hover:bg-crewly-green/10"
                            onClick={() => setDecideModal({ resignation: r, action: 'APPROVE' })}>✅ Approve</button>
                          <button className="rounded-lg border border-crewly-red/40 px-2 py-1 text-[11px] text-crewly-red hover:bg-crewly-red/10"
                            onClick={() => setDecideModal({ resignation: r, action: 'REJECT' })}>❌ Reject</button>
                        </div>
                      )}
                      {r.status !== 'PENDING' && r.decisionNote && (
                        <span className="text-[11px] text-crewly-dim" title={r.decisionNote}>📝 {r.decisionNote}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── resign modal ── */}
      {resignModal && (
        <Modal onClose={() => setResignModal(false)} title="📝 Submit Resignation">
          <form onSubmit={submitResign} className="space-y-3">
            <div>
              <label className="label">Reason *</label>
              <textarea className="input" rows={3} minLength={10} maxLength={500} required
                value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                placeholder="Tell us briefly why you're leaving (min 10 characters)" />
            </div>
            <div>
              <label className="label">Last Working Date *</label>
              <input className="input" type="date" required min={todayInput()}
                value={form.lastWorkingDate} onChange={(e) => setForm((f) => ({ ...f, lastWorkingDate: e.target.value }))} />
            </div>
            <p className="text-xs text-crewly-dim">HR will review your request. You can withdraw it while it's pending.</p>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setResignModal(false)}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Submitting…' : 'Submit'}</button>
            </div>
          </form>
        </Modal>
      )}

      {/* ── decide modal ── */}
      {decideModal && (
        <Modal onClose={() => setDecideModal(null)}
          title={`${decideModal.action === 'APPROVE' ? '✅ Approve' : '❌ Reject'} — ${decideModal.resignation.user?.name}`}>
          <div className="space-y-3">
            <div className="rounded-lg border border-crewly-border p-3 text-sm">
              <p>{decideModal.resignation.reason}</p>
              <p className="mt-1 text-xs text-crewly-dim">Last working day: {fmtDate(decideModal.resignation.lastWorkingDate)}</p>
            </div>
            {decideModal.action === 'APPROVE' && (
              <p className="text-xs text-crewly-orange">
                ⚠️ Approving will deactivate this account on/after the last working date.
              </p>
            )}
            <div>
              <label className="label">Note (optional)</label>
              <textarea className="input" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="Add a note for the employee" />
            </div>
            <div className="flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setDecideModal(null)}>Cancel</button>
              <button
                className={decideModal.action === 'APPROVE' ? 'btn-primary' : 'btn-ghost text-crewly-red'}
                disabled={busy} onClick={submitDecision}>
                {busy ? 'Saving…' : `Confirm ${decideModal.action === 'APPROVE' ? 'Approval' : 'Rejection'}`}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}