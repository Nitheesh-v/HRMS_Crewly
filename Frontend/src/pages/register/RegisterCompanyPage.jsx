import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Check, Loader2 } from 'lucide-react';
import authService from '../../services/authService.js';
import useAuth from "../../hooks/useAuth.jsx"
import { getDashboardPath } from '../../utils/roles.js';
import AuthLayout from '../../layout/AuthLayout.jsx';
import PasswordField from '../../components/auth/PasswordField.jsx';
import { notify } from '../../utils/notify.js';
import { BRAND } from '../landing/landingData.js';

const labelClass = 'mb-1.5 block text-[12px] font-medium tracking-[0.01em] text-crewly-void/60';
const errorClass = 'mt-1.5 text-[11.5px] text-[#f0a184]';

const RegisterCompanyPage = () => {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({ companyName: '', adminName: '', email: '', password: '', confirmPassword: '' });
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
    /* 35.1 — nothing to report (failure state cleared) */

    if (form.password !== form.confirmPassword) {
      return notify.error('Passwords do not match');
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
      notify.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout>
      <div className="w-full max-w-[400px]">
        <h1 className="auth-display text-[38px] leading-[1.04] text-crewly-void sm:text-[44px]">
          Create your workspace
        </h1>
        <p className="mt-3 text-[13.5px] text-crewly-void/55">
          Already have an account?{' '}
          <Link to="/login" className="auth-link font-medium">
            Log in
          </Link>
        </p>

        <form onSubmit={onSubmit} className="mt-8 space-y-3.5" noValidate aria-busy={loading}>
          <div>
            <label htmlFor="companyName" className={labelClass}>
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
              <p id="companyName-error" className={errorClass}>
                {fieldErrors.companyName}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="adminName" className={labelClass}>
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
              <p id="adminName-error" className={errorClass}>
                {fieldErrors.adminName}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="email" className={labelClass}>
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
              aria-describedby={fieldErrors.email ? 'email-error' : 'email-hint'}
              required
            />
            {fieldErrors.email ? (
              <p id="email-error" className={errorClass}>
                {fieldErrors.email}
              </p>
            ) : (
              <p id="email-hint" className="mt-1.5 text-[11.5px] text-crewly-void/35">
                This becomes the Company Admin login for the workspace.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="password" className={labelClass}>
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
              <p id="password-error" className={errorClass}>
                {fieldErrors.password}
              </p>
            ) : (
              // Show the rule state only once the user starts typing: a silent
              // checklist before the first keystroke is noise, not help.
              form.password.length > 0 && (
                <p
                  className={`mt-1.5 flex items-center gap-1.5 text-[11.5px] ${
                    longEnough ? 'text-[#b9e3c6]' : 'text-crewly-void/35'
                  }`}
                >
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  At least 6 characters
                </p>
              )
            )}
          </div>

          <div>
            <label htmlFor="confirmPassword" className={labelClass}>
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
              <p id="confirmPassword-error" className={errorClass}>
                {fieldErrors.confirmPassword}
              </p>
            )}
          </div>

          <button type="submit" disabled={loading || !canSubmit} className="auth-primary mt-1">
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Creating your workspace…
              </>
            ) : (
              'Create account'
            )}
          </button>

          {/* The old copy said you agree to Terms and a Privacy Policy that this
              product has not published. The honest version is what the trial
              actually is. */}
          <p className="text-[11.5px] leading-relaxed text-crewly-void/35">
            {BRAND.trialDays}-day trial · no card at signup · cancel into read-only, nothing deleted
          </p>
        </form>
      </div>
    </AuthLayout>
  );
};

export default RegisterCompanyPage;
