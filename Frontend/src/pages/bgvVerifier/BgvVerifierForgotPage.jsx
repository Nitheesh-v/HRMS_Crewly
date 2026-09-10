import { useState } from 'react';
import { Loader2, MailQuestion } from 'lucide-react';
import { Link } from 'react-router-dom';
import bgvVerifierAuthService from '../../services/bgvVerifierAuthService.js';
import VerifierShell from './VerifierShell.jsx';

// Phase 30.6 — recovery request. The response is identical whether or not
// an account exists (account-enumeration resistance).
const BgvVerifierForgotPage = () => {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const result = await bgvVerifierAuthService.forgot(email);
      setMessage(result.message || 'If an account exists, a reset link has been sent.');
    } catch {
      setMessage('If an active BGV verifier account exists for this address, a reset link has been sent.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <VerifierShell title="Password recovery" subtitle="Reset links are one-time and expire in 30 minutes.">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label">Work email</label>
          <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
        </div>
        {message ? <p className="rounded-lg border border-crewly-green/30 bg-crewly-green/10 px-3 py-2 text-xs text-crewly-green">{message}</p> : null}
        <button type="submit" className="btn-primary w-full gap-2" disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MailQuestion className="h-4 w-4" />} Send reset link
        </button>
      </form>
      <div className="mt-4 text-center">
        <Link to="/bgv-verifier/login" className="text-xs text-crewly-dim hover:text-crewly-green">Back to sign in</Link>
      </div>
    </VerifierShell>
  );
};

export default BgvVerifierForgotPage;
