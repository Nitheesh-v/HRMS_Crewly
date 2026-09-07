import { useCallback, useEffect, useState } from 'react';
import {
  BadgeCheck,
  Loader2,
  MailOpen,
  ShieldOff,
  ShieldCheck,
  UserPlus,
  UserX,
} from 'lucide-react';
import superAdminService from '../../services/superAdminService.js';

const SPECIALIZATIONS = ['IDENTITY', 'ADDRESS', 'EDUCATION', 'EMPLOYMENT', 'REFERENCE'];

const inputClass =
  'w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-orange-400 focus:outline-none';

const STATUS_STYLE = {
  INVITED: 'bg-amber-500/10 text-amber-300',
  ACTIVE: 'bg-emerald-500/10 text-emerald-300',
  DEACTIVATED: 'bg-rose-500/10 text-rose-300',
};

// Phase 30.6 — Super Admin management of internal BGV verifiers.
// No temporary passwords: invites send a one-time setup link by email.
const SuperAdminBgvVerifiersPage = () => {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteForm, setInviteForm] = useState({ name: '', email: '', specializations: [] });

  const [editRow, setEditRow] = useState(null);
  const [editSpecializations, setEditSpecializations] = useState([]);
  const [deactivateRow, setDeactivateRow] = useState(null);

  const load = useCallback(async () => {
    try {
      const result = await superAdminService.bgvVerifiers();
      setRows(result.verifiers || []);
    } catch (requestError) {
      setError(requestError?.response?.data?.message || requestError.message || 'Could not load verifiers');
    }
  }, []);

  useEffect(() => {
    document.title = 'BGV Verifiers — Crewly Control';
    load();
  }, [load]);

  const run = async (key, action, message) => {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(message);
      await load();
    } catch (requestError) {
      setError(requestError?.response?.data?.message || requestError.message || 'Action failed');
    } finally {
      setBusy('');
    }
  };

  const toggleSpecialization = (list, value) =>
    list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];

  const submitInvite = (event) => {
    event.preventDefault();
    run(
      'invite',
      () => superAdminService.inviteBgvVerifier(inviteForm),
      'Verifier invited — a secure setup link was emailed; no password was created'
    ).then(() => {
      setInviteOpen(false);
      setInviteForm({ name: '', email: '', specializations: [] });
    });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">BGV Verifiers</h1>
          <p className="text-xs text-slate-500">
            Internal Crewly/Infolexus verification operators. Invitations never include passwords;
            specializations mark eligibility only — case access begins with assignment (next phase).
          </p>
        </div>
        <button type="button" className="btn-primary gap-2" onClick={() => setInviteOpen(true)}>
          <UserPlus className="h-4 w-4" /> Invite verifier
        </button>
      </div>

      {notice ? (
        <p className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">{notice}</p>
      ) : null}
      {error ? (
        <p className="rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>
      ) : null}

      {rows === null ? (
        <div className="flex items-center justify-center py-16 text-slate-500">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading verifiers…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-10 text-center">
          <ShieldCheck className="mx-auto h-8 w-8 text-slate-600" />
          <p className="mt-3 text-sm text-slate-400">No BGV verifiers yet.</p>
          <p className="mt-1 text-xs text-slate-600">Invite your first verifier to start building the internal verification team.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((verifier) => (
            <div key={verifier.id} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-slate-100">{verifier.name}</p>
                  <p className="text-xs text-slate-500">{verifier.email}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {(verifier.specializations || []).map((specialization) => (
                      <span key={specialization} className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-950/60 px-2 py-0.5 text-[10px] text-slate-300">
                        <BadgeCheck className="h-3 w-3 text-orange-300" /> {specialization}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="text-right">
                  <span className={`badge ${STATUS_STYLE[verifier.status] || 'bg-slate-800 text-slate-400'}`}>
                    {String(verifier.status).replaceAll('_', ' ')}
                  </span>
                  <p className="mt-2 text-[11px] text-slate-500">
                    {verifier.setupCompletedAt
                      ? `Setup completed ${new Date(verifier.setupCompletedAt).toLocaleDateString()}`
                      : 'Setup pending — invitation outstanding'}
                  </p>
                  <p className="text-[11px] text-slate-600">
                    {verifier.lastLoginAt ? `Last sign-in ${new Date(verifier.lastLoginAt).toLocaleString()}` : 'Never signed in'}
                  </p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-800 pt-3">
                <button
                  type="button"
                  className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-orange-400"
                  onClick={() => {
                    setEditRow(verifier);
                    setEditSpecializations(verifier.specializations || []);
                  }}
                >
                  Edit specializations
                </button>
                {!verifier.setupCompletedAt && verifier.status === 'INVITED' ? (
                  <>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-orange-400"
                      disabled={busy === `resend-${verifier.id}`}
                      onClick={() => run(`resend-${verifier.id}`, () => superAdminService.resendBgvVerifierSetup(verifier.id), 'Setup invitation resent — previous link invalidated')}
                    >
                      {busy === `resend-${verifier.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MailOpen className="h-3.5 w-3.5" />} Resend setup
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-400 hover:border-rose-400"
                      disabled={busy === `revoke-${verifier.id}`}
                      onClick={() => run(`revoke-${verifier.id}`, () => superAdminService.revokeBgvVerifierSetup(verifier.id), 'Outstanding setup invitation revoked')}
                    >
                      Revoke invitation
                    </button>
                  </>
                ) : null}
                {verifier.status !== 'DEACTIVATED' ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-rose-300 hover:border-rose-400"
                    onClick={() => setDeactivateRow(verifier)}
                  >
                    <UserX className="h-3.5 w-3.5" /> Deactivate
                  </button>
                ) : (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-emerald-300 hover:border-emerald-400"
                    disabled={busy === `reactivate-${verifier.id}`}
                    onClick={() => run(`reactivate-${verifier.id}`, () => superAdminService.reactivateBgvVerifier(verifier.id), 'Verifier reactivated')}
                  >
                    <ShieldCheck className="h-3.5 w-3.5" /> Reactivate
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── invite dialog ── */}
      {inviteOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <form onSubmit={submitInvite} className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-5">
            <h2 className="font-semibold text-white">Invite BGV verifier</h2>
            <p className="mt-1 text-xs text-slate-500">
              The verifier receives a one-time setup link by email and chooses their own password. No candidate data is included.
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-xs text-slate-400">Full name</label>
                <input className={inputClass} required value={inviteForm.name} onChange={(e) => setInviteForm({ ...inviteForm, name: e.target.value })} />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Work email</label>
                <input className={inputClass} type="email" required value={inviteForm.email} onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })} />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Specializations (the five approved checks)</label>
                <div className="flex flex-wrap gap-2">
                  {SPECIALIZATIONS.map((specialization) => (
                    <button
                      key={specialization}
                      type="button"
                      onClick={() => setInviteForm({ ...inviteForm, specializations: toggleSpecialization(inviteForm.specializations, specialization) })}
                      className={`rounded-full border px-3 py-1 text-xs ${
                        inviteForm.specializations.includes(specialization)
                          ? 'border-orange-400 bg-orange-500/15 text-orange-300'
                          : 'border-slate-700 text-slate-400'
                      }`}
                    >
                      {specialization}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300" onClick={() => setInviteOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="btn-primary gap-2 !py-2 text-sm" disabled={busy === 'invite' || inviteForm.specializations.length === 0}>
                {busy === 'invite' ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />} Send invitation
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {/* ── edit specializations dialog ── */}
      {editRow ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-5">
            <h2 className="font-semibold text-white">Specializations — {editRow.name}</h2>
            <p className="mt-1 text-xs text-slate-500">Eligibility for future assignment types only; never candidate access by itself.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {SPECIALIZATIONS.map((specialization) => (
                <button
                  key={specialization}
                  type="button"
                  onClick={() => setEditSpecializations(toggleSpecialization(editSpecializations, specialization))}
                  className={`rounded-full border px-3 py-1 text-xs ${
                    editSpecializations.includes(specialization)
                      ? 'border-orange-400 bg-orange-500/15 text-orange-300'
                      : 'border-slate-700 text-slate-400'
                  }`}
                >
                  {specialization}
                </button>
              ))}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300" onClick={() => setEditRow(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary !py-2 text-sm"
                disabled={busy === `edit-${editRow.id}` || editSpecializations.length === 0}
                onClick={() =>
                  run(
                    `edit-${editRow.id}`,
                    () => superAdminService.updateBgvVerifier(editRow.id, { specializations: editSpecializations }),
                    'Specializations updated'
                  ).then(() => setEditRow(null))
                }
              >
                {busy === `edit-${editRow.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── deactivation confirmation ── */}
      {deactivateRow ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-5">
            <div className="flex items-start gap-3">
              <ShieldOff className="h-5 w-5 text-rose-300" />
              <div>
                <h2 className="font-semibold text-white">Deactivate {deactivateRow.name}?</h2>
                <p className="mt-1 text-xs text-slate-500">
                  Active sessions are revoked immediately and new sign-ins are blocked. The account
                  record and all history are preserved; you can reactivate later.
                </p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300" onClick={() => setDeactivateRow(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700"
                disabled={busy === `deactivate-${deactivateRow.id}`}
                onClick={() =>
                  run(
                    `deactivate-${deactivateRow.id}`,
                    () => superAdminService.deactivateBgvVerifier(deactivateRow.id, {}),
                    'Verifier deactivated — sessions revoked'
                  ).then(() => setDeactivateRow(null))
                }
              >
                {busy === `deactivate-${deactivateRow.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Deactivate
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default SuperAdminBgvVerifiersPage;
