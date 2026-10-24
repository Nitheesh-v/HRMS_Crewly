import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import authService from "../../services/authService.js";
import useAuth from "../../hooks/useAuth.jsx";
import { getDashboardPath } from "../../utils/roles.js";
import AuthLayout from "../../layout/AuthLayout.jsx";
import PasswordField from "../../components/auth/PasswordField.jsx";
import { notify } from '../../utils/notify.js';

const REMEMBER_KEY = "crewly.rememberedLogin";

// Remembered company code / email (NEVER the password) — read once at
// first render instead of hydrating inside an effect.
const rememberedLogin = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(REMEMBER_KEY) || "null");
    if (saved?.companyCode || saved?.email) {
      return {
        form: { companyCode: saved.companyCode || "", email: saved.email || "", password: "" },
        remember: true,
      };
    }
  } catch {
    /* ignore malformed local data */
  }
  return { form: { companyCode: "", email: "", password: "" }, remember: false };
};

// Success states handed back by the reset / account-setup flows.
const noticeFor = (searchParams) => {
  if (searchParams.get("password") === "reset") {
    return "Your password has been changed. Sign in with your new password.";
  }
  if (searchParams.get("setup") === "complete") {
    return "Your account is set up. Sign in to get started.";
  }
  return "";
};

// The label style shared by every field on this screen: small, quiet, above the
// input (the reference drops labels entirely and relies on placeholders, which
// leaves a screen reader with nothing once the field has a value).
const labelClass = "mb-1.5 block text-[12px] font-medium tracking-[0.01em] text-crewly-void/60";
const errorClass = "mt-1.5 text-[11.5px] text-[#f0a184]";

const LoginPage = () => {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initial = rememberedLogin();

  /*
   * 35.1 — the "password changed" / "account is set up" notice that the reset
   * and setup flows hand back through the URL is a toast now: it is a message
   * about something that happened elsewhere, not a strip that belongs to the
   * form. Raised once, on arrival.
   */
  useEffect(() => {
    const notice = noticeFor(searchParams);

    if (notice) {
      notify.info(notice, { id: 'login-arrival-notice' });
    }
  }, [searchParams]);

  const [form, setForm] = useState(initial.form);
  const [remember, setRemember] = useState(initial.remember);
  const [fieldErrors, setFieldErrors] = useState({});
  const [loading, setLoading] = useState(false);

  const onChange = (e) => {
    const { name, value } = e.target;

    setForm((current) => ({ ...current, [name]: value }));
    // Clear the field's complaint as soon as the user starts fixing it.
    setFieldErrors((current) => (current[name] ? { ...current, [name]: "" } : current));
  };

  const canSubmit = form.companyCode.trim() && form.email.trim() && form.password;

  // Fast, local nudges. The server stays the authority on credentials.
  const validate = () => {
    const next = {};

    if (!form.companyCode.trim()) next.companyCode = "Enter the company code you registered with.";
    if (!form.email.trim()) next.email = "Enter your email address.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      next.email = "That does not look like an email address.";
    }
    if (!form.password) next.password = "Enter your password.";

    setFieldErrors(next);

    return Object.keys(next).length === 0;
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    /* 35.1 — nothing to report (failure state cleared) */
    /* 35.1 — nothing to report (failure state cleared) */

    if (!validate()) return;

    setLoading(true);
    try {
      if (remember) {
        localStorage.setItem(
          REMEMBER_KEY,
          JSON.stringify({ companyCode: form.companyCode, email: form.email }),
        );
      } else {
        localStorage.removeItem(REMEMBER_KEY);
      }
      const data = await authService.login(form);
      // 33.14 — the session arrives as HttpOnly cookies on this response:
      // the store keeps the profile only, never a token.
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
          Welcome back
        </h1>
        <p className="mt-3 text-[13.5px] text-crewly-void/55">
          New to Crewly?{" "}
          <Link to="/register" className="auth-link font-medium">
            Create an account
          </Link>
        </p>

        <form onSubmit={onSubmit} className="mt-8 space-y-4" noValidate aria-busy={loading}>
          <div>
            <label htmlFor="companyCode" className={labelClass}>
              Company code
            </label>
            <input
              id="companyCode"
              name="companyCode"
              className="auth-input"
              placeholder="e.g. acme"
              value={form.companyCode}
              onChange={onChange}
              autoComplete="organization"
              autoFocus={!initial.form.companyCode}
              aria-invalid={fieldErrors.companyCode ? "true" : undefined}
              aria-describedby={fieldErrors.companyCode ? "companyCode-error" : "companyCode-hint"}
              required
            />
            {fieldErrors.companyCode ? (
              <p id="companyCode-error" className={errorClass}>
                {fieldErrors.companyCode}
              </p>
            ) : (
              <p id="companyCode-hint" className="mt-1.5 text-[11.5px] text-crewly-void/35">
                Sent to you at registration. Super Admins use CREWLY.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="email" className={labelClass}>
              Email address
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
              autoFocus={Boolean(initial.form.companyCode) && !initial.form.email}
              aria-invalid={fieldErrors.email ? "true" : undefined}
              aria-describedby={fieldErrors.email ? "email-error" : undefined}
              required
            />
            {fieldErrors.email && (
              <p id="email-error" className={errorClass}>
                {fieldErrors.email}
              </p>
            )}
          </div>

          <div>
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <label htmlFor="password" className={`${labelClass} mb-0`}>
                Password
              </label>
              <Link
                to="/forgot-password"
                className="auth-link text-[11.5px] font-medium"
              >
                Forgot password?
              </Link>
            </div>
            <PasswordField
              id="password"
              name="password"
              value={form.password}
              onChange={onChange}
              placeholder="Your password"
              invalid={Boolean(fieldErrors.password)}
              describedBy={fieldErrors.password ? "password-error" : undefined}
            />
            {fieldErrors.password && (
              <p id="password-error" className={errorClass}>
                {fieldErrors.password}
              </p>
            )}
          </div>

          <label className="flex w-fit cursor-pointer items-center gap-2.5 text-[12.5px] text-crewly-void/60 select-none">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-4 w-4 cursor-pointer rounded-[4px] accent-crewly-lilac"
            />
            Keep me signed in on this device
          </label>

          <button type="submit" disabled={loading || !canSubmit} className="auth-primary mt-2">
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Signing in…
              </>
            ) : (
              "Sign in"
            )}
          </button>
        </form>

        <p className="mt-7 text-[11.5px] text-crewly-void/35">
          SaaS provider?{" "}
          <Link to="/super-admin/login" className="auth-link">
            Super Admin portal
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
};

export default LoginPage;
