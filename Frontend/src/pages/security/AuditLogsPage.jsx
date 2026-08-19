import {
  useEffect,
  useState,
} from "react";
import securityService from "../../services/securityService.js";

const initialFilters = {
  search: "",
  method: "",
  status: "",
  from: "",
  to: "",
  page: 1,
  limit: 25,
};

const emptyMeta = {
  page: 1,
  pages: 1,
  total: 0,
  limit: 25,
};

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleString(
        "en-IN",
        {
          dateStyle: "medium",
          timeStyle: "short",
        },
      )
    : "—";

const AuditLogsPage = () => {
  const [
    filters,
    setFilters,
  ] = useState(initialFilters);

  const [
    appliedFilters,
    setAppliedFilters,
  ] = useState(initialFilters);

  const [
    logs,
    setLogs,
  ] = useState([]);

  const [
    meta,
    setMeta,
  ] = useState(emptyMeta);

  const [
    selected,
    setSelected,
  ] = useState(null);

  const [
    busy,
    setBusy,
  ] = useState(true);

  const [
    error,
    setError,
  ] = useState("");

  useEffect(() => {
    let active = true;

    securityService
      .auditLogs(appliedFilters)
      .then((result) => {
        if (!active) return;

        setLogs(
          result?.data || [],
        );

        setMeta({
          ...emptyMeta,
          ...(result?.meta || {}),
        });

        setError("");
      })
      .catch((requestError) => {
        if (!active) return;

        setError(
          requestError.message ||
            "Could not load audit logs",
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
  }, [appliedFilters]);

  const applyFilters = (event) => {
    event.preventDefault();

    setBusy(true);

    setAppliedFilters({
      ...filters,
      page: 1,
    });
  };

  const clearFilters = () => {
    setBusy(true);
    setFilters(initialFilters);
    setAppliedFilters(initialFilters);
  };

  const changePage = (nextPage) => {
    setBusy(true);

    setFilters((current) => ({
      ...current,
      page: nextPage,
    }));

    setAppliedFilters(
      (current) => ({
        ...current,
        page: nextPage,
      }),
    );
  };

  const openDetail = async (id) => {
    setError("");

    try {
      const result =
        await securityService.auditDetail(
          id,
        );

      setSelected(result);
    } catch (requestError) {
      setError(
        requestError.message ||
          "Could not load audit detail",
      );
    }
  };

  const downloadCsv = async () => {
    setBusy(true);
    setError("");

    try {
      const blob =
        await securityService.exportAudit({
          ...appliedFilters,
          page: undefined,
          limit: undefined,
        });

      const url =
        URL.createObjectURL(blob);

      const link =
        document.createElement("a");

      link.href = url;

      link.download =
        `crewly-audit-${new Date()
          .toISOString()
          .slice(0, 10)}.csv`;

      document.body.appendChild(
        link,
      );

      link.click();
      link.remove();

      URL.revokeObjectURL(url);
    } catch (requestError) {
      setError(
        requestError.message ||
          "Could not export audit logs",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-400">
            Compliance trail
          </p>

          <h1 className="mt-1 text-2xl font-bold">
            Audit logs
          </h1>

          <p className="text-sm text-crewly-dim">
            Tenant-scoped activity records with filtering, details and CSV export.
          </p>
        </div>

        <button
          className="btn-primary px-4 py-2 text-sm"
          onClick={downloadCsv}
          disabled={busy}
        >
          {busy
            ? "Please wait…"
            : "Export CSV"}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">
          {error}
        </div>
      )}

      <form
        onSubmit={applyFilters}
        className="card grid gap-3 md:grid-cols-6"
      >
        <input
          className="input md:col-span-2"
          placeholder="Search actor, action or path"
          value={filters.search}
          onChange={(event) =>
            setFilters({
              ...filters,
              search:
                event.target.value,
            })
          }
        />

        <select
          className="input"
          value={filters.method}
          onChange={(event) =>
            setFilters({
              ...filters,
              method:
                event.target.value,
            })
          }
        >
          <option value="">
            All methods
          </option>

          {[
            "GET",
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
          ].map((method) => (
            <option
              key={method}
              value={method}
            >
              {method}
            </option>
          ))}
        </select>

        <select
          className="input"
          value={filters.status}
          onChange={(event) =>
            setFilters({
              ...filters,
              status:
                event.target.value,
            })
          }
        >
          <option value="">
            Any status
          </option>

          <option value="success">
            Successful
          </option>

          <option value="failed">
            Failed
          </option>
        </select>

        <input
          className="input"
          type="date"
          aria-label="From date"
          value={filters.from}
          onChange={(event) =>
            setFilters({
              ...filters,
              from:
                event.target.value,
            })
          }
        />

        <input
          className="input"
          type="date"
          aria-label="To date"
          value={filters.to}
          onChange={(event) =>
            setFilters({
              ...filters,
              to:
                event.target.value,
            })
          }
        />

        <div className="flex gap-2 md:col-span-6">
          <button className="btn-primary px-4 py-2 text-sm">
            Apply filters
          </button>

          <button
            type="button"
            className="btn-ghost px-4 py-2 text-sm"
            onClick={clearFilters}
          >
            Clear
          </button>
        </div>
      </form>

      <section className="card overflow-hidden p-0">
        <div className="border-b border-crewly-border px-5 py-3 text-xs text-crewly-dim">
          {meta.total || 0}
          {" records"}

          {busy &&
            " · loading…"}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-crewly-bg text-xs text-crewly-dim">
              <tr>
                <th className="px-4 py-3">
                  Time
                </th>

                <th className="px-4 py-3">
                  Actor
                </th>

                <th className="px-4 py-3">
                  Action
                </th>

                <th className="px-4 py-3">
                  Request
                </th>

                <th className="px-4 py-3">
                  Status
                </th>

                <th className="px-4 py-3">
                  Details
                </th>
              </tr>
            </thead>

            <tbody>
              {logs.map((log) => (
                <tr
                  key={log._id}
                  className="border-t border-crewly-border hover:bg-white/[0.02]"
                >
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-crewly-dim">
                    {formatDate(
                      log.createdAt,
                    )}
                  </td>

                  <td className="px-4 py-3">
                    {log.actor?.name ||
                      log.actorName ||
                      "System"}

                    <small className="block text-crewly-dim">
                      {log.actorRole ||
                        "—"}
                    </small>
                  </td>

                  <td className="px-4 py-3 font-medium">
                    {log.action}
                  </td>

                  <td className="px-4 py-3">
                    <span className="mr-2 rounded bg-indigo-500/15 px-2 py-1 text-xs text-indigo-300">
                      {log.method}
                    </span>

                    <code className="text-xs text-crewly-dim">
                      {log.path}
                    </code>
                  </td>

                  <td className="px-4 py-3">
                    <span
                      className={
                        Number(
                          log.statusCode,
                        ) < 400
                          ? "text-emerald-300"
                          : "text-red-300"
                      }
                    >
                      {log.statusCode}
                    </span>
                  </td>

                  <td className="px-4 py-3">
                    <button
                      className="text-xs text-indigo-300 hover:underline"
                      onClick={() =>
                        openDetail(
                          log._id,
                        )
                      }
                    >
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {!busy &&
            !logs.length && (
              <p className="p-8 text-center text-sm text-crewly-dim">
                No audit records match these filters.
              </p>
            )}
        </div>

        <div className="flex items-center justify-between border-t border-crewly-border px-5 py-3">
          <button
            className="btn-ghost px-3 py-1.5 text-xs"
            disabled={
              meta.page <= 1 ||
              busy
            }
            onClick={() =>
              changePage(
                meta.page - 1,
              )
            }
          >
            Previous
          </button>

          <span className="text-xs text-crewly-dim">
            Page {meta.page || 1}
            {" of "}
            {meta.pages || 1}
          </span>

          <button
            className="btn-ghost px-3 py-1.5 text-xs"
            disabled={
              meta.page >=
                meta.pages ||
              busy
            }
            onClick={() =>
              changePage(
                meta.page + 1,
              )
            }
          >
            Next
          </button>
        </div>
      </section>

      {selected && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/60"
          onClick={() =>
            setSelected(null)
          }
        >
          <aside
            className="h-full w-full max-w-xl overflow-y-auto border-l border-crewly-border bg-crewly-card p-6"
            onClick={(event) =>
              event.stopPropagation()
            }
          >
            <div className="flex justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-wider text-indigo-300">
                  Audit detail
                </p>

                <h2 className="mt-1 text-xl font-bold">
                  {selected.action}
                </h2>
              </div>

              <button
                className="text-2xl text-crewly-dim"
                onClick={() =>
                  setSelected(null)
                }
              >
                ×
              </button>
            </div>

            <dl className="mt-6 grid grid-cols-2 gap-4 text-sm">
              {[
                [
                  "Time",
                  formatDate(
                    selected.createdAt,
                  ),
                ],

                [
                  "Actor",
                  selected.actor
                    ?.name ||
                    selected.actorName ||
                    "System",
                ],

                [
                  "Role",
                  selected.actorRole ||
                    "—",
                ],

                [
                  "Status",
                  selected.statusCode,
                ],

                [
                  "Method",
                  selected.method,
                ],

                [
                  "IP address",
                  selected.ip || "—",
                ],

                [
                  "Path",
                  selected.path,
                ],

                [
                  "Target",
                  `${selected.targetType || "—"} ${selected.targetId || ""}`,
                ],
              ].map(
                ([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs text-crewly-dim">
                      {label}
                    </dt>

                    <dd className="mt-1 break-all">
                      {value}
                    </dd>
                  </div>
                ),
              )}
            </dl>

            <h3 className="mt-6 text-sm font-semibold">
              Metadata
            </h3>

            <pre className="mt-2 overflow-auto rounded-lg bg-crewly-bg p-4 text-xs text-cyan-200">
              {JSON.stringify(
                selected.metadata ||
                  {},
                null,
                2,
              )}
            </pre>

            {selected.previousValue && (
              <>
                <h3 className="mt-6 text-sm font-semibold">
                  Previous value
                </h3>

                <pre className="mt-2 overflow-auto rounded-lg bg-crewly-bg p-4 text-xs">
                  {JSON.stringify(
                    selected.previousValue,
                    null,
                    2,
                  )}
                </pre>
              </>
            )}

            {selected.newValue && (
              <>
                <h3 className="mt-6 text-sm font-semibold">
                  New value
                </h3>

                <pre className="mt-2 overflow-auto rounded-lg bg-crewly-bg p-4 text-xs">
                  {JSON.stringify(
                    selected.newValue,
                    null,
                    2,
                  )}
                </pre>
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  );
};

export default AuditLogsPage;