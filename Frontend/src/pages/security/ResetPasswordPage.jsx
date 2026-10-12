import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Check, Loader2, Sparkles } from "lucide-react";
import authService from "../../services/authService.js";
import AuthLayout from "../../layout/AuthLayout.jsx";
import PasswordField from "../../components/auth/PasswordField.jsx";
import PasswordRules from "../../components/auth/PasswordRules.jsx";
import { passwordRules } from "../../components/auth/passwordRules.js";
import { notify } from "../../utils/notify.js";

// Success card, Figma's celebration without the emoji confetti: a green
// ring, white core and dark check, with two lucide sparkles for the bits.
const SuccessState = ({ isSetup, onBack }) => (
  <div className="flex flex-col items-center py-6 text-center">
    <div className="relative">
      <Sparkles className="auth-check absolute -left-10 -top-1 h-4 w-4 rotate-12" aria-hidden="true" />
      <Sparkles className="auth-check absolute -right-10 -top-3 h-5 w-5 -rotate-12" aria-hidden="true" />
      <span className="auth-success-ring flex h-16 w-16 items-center justify-center rounded-full">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white">
          <Check className="h-5 w-5" style={{ color: "#0d1117" }} aria-hidden="true" />
        </span>
      </span>
    </div>
    <h1 className="auth-heading mt-8 text-2xl font-bold tracking-tight">
      {isSetup ? "Your account is ready" : "You've successfully changed your password"}
    </h1>
    <p className="auth-sub mt-3 max-w-xs text-sm leading-relaxed">
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
  const [done, setDone] = useState(false);

  // Repo-truth policy: the live checklist mirrors PLATFORM_MINIMUMS in
  // Backend/src/utils/securityPolicy.js (10 chars, upper, lower, number,
  // special) — the backend stays the authority.
  const rules = passwordRules(form.newPassword);
  const allRulesOk = rules.every((rule) => rule.ok);
  const mismatch = form.confirmPassword && form.newPassword !== form.confirmPassword;

  const submit = async (event) => {
    event.preventDefault();

    if (!token) {
      notify.error(
        isSetup
          ? "This account setup link is incomplete. Ask HR to resend the invitation."
          : "This reset link is incomplete. Request a new link."
      );
      return;
    }

    if (form.newPassword !== form.confirmPassword) {
      notify.error("Passwords do not match.");
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
      notify.error(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <AuthLayout>
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
    <AuthLayout>
      <div>
        <h1 className="auth-heading text-center text-2xl font-bold tracking-tight sm:text-[28px]">
          {isSetup ? "Set up your Crewly account" : "Update your password"}
        </h1>
        <p className="auth-sub mt-2 text-center text-sm leading-relaxed">
          Set your new password with a minimum of 10 characters including
          uppercase, lowercase, a number and a special character.
        </p>

        <form onSubmit={submit} className="mt-6 space-y-4" noValidate aria-busy={busy}>
          <div>
            <label htmlFor="newPassword" className="auth-label auth-required">
              New Password
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
            <PasswordRules password={form.newPassword} />
          </div>

          <div>
            <label htmlFor="confirmPassword" className="auth-label auth-required">
              Confirmation New Password
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
              <p className="auth-error-text mt-2 text-xs">Passwords do not match yet.</p>
            )}
          </div>

          <button
            type="submit"
            className="auth-primary !mt-6"
            disabled={busy || !token || !allRulesOk || !form.confirmPassword || Boolean(mismatch)}
          >
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Saving…
              </>
            ) : isSetup ? (
              "Set password and continue"
            ) : (
              "Submit"
            )}
          </button>
        </form>
      </div>
    </AuthLayout>
  );
};

export default ResetPasswordPage;
