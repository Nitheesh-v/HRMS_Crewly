import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import authService from "../../services/authService.js";

const ResetPasswordPage = () => {
  const [searchParams] = useSearchParams();

  const navigate = useNavigate();

  const token = searchParams.get("token") || "";

  const [form, setForm] = useState({
    newPassword: "",
    confirmPassword: "",
  });

  const [busy, setBusy] = useState(false);

  const [error, setError] = useState("");

  const submit = async (event) => {
    event.preventDefault();

    setError("");

    if (!token) {
      setError("This reset link is incomplete. Request a new link.");

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

  newPassword:
    form.newPassword,

  confirmPassword:
    form.confirmPassword,
});
      navigate("/login?password=reset", {
        replace: true,
      });
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
          Secure reset
        </p>

        <h1 className="mt-2 text-2xl font-bold">Create a new password</h1>

        <p className="mb-6 mt-1 text-sm text-crewly-dim">
          Use at least 10 characters with uppercase, lowercase, number and
          special character.
        </p>

        {error && (
          <div className="mb-4 rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">
            {error}
          </div>
        )}

        <label className="label">New password</label>

        <input
          className="input mb-4"
          type="password"
          minLength="10"
          maxLength="128"
          autoComplete="new-password"
          value={form.newPassword}
          onChange={(event) =>
            setForm({
              ...form,
              newPassword: event.target.value,
            })
          }
          required
        />

        <label className="label">Confirm password</label>

        <input
          className="input mb-6"
          type="password"
          minLength="10"
          maxLength="128"
          autoComplete="new-password"
          value={form.confirmPassword}
          onChange={(event) =>
            setForm({
              ...form,
              confirmPassword: event.target.value,
            })
          }
          required
        />

        <button className="btn-primary w-full" disabled={busy || !token}>
          {busy ? "Updating…" : "Reset password"}
        </button>

        <p className="mt-5 text-center text-sm text-crewly-dim">
          <Link
            to="/forgot-password"
            className="text-crewly-green hover:underline"
          >
            Request another link
          </Link>
        </p>
      </form>
    </div>
  );
};

export default ResetPasswordPage;
