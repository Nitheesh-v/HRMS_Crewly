import {
  useEffect,
  useState,
} from "react";
import securityService from "../../services/securityService.js";

const defaults = {
  password: {
    minLength: 10,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: true,
    requireSpecial: true,
    historyCount: 5,
    maxAgeDays: 90,
  },

  lockout: {
    maxAttempts: 5,
    durationMinutes: 15,
  },

  sessions: {
    lifetimeDays: 30,
    idleTimeoutMinutes: 43200,
    maxConcurrent: 5,
  },

  auditRetentionDays: 180,
  notifyOnNewDevice: true,
};

const numericFields = {
  password: [
    [
      "minLength",
      "Minimum length",
      8,
      64,
    ],

    [
      "historyCount",
      "Remember previous passwords",
      0,
      12,
    ],

    [
      "maxAgeDays",
      "Maximum password age (days, 0 = off)",
      0,
      365,
    ],
  ],

  lockout: [
    [
      "maxAttempts",
      "Failed attempts before lockout",
      3,
      10,
    ],

    [
      "durationMinutes",
      "Lockout duration (minutes)",
      5,
      1440,
    ],
  ],

  sessions: [
    [
      "lifetimeDays",
      "Session lifetime (days)",
      1,
      90,
    ],

    [
      "idleTimeoutMinutes",
      "Idle timeout (minutes)",
      15,
      129600,
    ],

    [
      "maxConcurrent",
      "Maximum concurrent sessions",
      1,
      20,
    ],
  ],
};

const passwordChecks = [
  [
    "requireUppercase",
    "Require uppercase letter",
  ],

  [
    "requireLowercase",
    "Require lowercase letter",
  ],

  [
    "requireNumber",
    "Require number",
  ],

  [
    "requireSpecial",
    "Require special character",
  ],
];

const mergePolicy = (policy = {}) => ({
  ...defaults,
  ...policy,

  password: {
    ...defaults.password,
    ...(policy.password || {}),
  },

  lockout: {
    ...defaults.lockout,
    ...(policy.lockout || {}),
  },

  sessions: {
    ...defaults.sessions,
    ...(policy.sessions || {}),
  },
});

