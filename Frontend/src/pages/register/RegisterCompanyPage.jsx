import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertCircle, Check, Loader2 } from 'lucide-react';
import authService from '../../services/authService.js';
import useAuth from "../../hooks/useAuth.jsx"
import { getDashboardPath } from '../../utils/roles.js';
import AuthLayout from '../../layout/AuthLayout.jsx';
import PasswordField from '../../components/auth/PasswordField.jsx';

const RegisterCompanyPage = () => {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({ companyName: '', adminName: '', email: '', password: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [loading, setLoading] = useState(false);

  const onChange = (e) => {
    const { name, value } = e.target;

    setForm((current) => ({ ...current, [name]: value }));
    setFieldErrors((current) => (current[name] ? { ...current, [name]: '' } : current));
  };

  const mismatch = form.confirmPassword && form.password !== form.confirmPassword;
  const longEnough = form.password.length >= 6;
  const canSubmit =
    form.companyName.trim() && form.adminName.trim() && form.email.trim() &&
    longEnough && form.confirmPassword && !mismatch;

  const validate = () => {
    const next = {};

    if (!form.companyName.trim()) next.companyName = 'Enter your company name.';
    if (!form.adminName.trim()) next.adminName = 'Enter your full name.';
    if (!form.email.trim()) next.email = 'Enter your work email.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      next.email = 'That does not look like an email address.';
    }
    if (!longEnough) next.password = 'Use at least 6 characters.';
    if (!form.confirmPassword) next.confirmPassword = 'Re-type your password.';
    else if (mismatch) next.confirmPassword = 'Passwords do not match yet.';

    setFieldErrors(next);

    return Object.keys(next).length === 0;
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (form.password !== form.confirmPassword) {
      return setError('Passwords do not match');
    }

    if (!validate()) return;

    setLoading(true);
    try {
      const payload = { ...form };
      delete payload.confirmPassword;
      const data = await authService.registerCompany(payload);
      // 33.14 — auto login after register: cookies are set by the server,
      // so only the profile goes into the store.
      login(data.user);
      navigate(getDashboardPath(data.user.role), { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout variant="split" visualSide="right">
      <div className="mx-auto w-full max-w-sm">
        <h1 className="text-2xl font-bold tracking-tight text-white sm:text-[28px]">
          Set up your workspace
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Free for 14 days. Your Company Admin account is created automatically.
        </p>

        {error && (
          <div
            role="alert"
            className="mt-5 flex items-start gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate aria-busy={loading}>
          <div>
            <label htmlFor="companyName" className="mb-1.5 block text-sm font-medium text-slate-200">
              Company name
            </label>
            <input
              id="companyName"
              name="companyName"
              className="auth-input"
              placeholder="e.g. Unpixel Technologies"
              value={form.companyName}
              onChange={onChange}
              autoComplete="organization"
              autoFocus
              aria-invalid={fieldErrors.companyName ? 'true' : undefined}
              aria-describedby={fieldErrors.companyName ? 'companyName-error' : undefined}
              required
            />
            {fieldErrors.companyName && (
              <p id="companyName-error" className="mt-1.5 text-xs text-rose-300">
                {fieldErrors.companyName}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="adminName" className="mb-1.5 block text-sm font-medium text-slate-200">
              Your name
            </label>
            <input
              id="adminName"
              name="adminName"
              className="auth-input"
              placeholder="Full name"
              value={form.adminName}
              onChange={onChange}
              autoComplete="name"
              aria-invalid={fieldErrors.adminName ? 'true' : undefined}
              aria-describedby={fieldErrors.adminName ? 'adminName-error' : undefined}
              required
            />
            {fieldErrors.adminName && (
              <p id="adminName-error" className="mt-1.5 text-xs text-rose-300">
                {fieldErrors.adminName}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-slate-200">
              Work email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              className="auth-input"
              placeholder="you@company.com"
              value={form.email}
              onChange={onChange}
              autoComplete="email"
              inputMode="email"
              aria-invalid={fieldErrors.email ? 'true' : undefined}
              aria-describedby={fieldErrors.email ? 'email-error' : undefined}
              required
            />
            {fieldErrors.email && (
              <p id="email-error" className="mt-1.5 text-xs text-rose-300">
                {fieldErrors.email}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-slate-200">
              Password
            </label>
            <PasswordField
              id="password"
              name="password"
              value={form.password}
              onChange={onChange}
              placeholder="At least 6 characters"
              autoComplete="new-password"
              minLength={6}
              maxLength={128}
              invalid={Boolean(fieldErrors.password)}
              describedBy={fieldErrors.password ? 'password-error' : undefined}
            />
            {fieldErrors.password ? (
              <p id="password-error" className="mt-1.5 text-xs text-rose-300">
                {fieldErrors.password}
              </p>
            ) : (
              // Show the rule state only once the user starts typing: a silent
              // checklist before the first keystroke is noise, not help.
              form.password.length > 0 && (
                <p
                  className={`mt-1.5 flex items-center gap-1.5 text-xs ${
                    longEnough ? 'text-emerald-300' : 'text-slate-500'
                  }`}
                >
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  At least 6 characters
                </p>
              )
            )}
          </div>

          <div>
            <label htmlFor="confirmPassword" className="mb-1.5 block text-sm font-medium text-slate-200">
              Confirm password
            </label>
            <PasswordField
              id="confirmPassword"
              name="confirmPassword"
              value={form.confirmPassword}
              onChange={onChange}
              placeholder="Re-type your password"
              autoComplete="new-password"
              required={false}
              invalid={mismatch || Boolean(fieldErrors.confirmPassword)}
              describedBy={fieldErrors.confirmPassword ? 'confirmPassword-error' : undefined}
            />
            {fieldErrors.confirmPassword && (
              <p id="confirmPassword-error" className="mt-1.5 text-xs text-rose-300">
                {fieldErrors.confirmPassword}
              </p>
            )}
          </div>

          <button type="submit" disabled={loading || !canSubmit} className="auth-primary">
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Creating your workspace…
              </>
            ) : (
              'Create account'
            )}
          </button>

          <p className="text-center text-xs leading-relaxed text-slate-500">
            By creating an account you agree to the Terms &amp; Conditions and the
            Privacy Policy.
          </p>
        </form>

        <p className="mt-6 text-center text-sm text-slate-400">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-emerald-400 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
};

export default RegisterCompanyPage;
