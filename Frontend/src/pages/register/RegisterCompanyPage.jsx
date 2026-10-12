import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import authService from "../../services/authService.js";
import useAuth from "../../hooks/useAuth.jsx";
import { getDashboardPath } from "../../utils/roles.js";
import AuthLayout from "../../layout/AuthLayout.jsx";
import PasswordField from "../../components/auth/PasswordField.jsx";
import { notify } from "../../utils/notify.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const RegisterCompanyPage = () => {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    companyName: "",
    adminName: "",
    email: "",
    password: "",
    confirmPassword: "",
  });
  const [fieldErrors, setFieldErrors] = useState({});
  const [serverError, setServerError] = useState("");
  const [loading, setLoading] = useState(false);

  const onChange = (e) => {
    const { name, value } = e.target;

    setForm((current) => ({ ...current, [name]: value }));
    setFieldErrors((current) => (current[name] ? { ...current, [name]: "" } : current));
  };

  const mismatch = form.confirmPassword && form.password !== form.confirmPassword;
  const longEnough = form.password.length >= 6;
  const emailLooksValid = EMAIL_RE.test(form.email.trim());
  const canSubmit =
    form.companyName.trim() &&
    form.adminName.trim() &&
    form.email.trim() &&
    longEnough &&
    form.confirmPassword &&
    !mismatch;

  const validate = () => {
    const next = {};

    if (!form.companyName.trim()) next.companyName = "Enter your company name.";
    if (!form.adminName.trim()) next.adminName = "Enter your full name.";
    if (!form.email.trim()) next.email = "Enter your work email.";
    else if (!EMAIL_RE.test(form.email.trim())) {
      next.email = "That does not look like an email address.";
    }
    if (!longEnough) next.password = "Use at least 6 characters.";
    if (!form.confirmPassword) next.confirmPassword = "Re-type your password.";
    else if (mismatch) next.confirmPassword = "Passwords do not match yet.";

    setFieldErrors(next);

    return Object.keys(next).length === 0;
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    setServerError("");

    if (form.password !== form.confirmPassword) {
      setServerError("Passwords do not match");
      return;
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
      setServerError(err.message);
      notify.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout>
      <div>
        <h1 className="auth-heading text-2xl font-bold tracking-tight sm:text-[28px]">
          Manage employees easily, starting now
        </h1>
        <p className="auth-sub mt-1.5 text-sm">
          Get started for free today — 14 days, no payment details needed.
        </p>

        {serverError && (
          <p role="alert" className="auth-error-banner mt-4">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{serverError}</span>
          </p>
        )}

        <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate aria-busy={loading}>
          <div>
            <label htmlFor="companyName" className="auth-label auth-required">
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
              aria-invalid={fieldErrors.companyName ? "true" : undefined}
              aria-describedby={fieldErrors.companyName ? "companyName-error" : undefined}
              required
            />
            {fieldErrors.companyName && (
              <p id="companyName-error" className="auth-error-text mt-1.5 text-xs">
                {fieldErrors.companyName}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="adminName" className="auth-label auth-required">
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
              aria-invalid={fieldErrors.adminName ? "true" : undefined}
              aria-describedby={fieldErrors.adminName ? "adminName-error" : undefined}
              required
            />
            {fieldErrors.adminName && (
              <p id="adminName-error" className="auth-error-text mt-1.5 text-xs">
                {fieldErrors.adminName}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="email" className="auth-label auth-required">
              Work email
            </label>
            <div className="relative">
              <input
                id="email"
                name="email"
                type="email"
                className="auth-input pr-10"
                placeholder="example@company.com"
                value={form.email}
                onChange={onChange}
                autoComplete="email"
                inputMode="email"
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
              placeholder="At least 6 characters"
              autoComplete="new-password"
              minLength={6}
              invalid={Boolean(fieldErrors.password)}
              describedBy={fieldErrors.password ? "password-error" : undefined}
            />
            {fieldErrors.password && (
              <p id="password-error" className="auth-error-text mt-1.5 text-xs">
                {fieldErrors.password}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="confirmPassword" className="auth-label auth-required">
              Confirm password
            </label>
            <PasswordField
              id="confirmPassword"
              name="confirmPassword"
              value={form.confirmPassword}
              onChange={onChange}
              placeholder="Re-type your password"
              autoComplete="new-password"
              invalid={Boolean(fieldErrors.confirmPassword)}
              describedBy={fieldErrors.confirmPassword ? "confirmPassword-error" : undefined}
            />
            {fieldErrors.confirmPassword && (
              <p id="confirmPassword-error" className="auth-error-text mt-1.5 text-xs">
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
              "Create account"
            )}
          </button>
        </form>

        <p className="auth-sub mt-6 text-center text-sm">
          Already have an account?{" "}
          <Link to="/login" className="auth-link font-medium hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
};

export default RegisterCompanyPage;
