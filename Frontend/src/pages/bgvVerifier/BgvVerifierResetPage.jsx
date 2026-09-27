import { useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import bgvVerifierAuthService from '../../services/bgvVerifierAuthService.js';
import VerifierShell from './VerifierShell.jsx';
import { notify } from '../../utils/notify.js';

// Phase 30.6 — one-time reset link; sessions are signed out on change.
const BgvVerifierResetPage = () => {
  const { resetToken } = useParams();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (event) => {
    event.preventDefault();

    if (password !== confirm) {
      notify.warning('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await bgvVerifierAuthService.reset(resetToken, password);
      setDone(true);
    } catch (requestError) {
      notify.error(requestError, 'Reset failed');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <VerifierShell title="Password changed">
        <p className="text-sm text-crewly-text">All previous sessions were signed out. Sign in with your new password.</p>
        <Link to="/bgv-verifier/login" className="btn-primary mt-4 inline-flex w-full gap-2">
          <KeyRound className="h-4 w-4" /> Go to sign in
        </Link>
      </VerifierShell>
    );
  }

  return (
    <VerifierShell title="Choose a new password" subtitle="Minimum 10 characters with upper, lower, number and special character.">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label">New password</label>
          <input className="input" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </div>
        <div>
          <label className="label">Confirm password</label>
          <input className="input" type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </div>

        <button type="submit" className="btn-primary w-full gap-2" disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} Change password
        </button>
      </form>
    </VerifierShell>
  );
};

export default BgvVerifierResetPage;
