/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import superAdminService from "../../services/superAdminService.js";

const inp =
  "rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-orange-500";

const btn =
  "rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-orange-400 disabled:opacity-50";

const emptyForm = {
  name: "",
  code: "",
  email: "",
  phone: "",
  adminName: "",
  adminEmail: "",
  plan: "TRIAL",
  industry: "",
};

const badge = (status) => {
  if (status === "ACTIVE") {
    return "bg-emerald-500/15 text-emerald-300";
  }

  if (status === "SUSPENDED") {
    return "bg-red-500/15 text-red-300";
  }

  return "bg-amber-500/15 text-amber-300";
};

const date = (value) =>
  value ? new Date(value).toLocaleDateString("en-IN") : "—";

const SuperAdminCompaniesPage = () => {
  const [filters, setFilters] = useState({
    search: "",
    status: "ALL",
    plan: "ALL",
    subscriptionStatus: "ALL",
    page: 1,
    limit: 25,
    sortBy: "createdAt",
    sortDir: "desc",
  });

  const [result, setResult] = useState({
    rows: [],
    meta: {},
  });

  const [form, setForm] = useState(emptyForm);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const load = async () => {
    try {
      const data = await superAdminService.companies(filters);

      setResult(data);
    } catch (error) {
      setMessage(error?.message || "Could not load companies");
    }
  };

  useEffect(() => {
    load();
  }, [
    filters.page,
    filters.status,
    filters.plan,
    filters.subscriptionStatus,
    filters.sortBy,
    filters.sortDir,
  ]);

  const changeFilter = (key, value) => {
    setFilters((current) => ({
      ...current,
      [key]: value,
      page: key === "page" ? value : 1,
    }));
  };

  const createCompany = async (event) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");

    try {
      const created = await superAdminService.createCompany(form);

      setMessage(`Company created. Code: ${created.code}`);

      setShowCreate(false);
      setForm(emptyForm);

      await load();
    } catch (error) {
      setMessage(error?.message || "Company creation failed");
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (company) => {
    const status = company.status === "SUSPENDED" ? "ACTIVE" : "SUSPENDED";

    const confirmed = window.confirm(
      `${status === "SUSPENDED" ? "Suspend" : "Activate"} ` +
        `${company.name}?`,
    );

    if (!confirmed) return;

    try {
      await superAdminService.setCompanyStatus(company._id, status);

      setMessage(`${company.name} is now ${status}`);

      await load();
    } catch (error) {
      setMessage(error?.message || "Status update failed");
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-orange-400">
            Tenant Management
          </p>

          <h1 className="text-2xl font-black">Companies</h1>
        </div>

        <button
          type="button"
          className={btn}
          onClick={() => setShowCreate(true)}
        >
          ＋ Create company
        </button>
      </div>

      {message && (
        <div className="rounded-lg border border-orange-500/30 bg-orange-500/10 p-3 text-sm text-orange-200">
          {message}
        </div>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          load();
        }}
        className="flex flex-wrap gap-2 rounded-xl border border-slate-800 bg-slate-900 p-4"
      >
        <input
          className={`${inp} min-w-64 flex-1`}
          placeholder="Search name, code or email"
          value={filters.search}
          onChange={(event) =>
            setFilters((current) => ({
              ...current,
              search: event.target.value,
            }))
          }
        />

        <select
          className={inp}
          value={filters.status}
          onChange={(event) => changeFilter("status", event.target.value)}
        >
          <option value="ALL">All company statuses</option>
          <option value="ACTIVE">ACTIVE</option>
          <option value="SUSPENDED">SUSPENDED</option>
          <option value="DEACTIVATED">DEACTIVATED</option>
        </select>

        <select
          className={inp}
          value={filters.plan}
          onChange={(event) => changeFilter("plan", event.target.value)}
        >
          <option value="ALL">All plans</option>
          <option value="TRIAL">TRIAL</option>
          <option value="BASIC">BASIC</option>
          <option value="PRO">PROFESSIONAL</option>
          <option value="ENTERPRISE">ENTERPRISE</option>
        </select>

        <select
          className={inp}
          value={filters.subscriptionStatus}
          onChange={(event) =>
            changeFilter("subscriptionStatus", event.target.value)
          }
        >
          <option value="ALL">All subscriptions</option>
          <option value="TRIAL">TRIAL</option>
          <option value="ACTIVE">ACTIVE</option>
          <option value="GRACE_PERIOD">GRACE PERIOD</option>
          <option value="EXPIRED">EXPIRED</option>
          <option value="SUSPENDED">SUSPENDED</option>
          <option value="CANCELLED">CANCELLED</option>
        </select>

        <select
          className={inp}
          value={filters.sortBy}
          onChange={(event) => changeFilter("sortBy", event.target.value)}
        >
          <option value="createdAt">Sort by created date</option>
          <option value="name">Sort by name</option>
          <option value="status">Sort by status</option>
          <option value="code">Sort by code</option>
        </select>

        <select
          className={inp}
          value={filters.sortDir}
          onChange={(event) => changeFilter("sortDir", event.target.value)}
        >
          <option value="desc">Descending</option>
          <option value="asc">Ascending</option>
        </select>

        <button className={btn}>Search</button>
      </form>

      <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1250px] text-sm">
            <thead className="bg-slate-950 text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3">Company</th>
                <th>Plan</th>
                <th>Subscription</th>
                <th>Start</th>
                <th>End</th>
                <th>Employees</th>
                <th>Users</th>
                <th>Storage</th>
                <th>Last login</th>
                <th>Created</th>
                <th>Status</th>
                <th className="pr-4">Action</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-slate-800">
              {result.rows.map((company) => (
                <tr key={company._id} className="hover:bg-slate-800/50">
                  <td className="px-4 py-3">
                    <Link
                      to={`/super-admin/companies/${company._id}`}
                      className="font-semibold text-cyan-300 hover:underline"
                    >
                      {company.name}
                    </Link>

                    <p className="text-xs text-slate-500">
                      {company.code} · {company.email}
                    </p>
                  </td>

                  <td>
                    <span className="rounded-full bg-cyan-500/10 px-2 py-1 text-xs text-cyan-300">
                      {company.plan === "PRO" ? "PROFESSIONAL" : company.plan}
                    </span>
                  </td>

                  <td>{company.subscriptionStatus}</td>

                  <td>{date(company.subscriptionStart)}</td>

                  <td>{date(company.subscriptionEnd)}</td>

                  <td>{company.employeeCount}</td>

                  <td>{company.userCount}</td>

                  <td>
                    {(Number(company.storageBytes || 0) / 1024 / 1024).toFixed(
                      1,
                    )}{" "}
                    MB
                  </td>

                  <td>{date(company.lastLogin)}</td>

                  <td>{date(company.createdAt)}</td>

                  <td>
                    <span
                      className={`rounded-full px-2 py-1 text-xs ${badge(
                        company.status,
                      )}`}
                    >
                      {company.status}
                    </span>
                  </td>

                  <td className="pr-4">
                    <button
                      type="button"
                      onClick={() => toggleStatus(company)}
                      className="rounded border border-slate-700 px-2 py-1 text-xs hover:border-orange-500"
                    >
                      {company.status === "SUSPENDED" ? "Activate" : "Suspend"}
                    </button>
                  </td>
                </tr>
              ))}

              {!result.rows.length && (
                <tr>
                  <td colSpan="12" className="p-8 text-center text-slate-500">
                    No companies match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t border-slate-800 p-3 text-sm text-slate-400">
          <span>{result.meta.total || 0} companies</span>

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded border border-slate-700 px-3 py-1 disabled:opacity-40"
              disabled={filters.page <= 1}
              onClick={() => changeFilter("page", filters.page - 1)}
            >
              Previous
            </button>

            <span>
              Page {result.meta.page || 1}/{result.meta.pages || 1}
            </span>

            <button
              type="button"
              className="rounded border border-slate-700 px-3 py-1 disabled:opacity-40"
              disabled={filters.page >= (result.meta.pages || 1)}
              onClick={() => changeFilter("page", filters.page + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <form
            onSubmit={createCompany}
            className="w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-900 p-6"
          >
            <div className="mb-5 flex justify-between">
              <h2 className="text-xl font-bold">Create customer company</h2>

              <button type="button" onClick={() => setShowCreate(false)}>
                ✕
              </button>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {[
                ["name", "Company name"],
                ["code", "Company code (optional)"],
                ["email", "Company email"],
                ["phone", "Phone"],
                ["adminName", "Company Admin name"],
                ["adminEmail", "Company Admin email"],
                ["industry", "Industry"],
              ].map(([key, label]) => (
                <div key={key}>
                  <label className="mb-1 block text-xs text-slate-400">
                    {label}
                  </label>

                  <input
                    className={`${inp} w-full`}
                    type={
                      key === "email" || key === "adminEmail" ? "email" : "text"
                    }
                    value={form[key]}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }))
                    }
                    required={["name", "adminName", "adminEmail"].includes(key)}
                  />
                </div>
              ))}

              <div>
                <label className="mb-1 block text-xs text-slate-400">
                  Initial plan
                </label>

                <select
                  className={`${inp} w-full`}
                  value={form.plan}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      plan: event.target.value,
                    }))
                  }
                >
                  <option value="TRIAL">TRIAL</option>
                  <option value="BASIC">BASIC</option>
                  <option value="PRO">PROFESSIONAL</option>
                  <option value="ENTERPRISE">ENTERPRISE</option>
                </select>
              </div>
            </div>

            <button className={`${btn} mt-5`} disabled={busy}>
              {busy ? "Creating…" : "Create company & admin"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
};

export default SuperAdminCompaniesPage;
