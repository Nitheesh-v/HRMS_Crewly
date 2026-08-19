import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import authService from "../../services/authService.js";
import useAuth from "../../hooks/useAuth.jsx";

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleString("en-IN", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";

const ActiveSessionsPage = () => {
  const navigate = useNavigate();

  const { logout } = useAuth();

  const [data, setData] = useState({
    sessions: [],
    loginHistory: [],
  });

  const [passwords, setPasswords] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });

  const [busy, setBusy] = useState(false);

  const [message, setMessage] = useState("");

  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");

      const result = await authService.sessions();

      const payload = result?.data ?? result ?? {};

      const sessionRows = Array.isArray(payload)
        ? payload
        : payload.sessions || payload.activeSessions || [];

      const historyRows =
        payload.loginHistory ||
        payload.loginActivity ||
        payload.recentLoginActivity ||
        payload.recentLogins ||
        payload.loginEvents ||
        payload.securityEvents ||
        payload.history ||
        [];

      setData({
        sessions: sessionRows.map((session) => {
          const deviceInfo =
            session.device && typeof session.device === "object"
              ? session.device
              : {};

          const deviceName =
            typeof session.device === "string"
              ? session.device
              : deviceInfo.deviceType ||
                session.deviceType ||
                session.deviceName ||
                "Unknown device";

          const browserName =
            typeof session.browser === "string"
              ? session.browser
              : deviceInfo.browser || "Unknown browser";

          const operatingSystem =
            typeof session.os === "string"
              ? session.os
              : deviceInfo.operatingSystem ||
                session.operatingSystem ||
                "Unknown OS";

          return {
            ...session,

            id: session.id || session.sessionId || session._id,

            device: String(deviceName),

            browser: String(browserName),

            os: String(operatingSystem),

            ip: String(session.ip || session.ipAddress || "Unknown IP").replace(
              /^::ffff:/,
              "",
            ),

            createdAt:
              session.createdAt ||
              session.signedInAt ||
              session.loginAt ||
              session.startedAt ||
              session.created ||
              null,

            lastSeenAt:
              session.lastSeenAt ||
              session.lastActiveAt ||
              session.lastActivityAt ||
              session.updatedAt ||
              null,

            expiresAt:
              session.expiresAt ||
              session.expiry ||
              session.expirationDate ||
              null,

            current: Boolean(session.current || session.isCurrent),
          };
        }),

        loginHistory: historyRows,
      });
    } catch (requestError) {
      setError(requestError.message);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => load(), 0);

    return () => window.clearTimeout(timer);
  }, [load]);

  const revoke = async (sessionId) => {
    setBusy(true);
    setError("");

    try {
      await authService.revokeSession(sessionId);

      setMessage("Session revoked.");

      await load();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const logoutEverywhere = async () => {
    const confirmed = window.confirm("Log out this account on every device?");

    if (!confirmed) return;

    setBusy(true);

    try {
      await authService.logoutAll();
    } catch {
      // Local cleanup must still run.
    } finally {
      logout();

      navigate("/login", {
        replace: true,
      });
    }
  };

  const changePassword = async (event) => {
    event.preventDefault();

    setError("");

    if (passwords.newPassword !== passwords.confirmPassword) {
      setError("New passwords do not match.");

      return;
    }

    setBusy(true);

    try {
      await authService.changePassword({
        currentPassword: passwords.currentPassword,

        newPassword: passwords.newPassword,

        confirmPassword: passwords.confirmPassword,
      });

      logout();

      navigate("/login?password=changed", {
        replace: true,
      });
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-400">
            Account security
          </p>

          <h1 className="mt-1 text-2xl font-bold">Active sessions</h1>

          <p className="text-sm text-crewly-dim">
            Review every device signed in to your account.
          </p>
        </div>

        <button
          className="rounded-lg border border-red-500/40 px-4 py-2 text-sm text-red-300 hover:bg-red-500/10"
          onClick={logoutEverywhere}
          disabled={busy}
        >
          Log out all devices
        </button>
      </div>

      {message && (
        <div className="rounded-lg border border-crewly-green/40 bg-crewly-green/10 px-4 py-3 text-sm text-crewly-green">
          {message}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">
          {error}
        </div>
      )}

      <section className="grid gap-4 md:grid-cols-2">
        {data.sessions.map((session) => (
          <article
            key={session.id}
            className={`card ${session.current ? "border-indigo-500/60" : ""}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold">
                  {session.device}
                  {" · "}
                  {session.browser}
                </h2>

                <p className="text-sm text-crewly-dim">
                  {session.os}
                  {" · "}
                  {session.ip || "Unknown IP"}
                </p>
              </div>

              {session.current && (
                <span className="badge bg-indigo-500/15 text-indigo-300">
                  Current
                </span>
              )}
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
              <div>
                <p className="text-crewly-dim">Signed in</p>

                <p className="mt-1">{formatDate(session.createdAt)}</p>
              </div>

              <div>
                <p className="text-crewly-dim">Last active</p>

                <p className="mt-1">{formatDate(session.lastSeenAt)}</p>
              </div>
            </div>

            {!session.current && (
              <button
                className="mt-4 rounded-lg border border-red-500/40 px-3 py-2 text-sm text-red-300 hover:bg-red-500/10"
                onClick={() => revoke(session.id)}
                disabled={busy}
              >
                Revoke session
              </button>
            )}
          </article>
        ))}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <form onSubmit={changePassword} className="card space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Change password</h2>

            <p className="text-sm text-crewly-dim">
              Changing your password logs out every device.
            </p>
          </div>

          <div>
            <label className="label">Current password</label>

            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={passwords.currentPassword}
              onChange={(event) =>
                setPasswords({
                  ...passwords,
                  currentPassword: event.target.value,
                })
              }
              required
            />
          </div>

          <div>
            <label className="label">New password</label>

            <input
              className="input"
              type="password"
              minLength="10"
              maxLength="128"
              autoComplete="new-password"
              value={passwords.newPassword}
              onChange={(event) =>
                setPasswords({
                  ...passwords,
                  newPassword: event.target.value,
                })
              }
              required
            />
          </div>

          <div>
            <label className="label">Confirm password</label>

            <input
              className="input"
              type="password"
              minLength="10"
              maxLength="128"
              autoComplete="new-password"
              value={passwords.confirmPassword}
              onChange={(event) =>
                setPasswords({
                  ...passwords,
                  confirmPassword: event.target.value,
                })
              }
              required
            />
          </div>

          <button className="btn-primary" disabled={busy}>
            {busy ? "Saving…" : "Change password"}
          </button>
        </form>

        <section className="card">
          <h2 className="text-lg font-semibold">Recent login activity</h2>

          <div className="mt-3 max-h-96 space-y-2 overflow-y-auto">
            {data.loginHistory.map((event) => (
              <div
                key={event._id}
                className="rounded-lg border border-crewly-border p-3"
              >
                <p className="text-sm font-medium">
                  {event.type.replaceAll("_", " ")}
                </p>

                <p className="mt-1 text-xs text-crewly-dim">
                  {event.ip || "Unknown IP"}
                  {" · "}
                  {formatDate(event.createdAt)}
                </p>
              </div>
            ))}

            {!data.loginHistory.length && (
              <p className="text-sm text-crewly-dim">
                No recent login activity.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};

export default ActiveSessionsPage;
