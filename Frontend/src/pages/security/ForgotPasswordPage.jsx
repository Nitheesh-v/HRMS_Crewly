import { useState } from "react";
import { Link } from "react-router-dom";
import authService from "../../services/authService.js";

const ForgotPasswordPage = () => {
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
    <div className="flex items-center justify-center px-4 py-16">
      <form onSubmit={submit} className="card w-full max-w-md">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-crewly-green">
          Account recovery
        </p>

        <h1 className="mt-2 text-2xl font-bold">Forgot your password?</h1>

        <p className="mb-6 mt-1 text-sm text-crewly-dim">
          We will email a secure reset link that expires in 30 minutes.
        </p>

        {message && (
          <div className="mb-4 rounded-lg border border-crewly-green/40 bg-crewly-green/10 px-4 py-3 text-sm text-crewly-green">
            {message}
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">
            {error}
          </div>
        )}

        <label className="label">Company code</label>

        <input
          className="input mb-4"
          value={form.companyCode}
          onChange={(event) =>
            setForm({
              ...form,
              companyCode: event.target.value,
            })
          }
          required
        />

        <label className="label">Work email</label>

        <input
          className="input mb-6"
          type="email"
          value={form.email}
          onChange={(event) =>
            setForm({
              ...form,
              email: event.target.value,
            })
          }
          required
        />

        <button className="btn-primary w-full" disabled={busy}>
          {busy ? "Sending…" : "Send reset link"}
        </button>

        <p className="mt-5 text-center text-sm text-crewly-dim">
          <Link to="/login" className="text-crewly-green hover:underline">
            Back to sign in
          </Link>
        </p>
      </form>
    </div>
  );
};

export default ForgotPasswordPage;
