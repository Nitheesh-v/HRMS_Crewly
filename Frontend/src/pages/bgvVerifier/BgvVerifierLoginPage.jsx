import { useEffect, useState } from 'react';
import { Loader2, LogIn } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import bgvVerifierAuthService from '../../services/bgvVerifierAuthService.js';
import VerifierShell from './VerifierShell.jsx';
import { notify } from '../../utils/notify.js';

// Phase 30.6 — dedicated verifier login (never the tenant HRMS login).
const BgvVerifierLoginPage = () => {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = 'Crewly BGV Operations — Sign in';
    if (bgvVerifierAuthService.getToken()) navigate('/bgv-verifier', { replace: true });
  }, [navigate]);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);

    try {
      const result = await bgvVerifierAuthService.login({ email, password, challengeId, code });
      if (result.requiresTwoFactor) {
        setChallengeId(result.challengeId);
        setBusy(false);
        return;
      }
      bgvVerifierAuthService.setToken(result.token);
      navigate('/bgv-verifier', { replace: true });
    } catch (requestError) {
      notify.error(requestError, 'Sign-in failed');
      setBusy(false);
    }
  };

  return (
    <VerifierShell title="Verifier sign in" subtitle="Internal BGV operations only — tenant HRMS and platform consoles are separate portals.">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label">Work email</label>
          <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
        </div>
        <div>
          <label className="label">Password</label>
          <input className="input" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </div>
        {challengeId ? (
          <div>
            <label className="label">Verification code (emailed to you)</label>
            <input className="input" inputMode="numeric" required value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" />
          </div>
        ) : null}

        <button type="submit" className="btn-primary w-full gap-2" disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />} Sign in
        </button>
      </form>
      <div className="mt-4 text-center">
        <Link to="/bgv-verifier/forgot-password" className="text-xs text-crewly-dim hover:text-crewly-green">
          Forgot your password?
        </Link>
      </div>
    </VerifierShell>
  );
};

export default BgvVerifierLoginPage;
