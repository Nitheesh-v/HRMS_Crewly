import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import authService from "../../services/authService.js";
import useAuth from "../../hooks/useAuth.jsx";
import { getDashboardPath } from "../../utils/roles.js";
import AuthLayout from "../../layout/AuthLayout.jsx";
import PasswordField from "../../components/auth/PasswordField.jsx";
import { notify } from "../../utils/notify.js";

const REMEMBER_KEY = "crewly.rememberedLogin";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

// Figma parity: the design shows Google / Apple sign-in. Crewly has no
// OAuth backend, so the buttons render disabled with a "soon" chip instead
// of faking a flow (a beautiful button that does nothing is a product bug).
const SocialRow = ({ divider }) => (
  <div className="mt-6">
    <div className="auth-divider">{divider}</div>
    <div className="mt-4 grid grid-cols-2 gap-3">
      <button
        type="button"
        disabled
        className="auth-secondary"
        title="Google sign-in is not enabled yet — use your email and password."
      >
        Google <span className="auth-soon">soon</span>
      </button>
      <button
        type="button"
        disabled
        className="auth-secondary"
        title="Apple sign-in is not enabled yet — use your email and password."
      >
        Apple <span className="auth-soon">soon</span>
      </button>
    </div>
  </div>
);

const LoginPage = () => {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initial = rememberedLogin();

  /*
   * 35.1 — the "password changed" / "account is set up" notice that the
   * reset and setup flows hand back through the URL is a toast: it is a
   * message about something that happened elsewhere, not a form strip.
   */
  useEffect(() => {
    const notice = noticeFor(searchParams);

    if (notice) {
      notify.info(notice, { id: "login-arrival-notice" });
    }
  }, [searchParams]);

  const [form, setForm] = useState(initial.form);
  const [remember, setRemember] = useState(initial.remember);
  const [fieldErrors, setFieldErrors] = useState({});
  const [serverError, setServerError] = useState("");
  const [loading, setLoading] = useState(false);

  const onChange = (e) => {
    const { name, value } = e.target;

    setForm((current) => ({ ...current, [name]: value }));
    // Clear the field's complaint as soon as the user starts fixing it.
    setFieldErrors((current) => (current[name] ? { ...current, [name]: "" } : current));
  };

  const emailLooksValid = EMAIL_RE.test(form.email.trim());
  const canSubmit = form.companyCode.trim() && form.email.trim() && form.password;

  // Fast, local nudges. The server stays the authority on credentials.
  const validate = () => {
    const next = {};

    if (!form.companyCode.trim()) next.companyCode = "Enter the company code you registered with.";
    if (!form.email.trim()) next.email = "Enter your email address.";
    else if (!EMAIL_RE.test(form.email.trim())) {
      next.email = "That does not look like an email address.";
    }
    if (!form.password) next.password = "Enter your password.";

    setFieldErrors(next);

    return Object.keys(next).length === 0;
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    setServerError("");

    if (!validate()) return;

    setLoading(true);
    try {
      if (remember) {
        // Identifiers only — the password never touches localStorage.
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
      // The backend's generic message, verbatim — it deliberately does not
      // reveal which of company / email / password was wrong, and neither
      // does this screen.
      setServerError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout centerLogo>
      <div>
        <h1 className="auth-heading text-2xl font-bold tracking-tight sm:text-[28px]">
          Login first to your account
        </h1>

        {serverError && (
          <p role="alert" className="auth-error-banner mt-4">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{serverError}</span>
          </p>
        )}

        <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate aria-busy={loading}>
          <div>
            <label htmlFor="companyCode" className="auth-label auth-required">
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
              <p id="companyCode-error" className="auth-error-text mt-1.5 text-xs">
                {fieldErrors.companyCode}
              </p>
            ) : (
              <p id="companyCode-hint" className="auth-hint mt-1.5 text-xs">
                Sent to you at registration. Super Admins use CREWLY.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="email" className="auth-label auth-required">
              Email Address
            </label>
            <div className="relative">
              <input
                id="email"
                name="email"
                type="email"
                className="auth-input pr-10"
                placeholder="Input your registered email"
                value={form.email}
                onChange={onChange}
                autoComplete="email"
                inputMode="email"
                autoFocus={Boolean(initial.form.companyCode) && !initial.form.email}
                aria-invalid={fieldErrors.email ? "true" : undefined}
                aria-describedby={fieldErrors.email ? "email-error" : undefined}
                required
              />
              {emailLooksValid && (
                <Check
                  className="auth-check pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2"
                  aria-hidden="true"
                />
              )}
            </div>
            {fieldErrors.email && (
              <p id="email-error" className="auth-error-text mt-1.5 text-xs">
                {fieldErrors.email}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="password" className="auth-label auth-required">
              Password
            </label>
            <PasswordField
              id="password"
              name="password"
              value={form.password}
              onChange={onChange}
              placeholder="Input your password"
              invalid={Boolean(fieldErrors.password)}
              describedBy={fieldErrors.password ? "password-error" : undefined}
            />
            {fieldErrors.password && (
              <p id="password-error" className="auth-error-text mt-1.5 text-xs">
                {fieldErrors.password}
              </p>
            )}
          </div>

          <div className="flex items-center justify-between gap-3">
            <label className="auth-sub flex w-fit cursor-pointer items-center gap-2 text-sm select-none">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="auth-checkbox h-4 w-4 rounded"
              />
              Remember Me
            </label>
            <Link
              to="/forgot-password"
              className="auth-muted-link text-sm underline-offset-2 hover:underline"
            >
              Forgot Password
            </Link>
          </div>

          <button type="submit" disabled={loading || !canSubmit} className="auth-primary">
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Signing in…
              </>
            ) : (
              "Login"
            )}
          </button>
        </form>

        <SocialRow divider="Or login with" />

        <p className="auth-sub mt-6 text-center text-sm">
          You're new in here?{" "}
          <Link to="/register" className="auth-link font-medium hover:underline">
            Create Account
          </Link>
        </p>

        <p className="auth-sub mt-3 text-center text-xs">
          SaaS provider?{" "}
          <Link to="/super-admin/login" className="auth-muted-link underline-offset-2 hover:underline">
            Super Admin portal
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
};

export default LoginPage;
