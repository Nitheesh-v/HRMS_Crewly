import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import authService from "../../services/authService.js";
import useAuth from "../../hooks/useAuth.jsx";
import { getDashboardPath } from "../../utils/roles.js";
import AuthLayout from "../../layout/AuthLayout.jsx";
import PasswordField from "../../components/auth/PasswordField.jsx";

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

const LoginPage = () => {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initial = rememberedLogin();

  const [form, setForm] = useState(initial.form);
  const [remember, setRemember] = useState(initial.remember);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});
  const [notice, setNotice] = useState(() => noticeFor(searchParams));
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
    setError("");
    setNotice("");

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
      login(data.user, data.token);
      navigate(getDashboardPath(data.user.role), { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      headline="Amazing Platform!"
      quote="The human resource platform helped streamline our hiring process and saved us a significant amount of time and effort."
      quoteAuthor="Katie Waters"
      quoteRole="Head Resource Management · Fintech Company"
      activeDot={0}
    >
      <div className="mx-auto w-full max-w-sm">
        <h1 className="text-2xl font-bold tracking-tight text-white sm:text-[28px]">
          Welcome back
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Sign in with your company code to continue to your workspace.
        </p>

        {notice && (
          <div
            role="status"
            className="mt-5 flex items-start gap-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200"
          >
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{notice}</span>
          </div>
        )}

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
            <label htmlFor="companyCode" className="mb-1.5 block text-sm font-medium text-slate-200">
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
              <p id="companyCode-error" className="mt-1.5 text-xs text-rose-300">
                {fieldErrors.companyCode}
              </p>
            ) : (
              <p id="companyCode-hint" className="mt-1.5 text-xs text-slate-500">
                Sent to you at registration. Super Admins use CREWLY.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-slate-200">
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
              <p id="email-error" className="mt-1.5 text-xs text-rose-300">
                {fieldErrors.email}
              </p>
            )}
          </div>

          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <label htmlFor="password" className="block text-sm font-medium text-slate-200">
                Password
              </label>
              <Link
                to="/forgot-password"
                className="text-xs font-medium text-slate-400 underline-offset-2 hover:text-emerald-300 hover:underline"
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
              <p id="password-error" className="mt-1.5 text-xs text-rose-300">
                {fieldErrors.password}
              </p>
            )}
          </div>

          <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-slate-300 select-none">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-4 w-4 rounded border-slate-600 bg-slate-800 accent-emerald-500"
            />
            Keep me signed in on this device
          </label>

          <button type="submit" disabled={loading || !canSubmit} className="auth-primary">
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

        <p className="mt-6 text-center text-sm text-slate-400">
          New to Crewly?{" "}
          <Link to="/register" className="font-medium text-emerald-400 hover:underline">
            Create an account
          </Link>
        </p>

        <p className="mt-3 text-center text-xs text-slate-500">
          SaaS provider?{" "}
          <Link
            to="/super-admin/login"
            className="text-slate-400 underline-offset-2 hover:text-slate-300 hover:underline"
          >
            Super Admin portal
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
};

export default LoginPage;
