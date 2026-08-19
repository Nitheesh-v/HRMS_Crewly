/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import superAdminService from "../../services/superAdminService.js";

const panel = "rounded-xl border border-slate-800 bg-slate-900 p-4";

const inp =
  "rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-orange-500";

const btn =
  "rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-orange-400";

const money = (value) => `₹${Number(value || 0).toLocaleString("en-IN")}`;

const date = (value) =>
  value ? new Date(value).toLocaleDateString("en-IN") : "—";

const Metric = ({ label, value }) => (
  <div className={panel}>
    <p className="text-xs text-slate-500">{label}</p>
    <p className="text-2xl font-black text-emerald-300">{value}</p>
  </div>
);

const SuperAdminCommercePage = ({ mode }) => {
  const [data, setData] = useState(null);
  const [loadedMode, setLoadedMode] = useState('');
  const [message, setMessage] = useState("");
  const [planForm, setPlanForm] = useState(null);

 const load = async () => {
  setMessage('');

  try {
    let result;
    let normalized;

    if (mode === 'subscriptions') {
      result = await superAdminService.subscriptions({
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

    if (mode === 'plans') {
      result = await superAdminService.plans();

      normalized = Array.isArray(result)
        ? result
        : Array.isArray(result?.plans)
          ? result.plans
          : Array.isArray(result?.rows)
            ? result.rows
            : Array.isArray(result?.data)
              ? result.data
              : [];
    }

    if (mode === 'billing') {
      result = await superAdminService.billing({
        limit: 100,
      });

      normalized = {
        payments: Array.isArray(result?.payments)
          ? result.payments
          : Array.isArray(result?.data?.payments)
            ? result.data.payments
            : [],
        invoices: Array.isArray(result?.invoices)
          ? result.invoices
          : Array.isArray(result?.data?.invoices)
            ? result.data.invoices
            : [],
        meta: result?.meta || result?.data?.meta || {},
      };
    }

    if (mode === 'revenue') {
      result = await superAdminService.revenue();

      const source = result?.data || result || {};

      normalized = {
        ...source,
        mrr: source.mrr ?? 0,
        arr: source.arr ?? 0,
        yearlyRevenue: source.yearlyRevenue ?? 0,
        failedPayments: source.failedPayments ?? 0,
        newSubscriptions: source.newSubscriptions ?? 0,
        upgrades: source.upgrades ?? 0,
        cancellations: source.cancellations ?? 0,
        renewals: source.renewals ?? 0,
        monthlyRevenue: Array.isArray(source.monthlyRevenue)
          ? source.monthlyRevenue
          : [],
        byPlan: Array.isArray(source.byPlan)
          ? source.byPlan
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

  const savePlan = async (event) => {
    event.preventDefault();

    try {
      const form = new FormData(event.currentTarget);

      const body = {
        key: form.get("key"),
        name: form.get("name"),
        supportLevel: form.get("supportLevel"),
        isActive: form.get("isActive") === "true",

        prices: {
          monthly: Number(form.get("monthly")),
          yearly: Number(form.get("yearly")),
          currency: "INR",
        },

        limits: {
          employees: Number(form.get("employees")),
          storageMB: Number(form.get("storageMB")),
          administrators: Number(form.get("administrators")),
          departments: Number(form.get("departments")),
          branches: Number(form.get("branches")),
          apiRequestsMonthly: Number(form.get("apiRequestsMonthly")),
        },

        enabledModules: String(form.get("enabledModules") || "")
          .split(",")
          .map((item) => item.trim().toUpperCase())
          .filter(Boolean),
      };

      await superAdminService.savePlan(body);

      setMessage("Plan saved");
      setPlanForm(null);
      await load();
    } catch (error) {
      setMessage(error?.message || "Could not save plan");
    }
  };

  const updatePayment = async (payment, status) => {
    if (!window.confirm(`Mark payment as ${status}?`)) {
      return;
    }

    try {
      await superAdminService.updatePayment(payment._id, {
        status,
      });

      setMessage("Payment updated");
      await load();
    } catch (error) {
      setMessage(error?.message || "Payment update failed");
    }
  };

  if (!data || loadedMode !== mode) {
    return <p className="text-slate-400">Loading {mode}…</p>;
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs uppercase tracking-[0.2em] text-orange-400">
          Platform Commerce
        </p>

        <h1 className="text-2xl font-black capitalize">{mode}</h1>
      </div>

      {message && (
        <div className="rounded-lg border border-orange-500/30 bg-orange-500/10 p-3 text-orange-200">
          {message}
        </div>
      )}

      {mode === "subscriptions" && (
        <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-slate-950 text-left text-slate-500">
                <tr>
                  <th className="p-3">Company</th>
                  <th>Plan</th>
                  <th>Status</th>
                  <th>Cycle</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>Grace</th>
                  <th>Payment</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-800">
                {data.rows.map((row) => (
                  <tr key={row._id}>
                    <td className="p-3">
                      <Link
                        className="text-cyan-300"
                        to={`/super-admin/companies/${row.company.id}`}
                      >
                        {row.company.name}
                      </Link>

                      <p className="text-xs text-slate-500">
                        {row.company.code}
                      </p>
                    </td>

                    <td>{row.plan === "PRO" ? "PROFESSIONAL" : row.plan}</td>
                    <td>{row.status}</td>
                    <td>{row.billingCycle}</td>
                    <td>{date(row.startDate)}</td>
                    <td>{date(row.endDate)}</td>
                    <td>{date(row.graceEndsAt)}</td>
                    <td>{row.paymentStatus}</td>
                  </tr>
                ))}

                {!data.rows.length && (
                  <tr>
                    <td colSpan="8" className="p-8 text-center text-slate-500">
                      No subscriptions found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {mode === "plans" && (
        <>
          <div className="flex justify-end">
            <button
              type="button"
              className={btn}
              onClick={() =>
                setPlanForm({
                  key: "",
                  name: "",
                  prices: {},
                  limits: {},
                  enabledModules: [],
                  isActive: true,
                })
              }
            >
              ＋ Add plan
            </button>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {data.map((plan) => (
              <div key={plan.key} className={panel}>
                <div className="flex justify-between">
                  <div>
                    <p className="text-xs text-orange-400">{plan.key}</p>

                    <h2 className="text-xl font-bold">{plan.name}</h2>
                  </div>

                  <span
                    className={
                      plan.isActive ? "text-emerald-300" : "text-slate-500"
                    }
                  >
                    {plan.isActive ? "Active" : "Disabled"}
                  </span>
                </div>

                <p className="mt-3 text-2xl font-black">
                  {money(plan.prices?.monthly)}
                  <span className="text-xs font-normal text-slate-500">
                    {" "}
                    / month
                  </span>
                </p>

                <div className="mt-3 grid grid-cols-2 gap-2 text-sm text-slate-400">
                  <span>{plan.limits?.employees} employees</span>
                  <span>{plan.limits?.storageMB} MB</span>
                  <span>{plan.limits?.administrators} admins</span>
                  <span>{plan.limits?.apiRequestsMonthly} API</span>
                </div>

                <p className="mt-3 text-xs text-slate-500">
                  {(plan.enabledModules || []).join(", ")}
                </p>

                <button
                  type="button"
                  onClick={() => setPlanForm(plan)}
                  className="mt-4 rounded border border-slate-700 px-3 py-1.5 text-sm"
                >
                  Edit plan
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {mode === "billing" && (
        <>
          <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
            <h2 className="p-4 font-semibold">Payments</h2>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[850px] text-sm">
                <thead className="bg-slate-950 text-left text-slate-500">
                  <tr>
                    <th className="p-3">Company</th>
                    <th>Plan</th>
                    <th>Amount</th>
                    <th>Gateway</th>
                    <th>Status</th>
                    <th>Date</th>
                    <th>Action</th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-slate-800">
                  {data.payments.map((payment) => (
                    <tr key={payment._id}>
                      <td className="p-3">{payment.companyId?.name || "—"}</td>
                      <td>{payment.plan}</td>
                      <td>{money(payment.amount)}</td>
                      <td>{payment.gateway}</td>
                      <td>{payment.status}</td>
                      <td>{date(payment.createdAt)}</td>

                      <td className="space-x-2">
                        <button
                          type="button"
                          onClick={() => updatePayment(payment, "SUCCESS")}
                          className="text-emerald-300"
                        >
                          Success
                        </button>

                        <button
                          type="button"
                          onClick={() => updatePayment(payment, "FAILED")}
                          className="text-red-300"
                        >
                          Failed
                        </button>

                        <button
                          type="button"
                          onClick={() => updatePayment(payment, "REFUNDED")}
                          className="text-amber-300"
                        >
                          Refund
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
            <h2 className="p-4 font-semibold">Invoices</h2>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] text-sm">
                <thead className="bg-slate-950 text-left text-slate-500">
                  <tr>
                    <th className="p-3">Invoice</th>
                    <th>Company</th>
                    <th>Plan</th>
                    <th>Total</th>
                    <th>Status</th>
                    <th>Paid</th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-slate-800">
                  {(data.invoices || []).map((invoice) => (
                    <tr key={invoice._id}>
                      <td className="p-3">{invoice.invoiceNumber}</td>
                      <td>{invoice.companyId?.name || "—"}</td>
                      <td>{invoice.plan}</td>
                      <td>{money(invoice.total)}</td>
                      <td>{invoice.status}</td>
                      <td>{date(invoice.paidAt)}</td>
                    </tr>
                  ))}

                  {!data.invoices?.length && (
                    <tr>
                      <td
                        colSpan="6"
                        className="p-6 text-center text-slate-500"
                      >
                        No invoices yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {mode === "revenue" && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Metric label="MRR" value={money(data.mrr)} />
            <Metric label="ARR" value={money(data.arr)} />
            <Metric label="Year revenue" value={money(data.yearlyRevenue)} />
            <Metric label="Failed payments" value={data.failedPayments} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className={panel}>
              <h2 className="mb-3 font-semibold">Revenue by month</h2>

              {data.monthlyRevenue.map((row) => (
                <div
                  key={row.label}
                  className="flex justify-between border-b border-slate-800 py-2"
                >
                  <span>{row.label}</span>
                  <b>{money(row.revenue)}</b>
                </div>
              ))}
            </div>

            <div className={panel}>
              <h2 className="mb-3 font-semibold">Revenue by plan</h2>

              {data.byPlan.map((row) => (
                <div
                  key={row.plan}
                  className="flex justify-between border-b border-slate-800 py-2"
                >
                  <span>{row.plan === "PRO" ? "PROFESSIONAL" : row.plan}</span>
                  <b>{money(row.revenue)}</b>
                </div>
              ))}

              <div className="mt-4 grid grid-cols-2 gap-3">
                <Metric
                  label="New subscriptions"
                  value={data.newSubscriptions}
                />
                <Metric label="Upgrades" value={data.upgrades} />
                <Metric label="Cancellations" value={data.cancellations} />
                <Metric label="Renewals" value={data.renewals} />
              </div>
            </div>
          </div>
        </>
      )}

      {planForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <form
            onSubmit={savePlan}
            className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-2xl border border-slate-700 bg-slate-900 p-6"
          >
            <div className="mb-4 flex justify-between">
              <h2 className="text-xl font-bold">Plan editor</h2>

              <button type="button" onClick={() => setPlanForm(null)}>
                ✕
              </button>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              {[
                ["key", "Key", planForm.key],
                ["name", "Name", planForm.name],
                ["monthly", "Monthly ₹", planForm.prices?.monthly],
                ["yearly", "Yearly ₹", planForm.prices?.yearly],
                ["employees", "Employees", planForm.limits?.employees],
                ["storageMB", "Storage MB", planForm.limits?.storageMB],
                [
                  "administrators",
                  "Administrators",
                  planForm.limits?.administrators,
                ],
                ["departments", "Departments", planForm.limits?.departments],
                ["branches", "Branches", planForm.limits?.branches],
                [
                  "apiRequestsMonthly",
                  "Monthly API limit",
                  planForm.limits?.apiRequestsMonthly,
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
                    required
                    readOnly={key === "key" && !!planForm._id}
                  />
                </div>
              ))}

              <div>
                <label className="mb-1 block text-xs text-slate-500">
                  Support
                </label>

                <select
                  name="supportLevel"
                  defaultValue={planForm.supportLevel}
                  className={`${inp} w-full`}
                >
                  <option>COMMUNITY</option>
                  <option>EMAIL</option>
                  <option>PRIORITY</option>
                  <option>DEDICATED</option>
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs text-slate-500">
                  Status
                </label>

                <select
                  name="isActive"
                  defaultValue={String(planForm.isActive !== false)}
                  className={`${inp} w-full`}
                >
                  <option value="true">Active</option>
                  <option value="false">Disabled</option>
                </select>
              </div>

              <div className="md:col-span-3">
                <label className="mb-1 block text-xs text-slate-500">
                  Enabled modules (comma-separated)
                </label>

                <input
                  name="enabledModules"
                  defaultValue={(planForm.enabledModules || []).join(", ")}
                  className={`${inp} w-full`}
                />
              </div>
            </div>

            <button className={`${btn} mt-4`}>Save plan</button>
          </form>
        </div>
      )}
    </div>
  );
};

export default SuperAdminCommercePage;
