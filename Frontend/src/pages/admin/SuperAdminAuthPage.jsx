import { useState } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import useAuth from "../../hooks/useAuth.jsx";
import superAdminService from "../../services/superAdminService.js";

const inp =
  "w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:border-orange-500";

const btn =
  "w-full rounded-lg bg-orange-500 px-4 py-2.5 font-semibold text-slate-950 hover:bg-orange-400 disabled:opacity-50";

const SuperAdminAuthPage = () => {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();

  const mode = location.pathname.includes("forgot-password")
    ? "forgot"
    : location.pathname.includes("reset-password")
      ? "reset"
      : "login";

  const [form, setForm] = useState({
    email: "",
    password: "",
    newPassword: "",
    confirmPassword: "",
    code: "",
  });

  const [challengeId, setChallengeId] = useState("");

  const [busy, setBusy] = useState(false);

  const [message, setMessage] = useState("");

  const [error, setError] = useState("");

  const change = (event) =>
    setForm((current) => ({
      ...current,
      [event.target.name]: event.target.value,
    }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");

    try {
      if (mode === "forgot") {
        await superAdminService.forgotPassword(form.email);

        setMessage("If the account exists, a reset link has been sent.");
      } else if (mode === "reset") {
        if (form.newPassword !== form.confirmPassword) {
          throw new Error("Passwords do not match");
        }

        await superAdminService.resetPassword({
          token: params.get("token"),

          password: form.newPassword,
        });

        setMessage("Password reset. Redirecting to login…");

        setTimeout(() => navigate("/super-admin/login"), 1200);
      } else if (challengeId) {
        const result = await superAdminService.verifyTwoFactor({
          challengeId,
          code: form.code,
        });

        login(result.user, result.token);

        navigate("/super-admin/dashboard", { replace: true });
      } else {
        const result = await superAdminService.login({
          email: form.email,

          password: form.password,
        });

        if (result.requiresTwoFactor) {
          setChallengeId(result.challengeId);

          setMessage("Enter the verification code sent to your email.");
        } else {
          login(result.user, result.token);

          navigate("/super-admin/dashboard", { replace: true });
        }
      }
    } catch (requestError) {
      setError(requestError?.message || "Request failed");
    } finally {
      setBusy(false);
    }
  };

  const title =
    mode === "forgot"
      ? "Forgot password"
      : mode === "reset"
        ? "Reset password"
        : challengeId
          ? "Verify your login"
          : "Super Admin sign in";

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-slate-100">
      <div className="w-full max-w-md rounded-2xl border border-orange-500/20 bg-slate-900 p-7 shadow-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-orange-400">
          Crewly Provider Portal
        </p>

        <h1 className="mt-2 text-2xl font-black">{title}</h1>

        <p className="mt-1 text-sm text-slate-400">
          Separate secure access for SaaS platform administrators.
        </p>

        {error && (
          <div className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {message && (
          <div className="mt-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
            {message}
          </div>
        )}

        <form onSubmit={submit} className="mt-6 space-y-4">
          {mode === "login" && !challengeId && (
            <>
              <div>
                <label className="mb-1 block text-xs text-slate-400">
                  Platform admin email
                </label>

                <input
                  className={inp}
                  type="email"
                  name="email"
                  value={form.email}
                  onChange={change}
                  required
                />
              </div>

              <div>
                <label className="mb-1 block text-xs text-slate-400">
                  Password
                </label>

                <input
                  className={inp}
                  type="password"
                  name="password"
                  value={form.password}
                  onChange={change}
                  required
                />
              </div>
            </>
          )}

          {mode === "login" && challengeId && (
            <div>
              <label className="mb-1 block text-xs text-slate-400">
                Six-digit verification code
              </label>

              <input
                className={`${inp} text-center text-xl tracking-[0.4em]`}
                name="code"
                inputMode="numeric"
                maxLength="6"
                value={form.code}
                onChange={change}
                required
              />
            </div>
          )}

          {mode === "forgot" && (
            <div>
              <label className="mb-1 block text-xs text-slate-400">
                Platform admin email
              </label>

              <input
                className={inp}
                type="email"
                name="email"
                value={form.email}
                onChange={change}
                required
              />
            </div>
          )}

          {mode === "reset" && (
            <>
              <div>
                <label className="mb-1 block text-xs text-slate-400">
                  New password
                </label>

                <input
                  className={inp}
                  type="password"
                  name="newPassword"
                  minLength="10"
                  value={form.newPassword}
                  onChange={change}
                  required
                />
              </div>

              <div>
                <label className="mb-1 block text-xs text-slate-400">
                  Confirm password
                </label>

                <input
                  className={inp}
                  type="password"
                  name="confirmPassword"
                  minLength="10"
                  value={form.confirmPassword}
                  onChange={change}
                  required
                />
              </div>
            </>
          )}

          <button className={btn} disabled={busy}>
            {busy
              ? "Please wait…"
              : mode === "forgot"
                ? "Send reset link"
                : mode === "reset"
                  ? "Reset password"
                  : challengeId
                    ? "Verify"
                    : "Sign in"}
          </button>
        </form>

        <div className="mt-5 flex justify-between text-sm">
          {mode === "login" && !challengeId ? (
            <Link
              to="/super-admin/forgot-password"
              className="text-orange-300 hover:underline"
            >
              Forgot password?
            </Link>
          ) : (
            <Link
              to="/super-admin/login"
              className="text-orange-300 hover:underline"
            >
              Back to login
            </Link>
          )}

          <Link to="/login" className="text-slate-500 hover:text-slate-300">
            Customer login
          </Link>
        </div>
      </div>
    </div>
  );
};

export default SuperAdminAuthPage;
