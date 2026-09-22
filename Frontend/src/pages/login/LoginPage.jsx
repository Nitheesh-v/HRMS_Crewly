import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
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
  const [notice, setNotice] = useState(() => noticeFor(searchParams));
  const [loading, setLoading] = useState(false);

  const onChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const canSubmit = form.companyCode.trim() && form.email.trim() && form.password;

  const onSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setNotice("");
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
      <div className="mx-auto max-w-sm">
        <h1 className="text-center text-2xl font-bold text-white">
          Login first to your account
        </h1>
        <p className="mt-1.5 text-center text-xs text-slate-400">
          Use the company code you received at registration.
        </p>

        {notice && (
          <div className="mt-5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
            {notice}
          </div>
        )}

        <form onSubmit={onSubmit} className="mt-7 space-y-4" noValidate>
          <div>
            <label htmlFor="companyCode" className="mb-1.5 block text-sm font-medium text-slate-300">
              Company Code <span className="text-rose-400">*</span>
            </label>
            <input
              id="companyCode"
              name="companyCode"
              className="auth-input"
              placeholder="e.g. acme — Super Admin: CREWLY"
              value={form.companyCode}
              onChange={onChange}
              required
            />
          </div>

          <div>
            <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-slate-300">
              Email Address <span className="text-rose-400">*</span>
            </label>
            <input
              id="email"
              name="email"
              type="email"
              className="auth-input"
              placeholder="Input your registered email"
              value={form.email}
              onChange={onChange}
              required
            />
            {error && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-rose-400">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 shrink-0" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                {error}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-slate-300">
              Password <span className="text-rose-400">*</span>
            </label>
            <PasswordField
              id="password"
              name="password"
              value={form.password}
              onChange={onChange}
              placeholder="Input your password account"
            />
          </div>

          <div className="flex items-center justify-between pt-1">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="h-4 w-4 rounded border-slate-600 bg-slate-800 accent-emerald-500"
              />
              Remember Me
            </label>
            <Link to="/forgot-password" className="text-sm text-slate-300 hover:text-emerald-400">
              Forgot Password
            </Link>
          </div>

          <button
            type="submit"
            disabled={loading || !canSubmit}
            className="auth-primary mt-2"
          >
            {loading ? "Signing in…" : "Login"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-slate-400">
          You’re new in here?{" "}
          <Link to="/register" className="font-medium text-emerald-400 hover:underline">
            Create Account
          </Link>
        </p>

        <p className="mt-3 text-center text-xs text-slate-500">
          SaaS provider?{" "}
          <Link to="/super-admin/login" className="text-slate-400 underline-offset-2 hover:text-slate-300 hover:underline">
            Super Admin portal
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
};

export default LoginPage;
