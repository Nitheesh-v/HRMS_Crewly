import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import authService from "../../services/authService.js";
import AuthLayout from "../../layout/AuthLayout.jsx";
import PasswordField from "../../components/auth/PasswordField.jsx";

const Check = ({ ok }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    strokeWidth="2.4"
    className={ok ? "text-emerald-400" : "text-rose-400"}
    aria-hidden="true"
  >
    {ok ? (
      <path d="M20 6 9 17l-5-5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    ) : (
      <g stroke="currentColor" strokeLinecap="round">
        <circle cx="12" cy="12" r="9" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </g>
    )}
  </svg>
);

const SuccessState = ({ isSetup, onBack }) => (
  <div className="flex flex-col items-center py-6 text-center">
    <div className="relative">
      <span className="absolute -left-7 -top-3 text-lg" aria-hidden="true">🎉</span>
      <span className="absolute -right-8 -top-1 text-lg" aria-hidden="true">✨</span>
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/20 ring-8 ring-emerald-500/10">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </span>
    </div>
    <h1 className="mt-8 text-2xl font-bold text-white">
      {isSetup ? "Your account is ready" : "You successfully changed your password"}
    </h1>
    <p className="mt-3 max-w-xs text-sm leading-relaxed text-slate-400">
      Always remember the password for your account at Crewly!
    </p>
    <button type="button" onClick={onBack} className="auth-primary mt-8">
      Back to Login
    </button>
  </div>
);

const ResetPasswordPage = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isSetup = window.location.pathname.includes("setup-account");
  const token = searchParams.get("token") || "";

  const [form, setForm] = useState({
    newPassword: "",
    confirmPassword: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  // Repo-truth policy: minimum 10 characters with uppercase, lowercase,
  // number and special character (mirrors the backend validator).
  const rules = useMemo(
    () => [
      { label: "10 characters", ok: form.newPassword.length >= 10 },
      { label: "Uppercase letter (A-Z)", ok: /[A-Z]/.test(form.newPassword) },
      { label: "Lowercase letter (a-z)", ok: /[a-z]/.test(form.newPassword) },
      { label: "Number (0-9)", ok: /[0-9]/.test(form.newPassword) },
      { label: "Special character", ok: /[^A-Za-z0-9]/.test(form.newPassword) },
    ],
    [form.newPassword],
  );

  const allRulesOk = rules.every((rule) => rule.ok);
  const mismatch = form.confirmPassword && form.newPassword !== form.confirmPassword;

  const submit = async (event) => {
    event.preventDefault();
    setError("");

    if (!token) {
      setError(
        isSetup
          ? "This account setup link is incomplete. Ask HR to resend the invitation."
          : "This reset link is incomplete. Request a new link."
      );
      return;
    }

    if (form.newPassword !== form.confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      await authService.resetPassword({
        token,
        newPassword: form.newPassword,
        confirmPassword: form.confirmPassword,
      });
      setDone(true); // success screen; Back to Login carries the query states
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <AuthLayout variant="centered">
        <SuccessState
          isSetup={isSetup}
          onBack={() =>
            navigate(isSetup ? "/login?setup=complete" : "/login?password=reset", {
              replace: true,
            })
          }
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout variant="centered">
      <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-8 backdrop-blur-sm sm:p-10">
        <h1 className="text-center text-2xl font-bold text-white">
          {isSetup ? "Set up your Crewly account" : "Update your password"}
        </h1>
        <p className="mt-2 text-center text-sm leading-relaxed text-slate-400">
          Set your new password with a minimum of 10 characters including
          uppercase, lowercase, a number and a special character.
        </p>

        {error && (
          <div className="mt-6 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
            {error}
          </div>
        )}

        <form onSubmit={submit} className="mt-7 space-y-4" noValidate>
          <div>
            <label htmlFor="newPassword" className="mb-1.5 block text-sm font-medium text-slate-300">
              New Password <span className="text-rose-400">*</span>
            </label>
            <PasswordField
              id="newPassword"
              name="newPassword"
              value={form.newPassword}
              onChange={(event) => setForm({ ...form, newPassword: event.target.value })}
              placeholder="Input your new password"
              autoComplete="new-password"
              minLength={10}
              maxLength={128}
            />
            <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
              {rules.map((rule) => (
                <li key={rule.label} className={`flex items-center gap-1.5 text-xs ${rule.ok ? "text-emerald-400" : "text-rose-400"}`}>
                  <Check ok={rule.ok} />
                  {rule.label}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <label htmlFor="confirmPassword" className="mb-1.5 block text-sm font-medium text-slate-300">
              Confirmation New Password <span className="text-rose-400">*</span>
            </label>
            <PasswordField
              id="confirmPassword"
              name="confirmPassword"
              value={form.confirmPassword}
              onChange={(event) => setForm({ ...form, confirmPassword: event.target.value })}
              placeholder="Re-type your new password"
              autoComplete="new-password"
              required={false}
            />
            {mismatch && (
              <p className="mt-2 text-xs text-rose-400">Passwords do not match yet.</p>
            )}
          </div>

          <button
            type="submit"
            className="auth-primary !mt-6"
            disabled={busy || !token || !allRulesOk || !form.confirmPassword || Boolean(mismatch)}
          >
            {busy
              ? "Saving…"
              : isSetup
                ? "Set password and continue"
                : "Submit"}
          </button>
        </form>
      </div>
    </AuthLayout>
  );
};

export default ResetPasswordPage;
