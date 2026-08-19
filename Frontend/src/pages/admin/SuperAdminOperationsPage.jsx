/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

import { useEffect, useState } from "react";
import useAuth from "../../hooks/useAuth.jsx";
import superAdminService from "../../services/superAdminService.js";

const panel = "rounded-xl border border-slate-800 bg-slate-900 p-4";

const inp =
  "rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-orange-500";

const date = (value) => (value ? new Date(value).toLocaleString("en-IN") : "—");

const bytes = (value) => `${(Number(value || 0) / 1024 / 1024).toFixed(1)} MB`;

const Usage = ({ label, used, percent }) => (
  <div className="mt-4">
    <div className="mb-1 flex justify-between text-xs">
      <span className="text-slate-400">{label}</span>
      <span>
        {used} · {percent}%
      </span>
    </div>

    <div className="h-2 rounded bg-slate-800">
      <div
        className={`h-2 rounded ${
          percent >= 90
            ? "bg-red-500"
            : percent >= 70
              ? "bg-amber-500"
              : "bg-cyan-500"
        }`}
        style={{ width: `${percent}%` }}
      />
    </div>
  </div>
);

const Table = ({ headers, rows }) => (
  <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-slate-950 text-left text-slate-500">
          <tr>
            {headers.map((header) => (
              <th key={header} className="p-3">
                {header}
              </th>
            ))}
          </tr>
        </thead>

        <tbody className="divide-y divide-slate-800">
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="p-3">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
);

