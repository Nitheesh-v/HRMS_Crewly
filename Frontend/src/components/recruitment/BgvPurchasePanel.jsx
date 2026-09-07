import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CreditCard,
  FlaskConical,
  Loader2,
  Receipt,
  ShieldCheck,
  ShoppingCart,
} from 'lucide-react';
import usePermission from '../../hooks/usePermission.js';
import bgvService from '../../services/bgvService.js';

// Loads Razorpay checkout.js ONLY when the real gateway is used — same
// pattern as the billing page (no keys => TEST MODE simulator).
const loadRazorpayScript = () =>
  new Promise((resolve) => {
    if (window.Razorpay) return resolve(true);
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
    return undefined;
  });

const STATUS_COPY = {
  CREATED: 'Order created — awaiting payment',
  PENDING_PAYMENT: 'Payment pending — complete or retry the payment',
  PAID: 'Paid — BGV checks purchased',
};

// Phase 30.3 — purchase BGV services for a candidate whose 30.1 decision is
// INITIATE BGV. All amounts shown are DISPLAY ONLY; the backend re-prices
// every order from the active catalogue. Mongo is the truth: a refresh
// re-reads the order, so double-clicks/double tabs never double-charge.
const BgvPurchasePanel = ({ candidateRef, decisionStatus }) => {
  const { hasPermission } = usePermission();
  const canManage = hasPermission('BACKGROUND_VERIFICATION_MANAGE');

  const [state, setState] = useState({
    loading: true,
    error: '',
    message: '',
    services: [],
    order: null,
    eligible: false,
    code: '',
    reason: '',
  });
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [testMode, setTestMode] = useState(false);

  const load = useCallback(async () => {
    if (!candidateRef) return;
    try {
      const [orderView, catalogue] = await Promise.all([
        bgvService.orderFor(candidateRef),
        bgvService.purchasableServices().catch(() => ({ services: [] })),
      ]);
      setState((current) => ({
        ...current,
        loading: false,
        error: '',
        services: catalogue?.services || [],
        order: orderView?.order || null,
        eligible: Boolean(orderView?.eligible),
        code: orderView?.code || '',
        reason: orderView?.reason || '',
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error?.response?.data?.message || error.message || 'Could not load BGV purchase',
      }));
    }
  }, [candidateRef]);

  // Re-sync when the 30.1 decision changes (e.g. HR just clicked
  // Initiate BGV) so the purchase UI appears without a page refresh.
  useEffect(() => {
    if (canManage) load();
  }, [canManage, load, decisionStatus]);

  if (!canManage) return null;

  const { loading, error, message, services, order, eligible, reason } = state;
  const selectedServices = services.filter((service) => selected.includes(service.type));
  const displayTotal = selectedServices.reduce(
    (sum, service) => sum + (service.priceMinorUnits || 0),
    0
  );
  const formatMinor = (minor) =>
    `₹${Math.floor((minor || 0) / 100).toLocaleString('en-IN')}.${String((minor || 0) % 100).padStart(2, '0')}`;

  const run = async (action, successMessage) => {
    setBusy(true);
    setState((current) => ({ ...current, error: '', message: '' }));
    try {
      await action();
      if (successMessage) setState((current) => ({ ...current, message: successMessage }));
      await load();
    } catch (requestError) {
      setState((current) => ({
        ...current,
        error:
          requestError?.response?.data?.message ||
          requestError.message ||
          'Something went wrong',
      }));
      await load(); // Mongo is the truth — re-sync after any failure.
    } finally {
      setBusy(false);
    }
  };

  const createOrder = () =>
    run(async () => {
      const result = await bgvService.createOrder(candidateRef, { selected });
      if (result?.reused) {
        setState((current) => ({
          ...current,
          message: 'An open BGV order already exists — showing it instead',
        }));
      }
    }, 'Order created — review and proceed to payment');

  const cancelOrder = () =>
    run(
      () => bgvService.cancelOrder(order.id),
      'Order cancelled — you can raise a fresh order if needed'
    );

  const verify = async (payload) => {
    setBusy(true);
    setTestMode(false);
    try {
      const result = await bgvService.verifyPayment(order.id, payload);
      setState((current) => ({
        ...current,
        error: '',
        message: result?.idempotent
          ? 'Payment was already confirmed'
          : 'Payment confirmed — BGV checks purchased',
      }));
      await load();
    } catch (requestError) {
      setState((current) => ({
        ...current,
        error:
          requestError?.response?.data?.message ||
          requestError.message ||
          'Payment verification failed',
      }));
      await load();
    } finally {
      setBusy(false);
    }
  };

  const startPayment = async () => {
    setBusy(true);
    setState((current) => ({ ...current, error: '', message: '' }));
    try {
      const result = await bgvService.initiatePayment(order.id);
      const checkout = result?.checkout;
      if (!checkout) {
        // Already paid — replay.
        await load();
        return;
      }
      if (checkout.mock) {
        setTestMode(true); // no Razorpay keys — TEST MODE simulator
        return;
      }
      const ok = await loadRazorpayScript();
      if (!ok) {
        setState((current) => ({
          ...current,
          error: 'Could not load the payment gateway. Check your internet.',
        }));
        return;
      }
      const rzp = new window.Razorpay({
        key: checkout.keyId,
        order_id: checkout.providerOrderId,
        amount: checkout.amountMinorUnits,
        currency: checkout.currency || 'INR',
        name: 'Crewly HRMS',
        description: `BGV checks · ${order.orderCode}`,
        theme: { color: '#3fb950' },
        handler: (response) => {
          verify({
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature,
          });
        },
        modal: {
          ondismiss: () => {
            setState((current) => ({
              ...current,
              message: 'Payment cancelled — the order stays pending; you can retry safely.',
            }));
          },
        },
      });
      rzp.open();
    } catch (requestError) {
      setState((current) => ({
        ...current,
        error:
          requestError?.response?.data?.message ||
          requestError.message ||
          'Could not start the payment',
      }));
      await load();
    } finally {
      setBusy(false);
    }
  };

  // ── loading / hard error ───────────────────────────────────────
  if (loading) {
    return (
      <section className="rounded-2xl border border-teal-500/20 bg-teal-500/5 p-5">
        <p className="flex items-center gap-2 text-sm text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading BGV purchase…
        </p>
      </section>
    );
  }

  // ── existing order view (refresh/resume; Mongo is the truth) ───
  if (order) {
    const paid = order.status === 'PAID';
    return (
      <section
        className={`rounded-2xl border p-5 ${
          paid ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-teal-500/20 bg-teal-500/5'
        }`}
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className={`rounded-xl p-2 ${paid ? 'bg-emerald-500/10 text-emerald-300' : 'bg-teal-500/10 text-teal-300'}`}>
                {paid ? <CheckCircle2 className="h-5 w-5" /> : <Receipt className="h-5 w-5" />}
              </span>
              <div>
                <h2 className="font-semibold text-slate-100">
                  BGV order {order.orderCode}
                </h2>
                <p className="mt-1 text-sm text-slate-400">{STATUS_COPY[order.status] || order.status}</p>
              </div>
            </div>
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                paid ? 'bg-emerald-500/15 text-emerald-300' : 'bg-teal-500/15 text-teal-300'
              }`}
            >
              {paid ? 'PAID' : 'AWAITING PAYMENT'}
            </span>
          </div>

          <ul className="space-y-2 rounded-xl border border-slate-700/60 bg-slate-900/40 p-4 text-sm">
            {order.items.map((item) => (
              <li key={item.type} className="flex items-center justify-between gap-3">
                <span className="text-slate-200">{item.name}</span>
                <span className="text-slate-400">{item.priceDisplay}</span>
              </li>
            ))}
            <li className="flex items-center justify-between border-t border-slate-700/60 pt-2 font-semibold text-slate-100">
              <span>Total (server-confirmed)</span>
              <span>{order.totalDisplay}</span>
            </li>
          </ul>

          {paid ? (
            <p className="flex items-start gap-2 text-sm text-emerald-200/80">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
              Paid on {new Date(order.paidAt).toLocaleString()}. Candidate consent
              collection is part of the next workflow step — nothing has been sent
              to the candidate yet.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-primary gap-2" disabled={busy} onClick={startPayment}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
                Proceed to payment
              </button>
              <button type="button" className="btn-ghost gap-2" disabled={busy} onClick={cancelOrder}>
                <Ban className="h-4 w-4" /> Cancel order
              </button>
            </div>
          )}

          {/* TEST MODE simulator — only when no Razorpay keys are configured. */}
          {testMode && !paid ? (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-amber-200">
                <FlaskConical className="h-4 w-4" /> TEST MODE — payment simulator
              </p>
              <p className="mt-2 text-sm text-slate-400">
                No Razorpay keys are configured on the backend, so this is a
                simulated payment. Add <code>RAZORPAY_KEY_ID</code>/
                <code>RAZORPAY_KEY_SECRET</code> to Backend/.env and the same
                button opens the real gateway — no code change needed.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-primary gap-2"
                  disabled={busy}
                  onClick={() => verify({ mock: true })}
                >
                  <CheckCircle2 className="h-4 w-4" /> Confirm simulated payment
                </button>
                <button type="button" className="btn-ghost" disabled={busy} onClick={() => setTestMode(false)}>
                  Close
                </button>
              </div>
            </div>
          ) : null}

          {error ? (
            <p className="flex items-start gap-2 text-sm text-rose-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
            </p>
          ) : null}
          {message ? <p className="text-sm text-emerald-300">{message}</p> : null}
        </div>
      </section>
    );
  }

  // ── no order: eligibility + selection ──────────────────────────
  if (!eligible) {
    return (
      <section className="rounded-2xl border border-slate-700/60 bg-slate-900/40 p-5">
        <p className="flex items-start gap-2 text-sm text-slate-400">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-teal-300" />
          {reason || 'Record the Initiate BGV decision before purchasing checks.'}
        </p>
      </section>
    );
  }

  if (services.length === 0) {
    return (
      <section className="rounded-2xl border border-slate-700/60 bg-slate-900/40 p-5">
        <p className="flex items-start gap-2 text-sm text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          No BGV services are active and configured yet. A Super Admin must
          configure and activate services (Super Admin → BGV Services) before
          checks can be purchased.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-teal-500/20 bg-teal-500/5 p-5">
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <span className="rounded-xl bg-teal-500/10 p-2 text-teal-300">
            <ShoppingCart className="h-5 w-5" />
          </span>
          <div>
            <h2 className="font-semibold text-slate-100">Purchase BGV checks</h2>
            <p className="mt-1 text-sm text-slate-400">
              Select the verification services to buy for this candidate. The
              server confirms the final amount — displayed totals are indicative.
            </p>
          </div>
        </div>

        <ul className="space-y-2">
          {services.map((service) => {
            const checked = selected.includes(service.type);
            return (
              <li key={service.type}>
                <label
                  className={`flex cursor-pointer items-start justify-between gap-3 rounded-xl border p-3 text-sm transition ${
                    checked
                      ? 'border-teal-400/50 bg-teal-500/10'
                      : 'border-slate-700/60 bg-slate-900/40 hover:border-slate-600'
                  }`}
                >
                  <span className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 accent-teal-400"
                      checked={checked}
                      onChange={() =>
                        setSelected((current) =>
                          current.includes(service.type)
                            ? current.filter((type) => type !== service.type)
                            : [...current, service.type]
                        )
                      }
                    />
                    <span>
                      <span className="block font-medium text-slate-100">{service.name}</span>
                      {service.description ? (
                        <span className="mt-0.5 block text-xs text-slate-400">
                          {service.description}
                        </span>
                      ) : null}
                    </span>
                  </span>
                  <span className="whitespace-nowrap font-semibold text-slate-200">
                    {service.priceDisplay}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-700/60 bg-slate-900/40 p-4">
          <div className="text-sm">
            <span className="text-slate-400">Estimated total ({selected.length} service{selected.length === 1 ? '' : 's'}): </span>
            <span className="text-lg font-bold text-teal-300">{formatMinor(displayTotal)}</span>
          </div>
          <button
            type="button"
            className="btn-primary gap-2"
            disabled={busy || selected.length === 0}
            onClick={createOrder}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Receipt className="h-4 w-4" />}
            Create order
          </button>
        </div>

        {error ? (
          <p className="flex items-start gap-2 text-sm text-rose-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
          </p>
        ) : null}
        {message ? <p className="text-sm text-emerald-300">{message}</p> : null}
      </div>
    </section>
  );
};

export default BgvPurchasePanel;
