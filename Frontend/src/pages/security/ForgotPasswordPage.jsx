import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, Loader2 } from "lucide-react";
import authService from "../../services/authService.js";
import AuthLayout from "../../layout/AuthLayout.jsx";
import { notify } from "../../utils/notify.js";

const ForgotPasswordPage = () => {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    companyCode: "",
    email: "",
  });

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const submit = async (event) => {
    event.preventDefault();

    setBusy(true);
    setMessage("");

    try {
      await authService.forgotPassword(form);

      setMessage(
        "If the account exists, a reset link has been sent. Check your inbox and spam folder.",
      );
    } catch (requestError) {
      notify.error(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <div>
        <h1 className="auth-heading text-center text-2xl font-bold tracking-tight sm:text-[28px]">
          Reset your password
        </h1>
        <p className="auth-sub mt-2 text-center text-sm leading-relaxed">
          Enter your company code and email address and we’ll send you
          password reset instructions.
        </p>

        {message && (
          <p role="status" className="auth-success-banner mt-6">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{message}</span>
          </p>
        )}

        <form onSubmit={submit} className="mt-6 space-y-4" noValidate aria-busy={busy}>
          <div>
            <label htmlFor="companyCode" className="auth-label auth-required">
              Company Code
            </label>
            <input
              id="companyCode"
              name="companyCode"
              className="auth-input"
              value={form.companyCode}
              onChange={(event) => setForm({ ...form, companyCode: event.target.value })}
              placeholder="Your workspace code"
              autoComplete="organization"
              required
            />
          </div>

          <div>
            <label htmlFor="email" className="auth-label auth-required">
              Registered Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              className="auth-input"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              placeholder="Input your registered email"
              autoComplete="email"
              inputMode="email"
              required
            />
          </div>

          <button type="submit" className="auth-primary !mt-6" disabled={busy}>
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Sending…
              </>
            ) : (
              "Send Reset Instructions"
            )}
          </button>

          <button
            type="button"
            onClick={() => navigate("/login")}
            className="auth-secondary"
          >
            Back to Login
          </button>
        </form>

        <p className="auth-hint mt-5 text-center text-xs">
          Reset links expire 30 minutes after they are issued.
        </p>
      </div>
    </AuthLayout>
  );
};

export default ForgotPasswordPage;
