import { useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import bgvVerifierAuthService from '../../services/bgvVerifierAuthService.js';
import VerifierShell from './VerifierShell.jsx';

// Phase 30.6 — one-time account setup. No temporary passwords exist; the
// verifier chooses their own password under the platform policy.
const BgvVerifierSetupPage = () => {
  const { setupToken } = useParams();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await bgvVerifierAuthService.setup(setupToken, password);
      setDone(true);
    } catch (requestError) {
      setError(requestError.message || 'Setup failed');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <VerifierShell title="Account activated">
        <p className="text-sm text-crewly-text">
          Your verifier account is active. Sign in through the dedicated BGV verifier login.
        </p>
        <Link to="/bgv-verifier/login" className="btn-primary mt-4 inline-flex w-full gap-2">
          <KeyRound className="h-4 w-4" /> Go to sign in
        </Link>
      </VerifierShell>
    );
  }

  return (
    <VerifierShell
      title="Choose your password"
      subtitle="Minimum 10 characters with upper, lower, number and special character. This link works once."
    >
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label">New password</label>
          <input className="input" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </div>
        <div>
          <label className="label">Confirm password</label>
          <input className="input" type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </div>
        {error ? <p role="alert" className="rounded-lg border border-crewly-red/30 bg-crewly-red/10 px-3 py-2 text-xs text-crewly-red">{error}</p> : null}
        <button type="submit" className="btn-primary w-full gap-2" disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} Activate account
        </button>
      </form>
    </VerifierShell>
  );
};

export default BgvVerifierSetupPage;
