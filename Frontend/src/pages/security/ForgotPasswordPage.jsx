import { useState } from "react";
import { useNavigate } from "react-router-dom";
import authService from "../../services/authService.js";
import AuthLayout from "../../layout/AuthLayout.jsx";
import { notify } from '../../utils/notify.js';

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
    /* 35.1 — nothing to report (failure state cleared) */
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
    <AuthLayout variant="centered">
      <div className="rounded-2xl border border-crewly-void/10 bg-crewly-void/[0.03] p-8 sm:p-10">
        <h1 className="auth-display text-center text-[32px] leading-tight text-crewly-void">
          Reset your password
        </h1>
        <p className="mt-2 text-center text-[13px] leading-relaxed text-crewly-void/55">
          Enter your company code and email address and we’ll send you
          password reset instructions.
        </p>

        {message && (
          <div className="mt-6 rounded-lg border border-crewly-sage/40 bg-crewly-sage/10 px-4 py-3 text-[13px] text-[#c9e6cf]">
            {message}
          </div>
        )}


        <form onSubmit={submit} className="mt-7 space-y-4" noValidate>
          <div>
            <label htmlFor="companyCode" className="mb-1.5 block text-[12px] font-medium text-crewly-void/60">
              Company Code <span className="text-[#e08a6e]">*</span>
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
            <label htmlFor="email" className="mb-1.5 block text-[12px] font-medium text-crewly-void/60">
              Registered Email <span className="text-[#e08a6e]">*</span>
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

        <p className="mt-5 text-center text-[11.5px] text-crewly-void/35">
          Reset links expire 30 minutes after they are issued.
        </p>
      </div>
    </AuthLayout>
  );
};

export default ForgotPasswordPage;
