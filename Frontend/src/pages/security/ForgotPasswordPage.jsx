import { useState } from "react";
import { useNavigate } from "react-router-dom";
import authService from "../../services/authService.js";
import AuthLayout from "../../layout/AuthLayout.jsx";

const ForgotPasswordPage = () => {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    companyCode: "",
    email: "",
  });

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const submit = async (event) => {
    event.preventDefault();

    setBusy(true);
    setError("");
    setMessage("");

    try {
      await authService.forgotPassword(form);

      setMessage(
        "If the account exists, a reset link has been sent. Check your inbox and spam folder.",
      );
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout variant="centered">
      <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-8 backdrop-blur-sm sm:p-10">
        <h1 className="text-center text-2xl font-bold text-white">
          Reset your password
        </h1>
        <p className="mt-2 text-center text-sm leading-relaxed text-slate-400">
          Enter your company code and email address and we’ll send you
          password reset instructions.
        </p>

        {message && (
          <div className="mt-6 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
            {message}
          </div>
        )}

        {error && (
          <div className="mt-6 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
            {error}
          </div>
        )}

        <form onSubmit={submit} className="mt-7 space-y-4" noValidate>
          <div>
            <label htmlFor="companyCode" className="mb-1.5 block text-sm font-medium text-slate-300">
              Company Code <span className="text-rose-400">*</span>
            </label>
            <input
              id="companyCode"
              className="auth-input"
              value={form.companyCode}
              onChange={(event) => setForm({ ...form, companyCode: event.target.value })}
              placeholder="Your workspace code"
              required
            />
          </div>

          <div>
            <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-slate-300">
              Registered Email <span className="text-rose-400">*</span>
            </label>
            <input
              id="email"
              className="auth-input"
              type="email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              placeholder="Input your registered email"
              required
            />
          </div>

          <button type="submit" className="auth-primary !mt-6" disabled={busy}>
            {busy ? "Sending…" : "Send Reset Instructions"}
          </button>

          <button
            type="button"
            onClick={() => navigate("/login")}
            className="auth-secondary"
          >
            Back To Login
          </button>
        </form>

        <p className="mt-5 text-center text-xs text-slate-500">
          Reset links expire 30 minutes after they are issued.
        </p>
      </div>
    </AuthLayout>
  );
};

export default ForgotPasswordPage;
