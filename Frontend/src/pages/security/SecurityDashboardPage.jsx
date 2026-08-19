import {
  useCallback,
  useEffect,
  useState,
} from "react";
import {
  Link,
} from "react-router-dom";
import securityService from "../../services/securityService.js";

const formatDate = (value) => {
  if (!value) return "—";

  const date = new Date(value);

  if (
    Number.isNaN(date.getTime())
  ) {
    return "—";
  }

  return date.toLocaleString(
    "en-IN",
    {
      dateStyle: "medium",
      timeStyle: "short",
    },
  );
};

const SEVERITY_CLASS = {
  INFO:
    "border-cyan-500/30 bg-cyan-500/10 text-cyan-300",

  WARNING:
    "border-amber-500/30 bg-amber-500/10 text-amber-300",

  CRITICAL:
    "border-red-500/30 bg-red-500/10 text-red-300",
};

const getEventType = (event) =>
  String(
    event?.type ||
    event?.eventType ||
    event?.action ||
    event?.category ||
    event?.name ||
    event?.metadata?.type ||
    event?.metadata?.eventType ||
    "SECURITY_EVENT",
  );

const getEventMessage = (event) =>
  String(
    event?.message ||
    event?.description ||
    event?.details?.message ||
    event?.metadata?.message ||
    "",
  );

const getEventIp = (event) =>
  String(
    event?.ip ||
    event?.ipAddress ||
    event?.details?.ip ||
    event?.details?.ipAddress ||
    event?.metadata?.ip ||
    event?.metadata?.ipAddress ||
    "",
  ).replace(
    /^::ffff:/,
    "",
  );

const getEventSeverity = (event) =>
  String(
    event?.severity ||
    event?.level ||
    "INFO",
  ).toUpperCase();

const getEventUser = (event) =>
  event?.user?.name ||
  event?.userId?.name ||
  event?.actor?.name ||
  event?.actorName ||
  event?.userName ||
  event?.metadata?.userName ||
  "System";

const getEventTime = (event) =>
  event?.createdAt ||
  event?.occurredAt ||
  event?.timestamp ||
  event?.eventAt ||
  null;

const getGroupedEventName = (item) =>
  String(
    item?._id ||
    item?.type ||
    item?.eventType ||
    item?.action ||
    item?.category ||
    "SECURITY_EVENT",
  );

const emptyDashboard = {
  metrics: {
    activeSessions: 0,
    activeUsers: 0,
    failedLogins24h: 0,
    criticalEvents30d: 0,
    lockedAccounts: 0,
  },

  eventTypes: [],
  dailyEvents: [],
  recentEvents: [],
};