const SecuritySettingsPage = () => {
  const [
    form,
    setForm,
  ] = useState(defaults);

  const [
    busy,
    setBusy,
  ] = useState(true);

  const [
    message,
    setMessage,
  ] = useState("");

  const [
    error,
    setError,
  ] = useState("");

  useEffect(() => {
    let active = true;

    securityService
      .settings()
      .then((result) => {
        if (!active) return;

        setForm(
          mergePolicy(result),
        );
      })
      .catch((requestError) => {
        if (!active) return;

        setError(
          requestError.message ||
            "Could not load security settings",
        );
      })
      .finally(() => {
        if (active) {
          setBusy(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const updateNested = (
    section,
    key,
    value,
  ) => {
    setForm((current) => ({
      ...current,

      [section]: {
        ...current[section],
        [key]: value,
      },
    }));
  };

  const submit = async (event) => {
    event.preventDefault();

    setBusy(true);
    setError("");
    setMessage("");

    try {
      const result =
        await securityService.updateSettings(
          form,
        );

      setForm(
        mergePolicy(result),
      );

      setMessage(
        "Security policy saved and recorded in the audit log.",
      );
    } catch (requestError) {
      setError(
        requestError.message ||
          "Could not save security settings",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-400">
          Company administrator
        </p>

        <h1 className="mt-1 text-2xl font-bold">
          Security settings
        </h1>

        <p className="text-sm text-crewly-dim">
          Changes apply only to your company and are recorded in the audit log.
        </p>
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

      <form
        onSubmit={submit}
        className="space-y-6"
      >
        <section className="card">
          <h2 className="text-lg font-semibold">
            Password policy
          </h2>

          <p className="mb-5 text-sm text-crewly-dim">
            Registrations, password resets and password changes must follow these rules.
          </p>

          <div className="grid gap-4 md:grid-cols-3">
            {numericFields.password.map(
              ([
                key,
                label,
                minimum,
                maximum,
              ]) => (
                <label
                  key={key}
                  className="text-sm text-crewly-dim"
                >
                  {label}

                  <input
                    className="input mt-1"
                    type="number"
                    min={minimum}
                    max={maximum}
                    value={
                      form.password[
                        key
                      ]
                    }
                    onChange={(event) =>
                      updateNested(
                        "password",
                        key,
                        Number(
                          event.target
                            .value,
                        ),
                      )
                    }
                    required
                  />
                </label>
              ),
            )}
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {passwordChecks.map(
              ([key, label]) => (
                <label
                  key={key}
                  className="flex items-center gap-3 rounded-lg border border-crewly-border p-3 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={
                      form.password[
                        key
                      ]
                    }
                    onChange={(event) =>
                      updateNested(
                        "password",
                        key,
                        event.target
                          .checked,
                      )
                    }
                  />

                  {label}
                </label>
              ),
            )}
          </div>
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="card">
            <h2 className="text-lg font-semibold">
              Account lockout
            </h2>

            <p className="mb-5 text-sm text-crewly-dim">
              Slow down password guessing without permanently disabling accounts.
            </p>

            <div className="space-y-4">
              {numericFields.lockout.map(
                ([
                  key,
                  label,
                  minimum,
                  maximum,
                ]) => (
                  <label
                    key={key}
                    className="block text-sm text-crewly-dim"
                  >
                    {label}

                    <input
                      className="input mt-1"
                      type="number"
                      min={minimum}
                      max={maximum}
                      value={
                        form.lockout[
                          key
                        ]
                      }
                      onChange={(event) =>
                        updateNested(
                          "lockout",
                          key,
                          Number(
                            event.target
                              .value,
                          ),
                        )
                      }
                      required
                    />
                  </label>
                ),
              )}
            </div>
          </section>

          <section className="card">
            <h2 className="text-lg font-semibold">
              Customer sessions
            </h2>

            <p className="mb-5 text-sm text-crewly-dim">
              Control refresh lifetime, inactivity expiry and concurrent device limits.
            </p>

            <div className="space-y-4">
              {numericFields.sessions.map(
                ([
                  key,
                  label,
                  minimum,
                  maximum,
                ]) => (
                  <label
                    key={key}
                    className="block text-sm text-crewly-dim"
                  >
                    {label}

                    <input
                      className="input mt-1"
                      type="number"
                      min={minimum}
                      max={maximum}
                      value={
                        form.sessions[
                          key
                        ]
                      }
                      onChange={(event) =>
                        updateNested(
                          "sessions",
                          key,
                          Number(
                            event.target
                              .value,
                          ),
                        )
                      }
                      required
                    />
                  </label>
                ),
              )}
            </div>
          </section>
        </div>

        <section className="card grid gap-5 md:grid-cols-2">
          <label className="text-sm text-crewly-dim">
            Audit retention (days)

            <input
              className="input mt-1"
              type="number"
              min="30"
              max="180"
              value={
                form.auditRetentionDays
              }
              onChange={(event) =>
                setForm({
                  ...form,

                  auditRetentionDays:
                    Number(
                      event.target
                        .value,
                    ),
                })
              }
              required
            />

            <small className="mt-1 block">
              Reducing retention permanently deletes older tenant audit records.
            </small>
          </label>

          <label className="flex items-start gap-3 rounded-lg border border-crewly-border p-4 text-sm">
            <input
              className="mt-1"
              type="checkbox"
              checked={
                form.notifyOnNewDevice
              }
              onChange={(event) =>
                setForm({
                  ...form,

                  notifyOnNewDevice:
                    event.target
                      .checked,
                })
              }
            />

            <span>
              <b className="block text-crewly-text">
                New device notification
              </b>

              <span className="text-crewly-dim">
                Notify users when their account signs in from a device not seen before.
              </span>
            </span>
          </label>
        </section>

        <button
          className="btn-primary"
          disabled={busy}
        >
          {busy
            ? "Saving…"
            : "Save security policy"}
        </button>
      </form>
    </div>
  );
};

export default SecuritySettingsPage;