const SuperAdminOperationsPage = ({ mode }) => {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [loadedMode, setLoadedMode] = useState('');
  const [message, setMessage] = useState("");

  const [filters, setFilters] = useState({
    search: "",
    status: "ALL",
    priority: "ALL",
  });

  const [passwords, setPasswords] = useState({
    currentPassword: "",
    newPassword: "",
  });

  const load = async () => {
  setMessage('');

  try {
    let result;
    let normalized;

    if (mode === 'users') {
      result = await superAdminService.users({
        ...filters,
        limit: 100,
      });

      normalized = {
        rows: Array.isArray(result?.rows)
          ? result.rows
          : Array.isArray(result?.data?.rows)
            ? result.data.rows
            : [],
        meta: result?.meta || result?.data?.meta || {},
      };
    }

    if (mode === 'usage') {
      result = await superAdminService.usage();
      const source = result?.data || result || {};

      normalized = {
        ...source,
        rows: Array.isArray(source.rows)
          ? source.rows
          : [],
        featureAdoption: Array.isArray(source.featureAdoption)
          ? source.featureAdoption
          : [],
        meta: source.meta || {},
      };
    }

    if (mode === 'support') {
      const [ticketsResult, agentsResult] = await Promise.all([
        superAdminService.support({
          ...filters,
          limit: 100,
        }),
        superAdminService.platformAdmins(),
      ]);

      const tickets = ticketsResult?.data || ticketsResult || {};

      normalized = {
        ...tickets,
        rows: Array.isArray(tickets.rows)
          ? tickets.rows
          : [],
        counts: Array.isArray(tickets.counts)
          ? tickets.counts
          : [],
        agents: Array.isArray(agentsResult)
          ? agentsResult
          : Array.isArray(agentsResult?.data)
            ? agentsResult.data
            : [],
      };
    }

    if (mode === 'system-health') {
      result = await superAdminService.health();
      const source = result?.data || result || {};

      normalized = {
        ...source,
        overall: source.overall || 'WARNING',
        checks:
          source.checks &&
          typeof source.checks === 'object'
            ? source.checks
            : {},
      };
    }

    if (mode === 'audit-logs') {
      result = await superAdminService.auditLogs({
        ...filters,
        limit: 100,
      });

      const source = result?.data || result || {};

      normalized = {
        ...source,
        rows: Array.isArray(source.rows)
          ? source.rows
          : [],
        meta: source.meta || {},
      };
    }

    if (mode === 'settings') {
      const [settingsResult, sessionsResult, adminsResult] =
        await Promise.all([
          superAdminService.settings(),
          superAdminService.sessions(),
          superAdminService.platformAdmins().catch(() => []),
        ]);

      const settings =
        settingsResult?.data || settingsResult || {};

      normalized = {
        settings: {
          platform: settings.platform || {},
          subscription: settings.subscription || {},
          notifications: settings.notifications || {},
          security: settings.security || {},
        },
        sessions: Array.isArray(sessionsResult)
          ? sessionsResult
          : Array.isArray(sessionsResult?.data)
            ? sessionsResult.data
            : [],
        admins: Array.isArray(adminsResult)
          ? adminsResult
          : Array.isArray(adminsResult?.data)
            ? adminsResult.data
            : [],
      };
    }

    setData(normalized);
    setLoadedMode(mode);
  } catch (error) {
    setData(null);
    setLoadedMode('');
    setMessage(error?.message || 'Could not load data');
  }
};
  useEffect(() => {
    load();
  }, [mode]);

  const updateTicket = async (ticket, field, value) => {
    try {
      await superAdminService.updateSupport(ticket._id, {
        [field]: value,
      });

      setMessage("Support ticket updated");
      await load();
    } catch (error) {
      setMessage(error?.message || "Ticket update failed");
    }
  };

  const saveSettings = async (event) => {
    event.preventDefault();

    try {
      const form = new FormData(event.currentTarget);

      await superAdminService.updateSettings({
        platform: {
          name: form.get("name"),
          supportEmail: form.get("supportEmail"),
          timezone: form.get("timezone"),
          currency: form.get("currency"),
        },

        subscription: {
          defaultTrialDays: Number(form.get("defaultTrialDays")),
          gracePeriodDays: Number(form.get("gracePeriodDays")),
          expirationBehavior: form.get("expirationBehavior"),
          reminderDays: String(form.get("reminderDays"))
            .split(",")
            .map(Number)
            .filter(Boolean),
        },

        notifications: {
          emailEnabled: form.get("emailEnabled") === "true",
          inAppEnabled: true,
          systemAlertsEnabled: true,
        },

        security: {
          superAdminSessionHours: Number(form.get("sessionHours")),
          maxLoginAttempts: Number(form.get("maxLoginAttempts")),
          requireStrongPasswords: true,
        },
      });

      setMessage("Platform settings updated");
      await load();
    } catch (error) {
      setMessage(error?.message || "Settings update failed");
    }
  };

  const changePassword = async (event) => {
    event.preventDefault();

    try {
      await superAdminService.changePassword(passwords);

      setPasswords({
        currentPassword: "",
        newPassword: "",
      });

      setMessage("Password changed and other sessions were revoked");
    } catch (error) {
      setMessage(error?.message || "Password change failed");
    }
  };

 if (!data || loadedMode !== mode) {
    return <p className="text-slate-400">Loading {mode}…</p>;
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs uppercase tracking-[0.2em] text-orange-400">
          Platform Operations
        </p>

        <h1 className="text-2xl font-black capitalize">
          {mode.replace("-", " ")}
        </h1>
      </div>

      {message && (
        <div className="rounded-lg border border-orange-500/30 bg-orange-500/10 p-3 text-orange-200">
          {message}
        </div>
      )}

      {mode === "users" && (
        <>
          <div className="flex gap-2">
            <input
              className={`${inp} flex-1`}
              placeholder="Search name, email or employee code"
              value={filters.search}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  search: event.target.value,
                }))
              }
            />

            <button
              type="button"
              onClick={load}
              className="rounded-lg bg-orange-500 px-4 font-semibold text-slate-950"
            >
              Search
            </button>
          </div>

          <Table
            headers={["User", "Company", "Role", "Status", "Last login"]}
            rows={data.rows.map((row) => [
             <span key={`user-${row._id}`}>
                {row.name}
                <small className="block text-slate-500">{row.email}</small>
              </span>,
              row.companyId?.name || "—",
              row.role,
              row.status,
              date(row.lastLogin),
            ])}
          />
        </>
      )}

      {mode === "usage" && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            {data.rows.map((row) => (
              <div key={row.company.id} className={panel}>
                <div className="flex justify-between">
                  <div>
                    <h2 className="font-bold">{row.company.name}</h2>

                    <p className="text-xs text-slate-500">
                      {row.company.code} · {row.plan}
                    </p>
                  </div>

                  <span className="text-sm text-slate-400">
                    {row.company.status}
                  </span>
                </div>

                <Usage
                  label="Users"
                  used={`${row.users.used} / ${row.users.limit}`}
                  percent={row.percentages.users}
                />

                <Usage
                  label="Storage"
                  used={`${bytes(row.storage.usedBytes)} / ${bytes(
                    row.storage.limitBytes,
                  )}`}
                  percent={row.percentages.storage}
                />

                <Usage
                  label="API requests"
                  used={`${row.api.used.toLocaleString(
                    "en-IN",
                  )} / ${row.api.limit.toLocaleString("en-IN")}`}
                  percent={row.percentages.api}
                />

                <div className="mt-4 flex flex-wrap gap-2">
                  {Object.entries(row.moduleUsage || {}).map(([name, count]) => (
                    <span
                      key={name}
                      className="rounded-full bg-cyan-500/10 px-2 py-1 text-xs text-cyan-300"
                    >
                      {name} {count}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className={panel}>
            <h2 className="mb-3 font-semibold">Feature adoption</h2>

            {data.featureAdoption.map((row) => (
              <div
                key={row.moduleName}
                className="flex justify-between border-b border-slate-800 py-2"
              >
                <span>{row.moduleName}</span>
                <b>{row.companiesUsing} companies</b>
              </div>
            ))}
          </div>
        </>
      )}

      {mode === "support" && (
        <>
          <div className="flex flex-wrap gap-2">
            <select
              className={inp}
              value={filters.status}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  status: event.target.value,
                }))
              }
            >
              <option value="ALL">All statuses</option>
              <option>OPEN</option>
              <option>IN_PROGRESS</option>
              <option>WAITING_FOR_CUSTOMER</option>
              <option>RESOLVED</option>
              <option>CLOSED</option>
            </select>

            <select
              className={inp}
              value={filters.priority}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  priority: event.target.value,
                }))
              }
            >
              <option value="ALL">All priorities</option>
              <option>LOW</option>
              <option>MEDIUM</option>
              <option>HIGH</option>
              <option>CRITICAL</option>
            </select>

            <button
              type="button"
              onClick={load}
              className="rounded-lg bg-orange-500 px-4 text-slate-950"
            >
              Filter
            </button>
          </div>

          <div className="space-y-3">
            {data.rows.map((ticket) => (
              <div key={ticket._id} className={panel}>
                <div className="flex flex-wrap justify-between gap-3">
                  <div>
                    <p className="text-xs text-orange-400">
                      {ticket.companyId?.name} · {ticket.category}
                    </p>

                    <h2 className="font-bold">{ticket.subject}</h2>

                    <p className="mt-2 text-sm text-slate-400">
                      {ticket.message}
                    </p>

                    <p className="mt-2 text-xs text-slate-500">
                      {ticket.user?.name} · {date(ticket.createdAt)}
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <select
                      className={inp}
                      value={ticket.priority}
                      onChange={(event) =>
                        updateTicket(ticket, "priority", event.target.value)
                      }
                    >
                      <option>LOW</option>
                      <option>MEDIUM</option>
                      <option>HIGH</option>
                      <option>CRITICAL</option>
                    </select>

                    <select
                      className={inp}
                      value={ticket.status}
                      onChange={(event) =>
                        updateTicket(ticket, "status", event.target.value)
                      }
                    >
                      <option>OPEN</option>
                      <option>IN_PROGRESS</option>
                      <option>WAITING_FOR_CUSTOMER</option>
                      <option>RESOLVED</option>
                      <option>CLOSED</option>
                    </select>

                    <select
                      className={inp}
                      value={ticket.assignedSupportAgent?._id || ""}
                      onChange={(event) =>
                        updateTicket(
                          ticket,
                          "assignedSupportAgent",
                          event.target.value,
                        )
                      }
                    >
                      <option value="">Unassigned</option>

                      {(data.agents || [])
                        .filter((agent) =>
                          ["SUPER_ADMIN", "SUPPORT_ADMIN"].includes(agent.role),
                        )
                        .map((agent) => (
                          <option key={agent._id} value={agent._id}>
                            {agent.name}
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {mode === "system-health" && (
        <>
          <div
            className={`rounded-xl border p-5 ${
              data.overall === "HEALTHY"
                ? "border-emerald-500/40 bg-emerald-500/10"
                : data.overall === "DOWN"
                  ? "border-red-500/40 bg-red-500/10"
                  : "border-amber-500/40 bg-amber-500/10"
            }`}
          >
            <p className="text-sm">Overall platform status</p>
            <p className="text-3xl font-black">{data.overall}</p>
            <p className="text-xs text-slate-400">
              Checked {date(data.checkedAt)}
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Object.entries(data.checks || {}).map(([name, check]) => (
              <div key={name} className={panel}>
                <div className="flex justify-between">
                  <b className="capitalize">{name}</b>
                  <span
                    className={
                      check.status === "HEALTHY"
                        ? "text-emerald-300"
                        : check.status === "DOWN"
                          ? "text-red-300"
                          : "text-amber-300"
                    }
                  >
                    {check.status}
                  </span>
                </div>

                <p className="mt-2 text-sm text-slate-500">{check.message}</p>
              </div>
            ))}
          </div>
        </>
      )}

      {mode === "audit-logs" && (
        <Table
          headers={[
            "Time",
            "Actor",
            "Action",
            "Target company",
            "Method",
            "IP",
          ]}
          rows={data.rows.map((row) => [
            date(row.createdAt),
            row.actorName || row.actor?.name || row.actorRole,
            row.action,
            row.targetCompany?.name || "Platform",
            row.method,
            row.ip || "—",
          ])}
        />
      )}

      {mode === "settings" && (
        <div className="grid gap-4 xl:grid-cols-2">
          <form onSubmit={saveSettings} className={panel}>
            <h2 className="mb-4 font-semibold">
              Platform & subscription settings
            </h2>

            <div className="grid gap-3 md:grid-cols-2">
              {[
                ["name", "Platform name", data.settings.platform?.name],
                [
                  "supportEmail",
                  "Support email",
                  data.settings.platform?.supportEmail,
                ],
                ["timezone", "Timezone", data.settings.platform?.timezone],
                ["currency", "Currency", data.settings.platform?.currency],
                [
                  "defaultTrialDays",
                  "Trial days",
                  data.settings.subscription?.defaultTrialDays,
                ],
                [
                  "gracePeriodDays",
                  "Grace period days",
                  data.settings.subscription?.gracePeriodDays,
                ],
                [
                  "reminderDays",
                  "Reminder days",
                  (data.settings.subscription?.reminderDays || []).join(","),
                ],
                [
                  "sessionHours",
                  "Admin session hours",
                  data.settings.security?.superAdminSessionHours,
                ],
                [
                  "maxLoginAttempts",
                  "Max login attempts",
                  data.settings.security?.maxLoginAttempts,
                ],
              ].map(([key, label, value]) => (
                <div key={key}>
                  <label className="mb-1 block text-xs text-slate-500">
                    {label}
                  </label>

                  <input
                    name={key}
                    defaultValue={value ?? ""}
                    className={`${inp} w-full`}
                  />
                </div>
              ))}

              <div>
                <label className="mb-1 block text-xs text-slate-500">
                  Expiration behavior
                </label>

                <select
                  name="expirationBehavior"
                  defaultValue={data.settings.subscription?.expirationBehavior}
                  className={`${inp} w-full`}
                >
                  <option>READ_ONLY</option>
                  <option>FEATURE_RESTRICTED</option>
                  <option>FULL_ACCESS_BLOCKED</option>
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs text-slate-500">
                  Email notifications
                </label>

                <select
                  name="emailEnabled"
                  defaultValue={String(
                    data.settings.notifications?.emailEnabled !== false,
                  )}
                  className={`${inp} w-full`}
                >
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </select>
              </div>
            </div>

            <button className="mt-4 rounded-lg bg-orange-500 px-4 py-2 font-semibold text-slate-950">
              Save settings
            </button>
          </form>

          <div className="space-y-4">
            <div className={panel}>
              <h2 className="font-semibold">Security</h2>

              <p className="mt-2 text-sm text-slate-400">
                2FA is {user?.twoFactorEnabled ? "enabled" : "disabled"} for
                your account.
              </p>

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    await superAdminService.setTwoFactor(
                      !user?.twoFactorEnabled,
                    );
                    setMessage(
                      "2FA setting updated. Sign in again to refresh your profile.",
                    );
                  }}
                  className="rounded border border-slate-700 px-3 py-2 text-sm"
                >
                  {user?.twoFactorEnabled ? "Disable 2FA" : "Enable email 2FA"}
                </button>

                <button
                  type="button"
                  onClick={async () => {
                    await superAdminService.logoutOthers();
                    setMessage("Other sessions logged out");
                    await load();
                  }}
                  className="rounded border border-slate-700 px-3 py-2 text-sm"
                >
                  Logout other sessions
                </button>
              </div>
            </div>

            <form onSubmit={changePassword} className={panel}>
              <h2 className="mb-3 font-semibold">Change password</h2>

              <div className="space-y-2">
                <input
                  className={`${inp} w-full`}
                  type="password"
                  placeholder="Current password"
                  value={passwords.currentPassword}
                  onChange={(event) =>
                    setPasswords((current) => ({
                      ...current,
                      currentPassword: event.target.value,
                    }))
                  }
                  required
                />

                <input
                  className={`${inp} w-full`}
                  type="password"
                  minLength="10"
                  placeholder="New password (10+ characters)"
                  value={passwords.newPassword}
                  onChange={(event) =>
                    setPasswords((current) => ({
                      ...current,
                      newPassword: event.target.value,
                    }))
                  }
                  required
                />

                <button className="rounded-lg bg-orange-500 px-3 py-2 text-sm font-semibold text-slate-950">
                  Update password
                </button>
              </div>
            </form>

            <div className={panel}>
              <h2 className="mb-3 font-semibold">Active sessions</h2>

              {data.sessions.map((session) => (
                <div
                  key={session._id}
                  className="border-b border-slate-800 py-2 text-sm"
                >
                  <b>
                    {session.current
                      ? "Current session"
                      : session.userAgent || "Unknown device"}
                  </b>

                  <p className="text-xs text-slate-500">
                    {session.ip || "Unknown IP"} · last seen{" "}
                    {date(session.lastSeenAt)}
                  </p>
                </div>
              ))}
            </div>

            <div className={panel}>
              <h2 className="mb-3 font-semibold">Platform administrators</h2>

              {data.admins.map((admin) => (
                <div
                  key={admin._id}
                  className="flex justify-between border-b border-slate-800 py-2 text-sm"
                >
                  <span>
                    {admin.name}
                    <small className="block text-slate-500">
                      {admin.email}
                    </small>
                  </span>

                  <span>{admin.role}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SuperAdminOperationsPage;