const SecurityDashboardPage = () => {
  const [
    data,
    setData,
  ] = useState(
    emptyDashboard,
  );

  const [
    loading,
    setLoading,
  ] = useState(true);

  const [
    error,
    setError,
  ] = useState("");

  const load = useCallback(
    async () => {
      setLoading(true);
      setError("");

      try {
        const result =
          await securityService.dashboard();

        setData({
          ...emptyDashboard,
          ...(result || {}),

          metrics: {
            ...emptyDashboard.metrics,
            ...(result?.metrics ||
              {}),
          },

          eventTypes:
            result?.eventTypes ||
            [],

          dailyEvents:
            result?.dailyEvents ||
            [],

          recentEvents:
            result?.recentEvents ||
            [],
        });
      } catch (requestError) {
        setError(
          requestError.message ||
            "Could not load security dashboard",
        );
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    const timer =
      window.setTimeout(
        () => load(),
        0,
      );

    return () =>
      window.clearTimeout(timer);
  }, [load]);

  const metricCards = [
    {
      label:
        "Active sessions",

      value:
        data.metrics
          .activeSessions,

      color:
        "text-indigo-300",
    },

    {
      label:
        "Active users",

      value:
        data.metrics
          .activeUsers,

      color:
        "text-cyan-300",
    },

    {
      label:
        "Failed logins · 24h",

      value:
        data.metrics
          .failedLogins24h,

      color:
        "text-amber-300",
    },

    {
      label:
        "Critical events · 30d",

      value:
        data.metrics
          .criticalEvents30d,

      color:
        "text-red-300",
    },

    {
      label:
        "Locked accounts",

      value:
        data.metrics
          .lockedAccounts,

      color:
        "text-orange-300",
    },
  ];

  const maximumDailyEvents =
    Math.max(
      1,

      ...data.dailyEvents.map(
        (item) =>
          Number(
            item?.total,
          ) || 0,
      ),
    );

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-400">
            Phase 22 · Compliance
          </p>

          <h1 className="mt-1 text-2xl font-bold">
            Security dashboard
          </h1>

          <p className="text-sm text-crewly-dim">
            Authentication health and high-risk activity for your company.
          </p>
        </div>

        <div className="flex gap-2">
          <Link
            className="btn-ghost px-3 py-2 text-sm"
            to="/app/audit-logs"
          >
            Audit logs
          </Link>

          <button
            className="btn-primary px-3 py-2 text-sm"
            onClick={load}
            disabled={loading}
          >
            {loading
              ? "Refreshing…"
              : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">
          {error}
        </div>
      )}

      {loading ? (
        <div className="card text-sm text-crewly-dim">
          Loading security metrics…
        </div>
      ) : (
        <>
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            {metricCards.map(
              (metric) => (
                <article
                  key={metric.label}
                  className="card"
                >
                  <p className="text-xs text-crewly-dim">
                    {metric.label}
                  </p>

                  <p
                    className={`mt-2 text-3xl font-black ${metric.color}`}
                  >
                    {metric.value}
                  </p>
                </article>
              ),
            )}
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="card">
              <h2 className="font-semibold">
                Seven-day event activity
              </h2>

              <div className="mt-5 flex h-48 items-end gap-3">
                {data.dailyEvents.map(
                  (item) => {
                    const total =
                      Number(
                        item?.total,
                      ) || 0;

                    const failed =
                      Number(
                        item?.failed,
                      ) || 0;

                    const totalHeight =
                      Math.max(
                        8,

                        (total /
                          maximumDailyEvents) *
                          150,
                      );

                    const failedHeight =
                      total > 0
                        ? (failed /
                            total) *
                          100
                        : 0;

                    const dayLabel =
                      String(
                        item?._id ||
                        item?.date ||
                        "",
                      );

                    return (
                      <div
                        key={
                          dayLabel ||
                          Math.random()
                        }
                        className="flex flex-1 flex-col items-center justify-end gap-2"
                      >
                        <div
                          className="relative w-full rounded-t bg-indigo-500/25"
                          style={{
                            height:
                              `${totalHeight}px`,
                          }}
                        >
                          <div
                            className="absolute bottom-0 w-full rounded-t bg-red-500/60"
                            style={{
                              height:
                                `${failedHeight}%`,
                            }}
                          />
                        </div>

                        <span className="text-[10px] text-crewly-dim">
                          {dayLabel
                            ? dayLabel.slice(
                                5,
                              )
                            : "—"}
                        </span>
                      </div>
                    );
                  },
                )}

                {!data.dailyEvents
                  .length && (
                  <p className="self-center text-sm text-crewly-dim">
                    No events in this period.
                  </p>
                )}
              </div>

              <div className="mt-3 flex gap-4 text-xs text-crewly-dim">
                <span>
                  ■ Indigo: all events
                </span>

                <span className="text-red-300">
                  ■ Red: failed events
                </span>
              </div>
            </section>

            <section className="card">
              <h2 className="font-semibold">
                Top security events · 30 days
              </h2>

              <div className="mt-4 space-y-3">
                {data.eventTypes.map(
                  (
                    item,
                    index,
                  ) => {
                    const eventName =
                      getGroupedEventName(
                        item,
                      );

                    const count =
                      Number(
                        item?.count,
                      ) || 0;

                    return (
                      <div
                        key={`${eventName}-${index}`}
                      >
                        <div className="mb-1 flex justify-between text-xs">
                          <span>
                            {eventName.replaceAll(
                              "_",
                              " ",
                            )}
                          </span>

                          <b>
                            {count}
                          </b>
                        </div>

                        <div className="h-2 rounded bg-crewly-bg">
                          <div
                            className="h-2 rounded bg-cyan-500"
                            style={{
                              width:
                                `${Math.min(
                                  100,
                                  count *
                                    8,
                                )}%`,
                            }}
                          />
                        </div>
                      </div>
                    );
                  },
                )}

                {!data.eventTypes
                  .length && (
                  <p className="text-sm text-crewly-dim">
                    No security events.
                  </p>
                )}
              </div>
            </section>
          </div>

          <section className="card overflow-hidden p-0">
            <div className="flex items-center justify-between border-b border-crewly-border px-5 py-4">
              <h2 className="font-semibold">
                Recent security events
              </h2>

              <Link
                to="/app/audit-logs"
                className="text-sm text-indigo-300 hover:underline"
              >
                Open audit explorer
              </Link>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-crewly-bg text-xs text-crewly-dim">
                  <tr>
                    <th className="px-5 py-3">
                      Event
                    </th>

                    <th className="px-5 py-3">
                      User
                    </th>

                    <th className="px-5 py-3">
                      IP
                    </th>

                    <th className="px-5 py-3">
                      Severity
                    </th>

                    <th className="px-5 py-3">
                      Time
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {data.recentEvents.map(
                    (
                      event,
                      index,
                    ) => {
                      const eventType =
                        getEventType(
                          event,
                        );

                      const eventMessage =
                        getEventMessage(
                          event,
                        );

                      const eventIp =
                        getEventIp(
                          event,
                        );

                      const severity =
                        getEventSeverity(
                          event,
                        );

                      const userName =
                        getEventUser(
                          event,
                        );

                      return (
                        <tr
                          key={
                            event?._id ||
                            event?.id ||
                            `${eventType}-${index}`
                          }
                          className="border-t border-crewly-border"
                        >
                          <td className="px-5 py-3">
                            <b>
                              {eventType.replaceAll(
                                "_",
                                " ",
                              )}
                            </b>

                            {eventMessage && (
                              <small className="block text-crewly-dim">
                                {
                                  eventMessage
                                }
                              </small>
                            )}
                          </td>

                          <td className="px-5 py-3">
                            {userName}
                          </td>

                          <td className="px-5 py-3 font-mono text-xs">
                            {eventIp ||
                              "—"}
                          </td>

                          <td className="px-5 py-3">
                            <span
                              className={`rounded border px-2 py-1 text-[10px] ${
                                SEVERITY_CLASS[
                                  severity
                                ] ||
                                SEVERITY_CLASS.INFO
                              }`}
                            >
                              {severity}
                            </span>
                          </td>

                          <td className="px-5 py-3 text-xs text-crewly-dim">
                            {formatDate(
                              getEventTime(
                                event,
                              ),
                            )}
                          </td>
                        </tr>
                      );
                    },
                  )}
                </tbody>
              </table>

              {!data.recentEvents
                .length && (
                <p className="p-8 text-center text-sm text-crewly-dim">
                  No recent security events.
                </p>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
};

export default SecurityDashboardPage;