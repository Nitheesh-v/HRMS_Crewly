import { useCallback, useEffect, useState } from "react";
import billingService from "../../services/billingService";
import Modal from "../../components/Modal";
import useAuth from "../../hooks/useAuth";
import { ROLES } from "../../utils/roles";
import {
  CircleCheckBig,
  CreditCard,
  FlaskConical,
  Gift,
  ReceiptText,
  ShieldX,
} from "lucide-react";

const money = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;
const fmtDate = (d) =>
  d
    ? new Date(d).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "—";

// loads Razorpay checkout.js ONLY when real keys are used
const loadRazorpayScript = () =>
  new Promise((resolve) => {
    if (window.Razorpay) return resolve(true);
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });

const STATUS_STYLE = {
  ACTIVE: "text-crewly-green",
  EXPIRING_SOON: "text-crewly-orange",
  EXPIRED: "text-crewly-red",
};

export default function BillingPage() {
  const { user: me } = useAuth();
  const isAdmin = me?.role === ROLES.COMPANY_ADMIN;

  const [plans, setPlans] = useState([]);
  const [sub, setSub] = useState(null);
  const [company, setCompany] = useState(null);
  const [usage, setUsage] = useState(null);
  const [payments, setPayments] = useState([]);
  const [months, setMonths] = useState(1);
  const [banner, setBanner] = useState(null);
  const [payModal, setPayModal] = useState(null); // { order }
  const [busy, setBusy] = useState(false);

  const flash = (type, text) => {
    setBanner({ type, text });
    setTimeout(() => setBanner(null), 8000);
  };
  const errText = (err) =>
    err?.response?.data?.message || err?.message || "Something went wrong";

  const loadAll = useCallback(async () => {
    try {
      const [p, s, h] = await Promise.all([
        billingService.plans(),
        billingService.subscription(),
        billingService.payments(),
      ]);
      setPlans(Array.isArray(p) ? p : []);
      const subData = s?.data || s;
      setSub(subData?.subscription || null);
      setCompany(subData?.company || null);
      const usageData = subData?.usage || {};

      setUsage({
        employees:
          usageData.employees?.used ?? subData?.legacyUsage?.employees ?? 0,

        employeeLimit:
          usageData.employees?.limit ??
          subData?.legacyUsage?.employeeLimit ??
          10,
      });
      setPayments(Array.isArray(h) ? h : []);
    } catch (err) {
      flash("error", errText(err));
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const afterVerify = async (msg) => {
    flash(
  "success",
  msg ||
    "Plan activated successfully",
);
    setPayModal(null);
    loadAll();
  };

  const doVerify = async (payload) => {
    const res = await billingService.verify(payload);
    await afterVerify(res?.message);
  };

  const startCheckout = async (plan) => {
    setBusy(true);
    try {
      const res = await billingService.checkout({ plan, months });
      const order = res?.data || res;

      if (order.mock) {
        setPayModal({ order, plan }); // TEST MODE modal
        return;
      }

      // REAL Razorpay checkout
      const ok = await loadRazorpayScript();
      if (!ok)
        return flash(
          "error",
          "Could not load the payment gateway. Check your internet.",
        );
      const rzp = new window.Razorpay({
        key: order.keyId,
        order_id: order.orderId,
        amount: order.amount * 100,
        currency: "INR",
        name: "Crewly HRMS",
        description: `${plan} plan · ${months} month(s)`,
        prefill: { email: me?.email, name: me?.name },
        theme: { color: "#3fb950" },
        handler: async (resp) => {
          try {
            await doVerify({
              paymentId: order.paymentId,
              razorpay_payment_id: resp.razorpay_payment_id,
              razorpay_signature: resp.razorpay_signature,
            });
          } catch (err) {
            flash("error", errText(err));
          }
        },
      });
      rzp.open();
    } catch (err) {
      flash("error", errText(err));
    } finally {
      setBusy(false);
    }
  };

  const priceFor = (p) => (months === 12 ? p.price * 10 : p.price);
  const daysLeft = sub?.endDate
    ? Math.max(
        0,
        Math.ceil((new Date(sub.endDate).getTime() - Date.now()) / 86400000),
      )
    : 0;

  if (!isAdmin) {
    return (
      <div className="p-6">
       <div className="card flex items-center gap-3 p-6">
  <ShieldX
    aria-hidden="true"
    className="h-5 w-5 shrink-0 text-crewly-red"
    strokeWidth={1.8}
  />

  <span>
    Billing is managed by the Company Admin only.
  </span>
</div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold">
  <CreditCard
    aria-hidden="true"
    className="h-6 w-6 text-crewly-green"
    strokeWidth={1.8}
  />

  <span>
    Billing &amp; Plans
  </span>
</h1>
        <p className="text-sm text-crewly-dim">
          Upgrade, renew or change your subscription.
        </p>
      </div>

      {banner && (
        <div
          className={`card px-4 py-3 text-sm ${banner.type === "error" ? "text-crewly-red" : "text-crewly-green"}`}
        >
          {banner.text}
        </div>
      )}

      {/* current subscription */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="card p-5">
          <div className="text-xs text-crewly-dim">CURRENT PLAN</div>
          <div className="mt-1 text-2xl font-bold">{sub?.plan || "TRIAL"}</div>
          <div
            className={`mt-1 text-sm font-medium ${STATUS_STYLE[sub?.status] || ""}`}
          >
            {sub?.status || "ACTIVE"}
          </div>
        </div>
        <div className="card p-5">
          <div className="text-xs text-crewly-dim">VALIDITY</div>
          <div className="mt-1 text-2xl font-bold">
            {daysLeft} <span className="text-sm font-normal">days left</span>
          </div>
          <div className="mt-1 text-xs text-crewly-dim">
            until {fmtDate(sub?.endDate)}
          </div>
        </div>
        <div className="card p-5">
          <div className="text-xs text-crewly-dim">EMPLOYEE USAGE</div>
          <div className="mt-1 text-2xl font-bold">
            {usage?.employees ?? 0}{" "}
            <span className="text-sm font-normal">
              / {usage?.employeeLimit ?? 10}
            </span>
          </div>
          <div className="mt-2 h-2 rounded-full bg-crewly-border/40">
            <div
              className="h-2 rounded-full bg-crewly-green"
              style={{
                width: `${Math.min(100, Math.round(((usage?.employees || 0) / (usage?.employeeLimit || 10)) * 100))}%`,
              }}
            />
          </div>
        </div>
      </div>

      {/* billing cycle toggle */}
      <div className="flex items-center gap-3">
        <span className="text-sm text-crewly-dim">Billing cycle:</span>
        <div className="flex gap-2">
          {[
  [1, "Monthly"],
  [12, "Yearly — 2 months FREE"],
].map(([m, label]) => (
          <button
  key={m}
  onClick={() =>
    setMonths(m)
  }
  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition ${
    months === m
      ? "bg-crewly-green/15 text-crewly-green"
      : "border border-crewly-border text-crewly-dim"
  }`}
>
  {m === 12 && (
    <Gift
      aria-hidden="true"
      className="h-3.5 w-3.5"
      strokeWidth={1.8}
    />
  )}

  {label}
</button>
          ))}
        </div>
      </div>

      {/* plan cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {plans
          .filter((p) => p.key !== "TRIAL")
          .map((p) => {
            const current = sub?.plan === p.key;
            return (
              <div
                key={p.key}
                className={`card p-5 space-y-3 ${current ? "border border-crewly-green" : ""}`}
              >
                <div className="flex items-center justify-between">
                  <div className="font-semibold">{p.name}</div>
                  {current && (
                    <span className="badge bg-crewly-green/15 text-crewly-green">
                      CURRENT
                    </span>
                  )}
                </div>
                <div className="text-2xl font-bold">
                  {money(priceFor(p))}
                  <span className="text-sm font-normal text-crewly-dim">
                    {" "}
                    /{months === 12 ? "year" : "month"}
                  </span>
                </div>
                <ul className="space-y-1 text-xs text-crewly-dim">
                  {(Array.isArray(p.features)
                    ? p.features
                    : Object.entries(p.features || {})
                        .filter(([, enabled]) => enabled)
                        .map(([feature]) =>
                          feature
                            .replace(/([A-Z])/g, " $1")
                            .replace(/^./, (letter) => letter.toUpperCase()),
                        )
                  ).map((feature) => (
                  <li
  key={feature}
  className="flex items-start gap-2"
>
  <CircleCheckBig
    aria-hidden="true"
    className="mt-0.5 h-4 w-4 shrink-0 text-crewly-green"
    strokeWidth={1.8}
  />

  <span>
    {feature}
  </span>
</li>
                  ))}
                </ul>
                <button
                  className={
                    current
                      ? "btn-ghost w-full opacity-60"
                      : "btn-primary w-full"
                  }
                  disabled={current || busy}
                  onClick={() => startCheckout(p.key)}
                >
                  {current
                    ? "Active plan"
                    : sub?.plan === "TRIAL"
                      ? `Upgrade to ${p.name}`
                      : `Switch to ${p.name}`}
                </button>
              </div>
            );
          })}
      </div>

      {/* payment history */}
      <div className="card overflow-x-auto p-0">
       <div className="flex items-center gap-2 px-4 pt-4 text-sm font-semibold">
  <ReceiptText
    aria-hidden="true"
    className="h-4 w-4 text-crewly-green"
    strokeWidth={1.8}
  />

  <span>
    Payment History
  </span>
</div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-crewly-border text-crewly-dim">
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3">Duration</th>
              <th className="px-4 py-3">Amount</th>
              <th className="px-4 py-3">Gateway</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {payments.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center text-crewly-dim"
                >
                  No payments yet
                </td>
              </tr>
            ) : (
              payments.map((p) => (
                <tr
                  key={p._id}
                  className="border-b border-crewly-border/50 last:border-0"
                >
                  <td className="px-4 py-3">{fmtDate(p.createdAt)}</td>
                  <td className="px-4 py-3">{p.plan}</td>
                  <td className="px-4 py-3">{p.months} mo</td>
                  <td className="px-4 py-3">{money(p.amount)}</td>
                 <td className="px-4 py-3 text-xs">
  {p.gateway === "mock" ? (
    <span className="inline-flex items-center gap-1.5 text-crewly-orange">
      <FlaskConical
        aria-hidden="true"
        className="h-4 w-4"
        strokeWidth={1.8}
      />

      TEST
    </span>
  ) : (
    "Razorpay"
  )}
</td>
                  <td className="px-4 py-3">
                    <span
                      className={`badge ${p.status === "SUCCESS" ? "text-crewly-green" : p.status === "FAILED" ? "text-crewly-red" : "text-crewly-orange"}`}
                    >
                      {p.status}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ── TEST MODE payment modal (used when no Razorpay keys configured) ── */}
      {payModal && (
        <Modal
          onClose={() => setPayModal(null)}
         title={
  <span className="inline-flex items-center gap-2">
    <FlaskConical
      aria-hidden="true"
      className="h-5 w-5 text-crewly-orange"
      strokeWidth={1.8}
    />

    TEST MODE — Payment Simulator
  </span>
}
        >
          <div className="space-y-3">
            <p className="text-sm text-crewly-dim">
              No Razorpay keys configured, so this is a <b>simulated</b>{" "}
              payment. Add <code>RAZORPAY_KEY_ID</code>/
              <code>RAZORPAY_KEY_SECRET</code> to Backend/.env and this same
              button will open the real payment gateway — no code change needed.
            </p>
            <div className="card p-4 text-sm space-y-1">
              <div>
                <span className="text-crewly-dim">Company:</span>{" "}
                {company?.name}
              </div>
              <div>
                <span className="text-crewly-dim">Plan:</span> {payModal.plan} ·{" "}
                {months} month(s)
              </div>
              <div className="text-lg font-bold text-crewly-green">
                {money(payModal.order.amount)}
              </div>
            </div>
            <button
              className="btn-primary w-full"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await doVerify({
                    paymentId: payModal.order.paymentId,
                    mock: true,
                  });
                } catch (err) {
                  flash("error", errText(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
            {busy ? (
  "Processing…"
) : (
  <>
    <FlaskConical
      aria-hidden="true"
      className="mr-2 h-4 w-4"
      strokeWidth={1.8}
    />

    {`Pay ${money(payModal.order.amount)} (simulate)`}
  </>
)}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
