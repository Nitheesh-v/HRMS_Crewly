import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  CalendarDays,
  Check,
  Landmark,
  ShieldCheck,
} from 'lucide-react';

import Modal from '../../components/Modal.jsx';
import usePermission from '../../hooks/usePermission.js';
import payrollSetupService from '../../services/payrollSetupService.js';

// ─────────────────────────────────────────────────────────────
// Phase 29.1 — Company Payroll Setup
//
//  · NOT_CONFIGURED → "Payroll Setup Required" + Start button
//  · DRAFT / CONFIGURED → 4-step wizard (left stepper, autosave)
//  · ACTIVE / SUSPENDED → settings dashboard with View / Edit
//
//  Statutory fields are conditional (§9): registration inputs appear
//  only when the corresponding component is switched on.
//  Bank account numbers are always displayed masked (§17).
// ─────────────────────────────────────────────────────────────

const STEPS = [
  { key: 'LEGAL', title: 'Company & Legal Information', icon: Building2 },
  { key: 'STATUTORY', title: 'Statutory Configuration', icon: ShieldCheck },
  { key: 'POLICY', title: 'Payroll Policy', icon: CalendarDays },
  { key: 'BANK', title: 'Company Bank Account', icon: Landmark },
];

const DAY_OPTIONS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

const FREQUENCY_LABELS = {
  MONTHLY: 'Monthly',
  WEEKLY: 'Weekly (coming soon)',
  BIWEEKLY: 'Bi-weekly (coming soon)',
  SEMIMONTHLY: 'Semi-monthly (coming soon)',
};

const emptyForm = {
  LEGAL: {
    legalName: '',
    pan: '',
    tan: '',
    gst: '',
    cin: '',
    addressLine: '',
    city: '',
    state: '',
    pincode: '',
    country: 'India',
  },
  STATUTORY: {
    pf: { applicable: false, establishmentNumber: '' },
    esi: { applicable: false, registrationNumber: '' },
    professionalTax: { applicable: false, state: '' },
    labourWelfareFund: { applicable: false, state: '' },
    gratuity: { applicable: false },
    tds: { applicable: false },
  },
  POLICY: {
    frequency: 'MONTHLY',
    cycleType: 'FIXED_MONTH_DAY',
    cycleStartDay: 1,
    cycleEndDay: 31,
    paymentDateType: 'SPECIFIC_DAY',
    paymentDayOfMonth: 30,
    paymentMonthOffset: 0,
    currency: 'INR',
    financialYearStartMonth: 4,
    weekendPolicy: { type: 'SAT_SUN', customWorkingDays: [] },
    lopPolicy: { basis: 'PER_DAY' },
    overtimePolicy: { enabled: false, basis: 'HOURLY', multiplier: 1 },
    processingDeadlineDay: 25,
    lockRequiresReopen: true,
  },
  BANK: {
    bankName: '',
    accountHolderName: '',
    accountNumber: '',
    ifsc: '',
    branch: '',
    accountType: 'CURRENT',
    paymentReferencePrefix: '',
  },
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const statusBadgeClass = (status) => {
  if (status === 'ACTIVE') return 'bg-crewly-green/15 text-crewly-green';
  if (status === 'SUSPENDED') return 'bg-crewly-red/15 text-crewly-red';
  if (status === 'CONFIGURED') return 'bg-crewly-orange/15 text-crewly-orange';
  return 'bg-crewly-border/40 text-crewly-dim';
};

const PayrollSetupPage = () => {
  const { loading: permsLoading, hasPermission } = usePermission();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [banner, setBanner] = useState(null);
  const [payload, setPayload] = useState(null);
  const [form, setForm] = useState(clone(emptyForm));
  const [step, setStep] = useState(1);
  const [mode, setMode] = useState('auto'); // auto | wizard | dashboard
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmActivate, setConfirmActivate] = useState(false);
  const [suspendReason, setSuspendReason] = useState('');
  const [confirmSuspend, setConfirmSuspend] = useState(false);

  const canUpdate = hasPermission('PAYROLL_SETUP_UPDATE');
  const canActivate = hasPermission('PAYROLL_SETUP_ACTIVATE');
  const canEdit = canUpdate && !permsLoading;

  const saveTimer = useRef(null);

  const config = payload?.config;
  const evaluation = payload?.evaluation;
  const summary = payload?.summary;
  const status = config?.status || 'NOT_CONFIGURED';

  const flash = useCallback((type, text) => {
    setBanner({ type, text });
    setTimeout(() => setBanner(null), 4000);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await payrollSetupService.get();
      setPayload(data);
      const next = clone(emptyForm);
      next.LEGAL = { ...next.LEGAL, ...(data.config?.legal || {}) };
      next.STATUTORY = {
        pf: { ...next.STATUTORY.pf, ...(data.config?.statutory?.pf || {}) },
        esi: { ...next.STATUTORY.esi, ...(data.config?.statutory?.esi || {}) },
        professionalTax: {
          ...next.STATUTORY.professionalTax,
          ...(data.config?.statutory?.professionalTax || {}),
        },
        labourWelfareFund: {
          ...next.STATUTORY.labourWelfareFund,
          ...(data.config?.statutory?.labourWelfareFund || {}),
        },
        gratuity: { ...(data.config?.statutory?.gratuity || {}) },
        tds: { ...(data.config?.statutory?.tds || {}) },
      };
      next.POLICY = { ...next.POLICY, ...(data.config?.payrollPolicy || {}) };
      next.POLICY.weekendPolicy = {
        ...next.POLICY.weekendPolicy,
        ...(data.config?.payrollPolicy?.weekendPolicy || {}),
      };
      next.POLICY.lopPolicy = {
        ...next.POLICY.lopPolicy,
        ...(data.config?.payrollPolicy?.lopPolicy || {}),
      };
      next.POLICY.overtimePolicy = {
        ...next.POLICY.overtimePolicy,
        ...(data.config?.payrollPolicy?.overtimePolicy || {}),
      };
      next.BANK = { ...next.BANK, ...(data.config?.bankAccount || {}) };
      next.BANK.accountNumber = ''; // never pre-fill the stored number
      setForm(next);
      setDirty(false);
      setError('');
    } catch (err) {
      setError(err.message || 'Unable to load payroll setup');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const showWizard = useMemo(() => {
    if (!config) return false;
    if (mode === 'wizard') return true;
    if (mode === 'dashboard') return false;
    return status === 'DRAFT' || status === 'CONFIGURED';
  }, [config, mode, status]);

  // ── Autosave (§32): debounced, and never autosaves the account number ──
  useEffect(() => {
    if (!showWizard || !canEdit || !dirty || saving) return undefined;
    const activeKey = STEPS[step - 1]?.key;
    if (!activeKey) return undefined;

    saveTimer.current = setTimeout(async () => {
      const payloadSection = clone(form[activeKey]);
      if (activeKey === 'BANK') delete payloadSection.accountNumber;
      try {
        const data = await payrollSetupService.saveSection(activeKey, payloadSection);
        setPayload(data);
        setDirty(false);
        flash('ok', 'Draft saved');
      } catch (err) {
        setError(err.message || 'Could not save this section');
      }
    }, 1800);

    return () => clearTimeout(saveTimer.current);
  }, [form, dirty, showWizard, step, canEdit, saving, flash]);

  const updateField = (section, field, value) => {
    setForm((prev) => ({ ...prev, [section]: { ...prev[section], [field]: value } }));
    setDirty(true);
  };

  const updateNested = (section, group, field, value) => {
    setForm((prev) => ({
      ...prev,
      [section]: {
        ...prev[section],
        [group]: { ...prev[section][group], [field]: value },
      },
    }));
    setDirty(true);
  };

  const startSetup = async () => {
    setSaving(true);
    try {
      const data = await payrollSetupService.start();
      setPayload(data);
      setMode('wizard');
      setStep(1);
      flash('ok', 'Payroll setup started');
    } catch (err) {
      setError(err.message || 'Unable to start payroll setup');
    } finally {
      setSaving(false);
    }
  };

  const saveCurrentStep = async ({ advance = false } = {}) => {
    const activeKey = STEPS[step - 1]?.key;
    if (!activeKey) return false;
    setSaving(true);
    setError('');
    try {
      const data = await payrollSetupService.saveSection(activeKey, clone(form[activeKey]));
      setPayload(data);
      setDirty(false);
      if (advance) {
        setStep((prev) => Math.min(5, prev + 1));
        flash('ok', 'Draft saved');
      } else {
        flash('ok', 'Saved');
      }
      return true;
    } catch (err) {
      setError(err.message || 'Could not save this section');
      if (err?.data?.errors?.length) {
        setError(err.data.errors.map((e) => e.message).join(' · '));
      }
      return false;
    } finally {
      setSaving(false);
    }
  };

  const activate = async () => {
    setSaving(true);
    try {
      const data = await payrollSetupService.activate(config?.configVersion);
      setPayload(data);
      setConfirmActivate(false);
      setMode('dashboard');
      flash('ok', 'Payroll activated');
    } catch (err) {
      const detail = err?.data?.errors?.length
        ? err.data.errors.map((e) => e.message).join(' · ')
        : err.message;
      setError(detail || 'Unable to activate payroll');
      setConfirmActivate(false);
    } finally {
      setSaving(false);
    }
  };

  const suspend = async () => {
    setSaving(true);
    try {
      const data = await payrollSetupService.suspend(suspendReason);
      setPayload(data);
      setConfirmSuspend(false);
      setSuspendReason('');
      flash('ok', 'Payroll suspended');
    } catch (err) {
      setError(err.message || 'Unable to suspend payroll');
    } finally {
      setSaving(false);
    }
  };

  // ─────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────

  if (loading) {
    return <div className="card text-crewly-dim">Loading payroll setup…</div>;
  }

  if (error && !payload) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Payroll Setup</h1>
        <div className="rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">
          {error}
        </div>
      </div>
    );
  }

  // ── NOT_CONFIGURED (§30) ──
  if (status === 'NOT_CONFIGURED') {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-bold">Payroll Setup</h1>
        {banner && (
          <div className="rounded-lg border border-crewly-green/40 bg-crewly-green/10 px-4 py-3 text-sm text-crewly-green">
            {banner.text}
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">
            {error}
          </div>
        )}
        <div className="card space-y-4 text-center">
          <h2 className="text-lg font-semibold">Payroll Setup Required</h2>
          <p className="text-sm text-crewly-dim">
            Complete your company&apos;s payroll configuration before processing salaries.
          </p>
          <div className="text-sm text-crewly-dim">
            {evaluation?.completedCount ?? 0} / {evaluation?.totalCount ?? 4} Sections Completed
          </div>
          <div className="grid gap-3 text-left md:grid-cols-2">
            {STEPS.map((entry) => (
              <div key={entry.key} className="rounded-lg border border-crewly-border p-4 text-sm">
                <div className="font-medium">{entry.title}</div>
                <div className="mt-1 text-xs text-crewly-dim">Not started</div>
              </div>
            ))}
          </div>
          {canEdit ? (
            <button className="btn-primary" onClick={startSetup} disabled={saving}>
              {saving ? 'Starting…' : 'Start Payroll Setup'}
            </button>
          ) : (
            <p className="text-sm text-crewly-dim">
              You do not have permission to configure payroll. Contact your Company Admin.
            </p>
          )}
        </div>
      </div>
    );
  }

  // ── ACTIVE / SUSPENDED dashboard (§34) ──
  if (!showWizard) {
    return (
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">Payroll Configuration</h1>
          <span className={`badge ${statusBadgeClass(status)}`}>{status}</span>
        </div>

        {banner && (
          <div className="rounded-lg border border-crewly-green/40 bg-crewly-green/10 px-4 py-3 text-sm text-crewly-green">
            {banner.text}
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">
            {error}
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="card">
            <div className="flex items-center gap-2 text-sm text-crewly-dim">
              <Building2 size={16} /> Company Information
            </div>
            <div className="mt-2 font-semibold">{config.legal.legalName || 'Not set'}</div>
            <div className="mt-1 text-xs text-crewly-dim">
              {[config.legal.state, config.legal.country].filter(Boolean).join(' · ') || 'State not set'}
            </div>
          </div>

          <div className="card">
            <div className="flex items-center gap-2 text-sm text-crewly-dim">
              <ShieldCheck size={16} /> Statutory Configuration
            </div>
            <div className="mt-2 font-semibold">
              {summary?.statutory?.length ? summary.statutory.join(' · ') : 'None enabled'}
            </div>
            <div className="mt-1 text-xs text-crewly-dim">
              PAN {config.legal.pan || '—'} · TAN {config.legal.tan || '—'}
            </div>
          </div>

          <div className="card">
            <div className="flex items-center gap-2 text-sm text-crewly-dim">
              <CalendarDays size={16} /> Payroll Policy
            </div>
            <div className="mt-2 font-semibold">
              {FREQUENCY_LABELS[summary?.frequency] || summary?.frequency}
            </div>
            <div className="mt-1 text-xs text-crewly-dim">
              Cycle {summary?.cycle} · Salary date {summary?.paymentLabel}
            </div>
          </div>

          <div className="card">
            <div className="flex items-center gap-2 text-sm text-crewly-dim">
              <Landmark size={16} /> Bank Account
            </div>
            <div className="mt-2 font-semibold">{summary?.bank?.bankName || 'Not set'}</div>
            <div className="mt-1 text-xs text-crewly-dim">
              {summary?.bank?.maskedAccountNumber || '—'} · {summary?.bank?.ifsc || '—'}
            </div>
          </div>
        </div>

        <div className="card space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            {STEPS.map((entry) => {
              const section = evaluation?.sections?.find((s) => s.key === entry.key);
              const Icon = entry.icon;
              return (
                <div
                  key={entry.key}
                  className="flex items-start justify-between gap-3 rounded-lg border border-crewly-border p-4"
                >
                  <div>
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Icon size={16} /> {entry.title}
                    </div>
                    <div className="mt-1 text-xs text-crewly-dim">
                      {section?.complete ? 'Configured' : 'Incomplete'}
                    </div>
                    {section?.errors?.length ? (
                      <div className="mt-1 text-xs text-crewly-red">
                        {section.errors[0].message}
                      </div>
                    ) : null}
                  </div>
                  <button
                    className="btn-ghost px-3 py-1.5 text-xs"
                    onClick={() => {
                      setStep(STEPS.findIndex((s) => s.key === entry.key) + 1);
                      setMode('wizard');
                    }}
                  >
                    View / Edit
                  </button>
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-crewly-border pt-4 text-xs text-crewly-dim">
            <span>
              Last updated {config.updatedAt ? new Date(config.updatedAt).toLocaleDateString('en-IN') : '—'}
              {config.activation?.activatedAt
                ? ` · Activated ${new Date(config.activation.activatedAt).toLocaleDateString('en-IN')}`
                : ''}
            </span>
            <div className="flex gap-2">
              {canActivate && status === 'ACTIVE' && (
                <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setConfirmSuspend(true)}>
                  Suspend Payroll
                </button>
              )}
              {canActivate && status === 'SUSPENDED' && (
                <button className="btn-primary px-3 py-1.5 text-xs" onClick={activate} disabled={saving}>
                  {saving ? 'Working…' : 'Reactivate Payroll'}
                </button>
              )}
            </div>
          </div>
        </div>

        {confirmSuspend && (
          <Modal title="Suspend payroll" onClose={() => setConfirmSuspend(false)}>
            <div className="space-y-4 text-sm">
              <p>Salary processing will be paused until payroll is reactivated.</p>
              <div>
                <label className="label">Reason</label>
                <input
                  className="input"
                  value={suspendReason}
                  onChange={(e) => setSuspendReason(e.target.value)}
                  placeholder="Statutory review"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button className="btn-ghost" onClick={() => setConfirmSuspend(false)}>
                  Cancel
                </button>
                <button className="btn-primary" onClick={suspend} disabled={saving}>
                  {saving ? 'Suspending…' : 'Suspend Payroll'}
                </button>
              </div>
            </div>
          </Modal>
        )}
      </div>
    );
  }

  // ── Wizard (§5 / §31) ──
  const activeKey = STEPS[step - 1]?.key;
  const review = step === 5;
  const canActivateNow = Boolean(evaluation?.allComplete) && canActivate;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Payroll Setup</h1>
        <span className={`badge ${statusBadgeClass(status)}`}>{status}</span>
      </div>

      {banner && (
        <div className="rounded-lg border border-crewly-green/40 bg-crewly-green/10 px-4 py-3 text-sm text-crewly-green">
          {banner.text}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">
          {error}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
        {/* Stepper */}
        <div className="card h-fit space-y-1">
          {STEPS.map((entry, index) => {
            const section = evaluation?.sections?.find((s) => s.key === entry.key);
            const state = index + 1 === step ? 'current' : section?.complete ? 'done' : 'pending';
            const Icon = entry.icon;
            return (
              <button
                key={entry.key}
                onClick={() => setStep(index + 1)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition ${
                  state === 'current'
                    ? 'bg-crewly-green/15 text-crewly-green'
                    : 'text-crewly-dim hover:text-crewly-text'
                }`}
              >
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                    state === 'done'
                      ? 'bg-crewly-green/20 text-crewly-green'
                      : 'border border-crewly-border'
                  }`}
                >
                  {state === 'done' ? <Check size={14} /> : index + 1}
                </span>
                <span className="flex-1">{entry.title}</span>
                <Icon size={14} />
              </button>
            );
          })}
          <button
            onClick={() => setStep(5)}
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition ${
              review ? 'bg-crewly-green/15 text-crewly-green' : 'text-crewly-dim hover:text-crewly-text'
            }`}
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-full border border-crewly-border text-xs">
              5
            </span>
            Review &amp; Activate
          </button>

          <div className="border-t border-crewly-border pt-3 text-xs text-crewly-dim">
            {evaluation?.completedCount ?? 0} / {evaluation?.totalCount ?? 4} Sections Completed
            {dirty && <div className="mt-1 text-crewly-orange">Unsaved changes</div>}
            {!dirty && config?.setup?.lastSavedAt && (
              <div className="mt-1">
                Draft saved {new Date(config.setup.lastSavedAt).toLocaleTimeString('en-IN')}
              </div>
            )}
          </div>
        </div>

        {/* Step content */}
        <div className="card space-y-5">
          {/* STEP 1 — LEGAL */}
          {activeKey === 'LEGAL' && (
            <>
              <div>
                <h2 className="text-lg font-semibold">Company &amp; Legal Information</h2>
                <p className="text-sm text-crewly-dim">
                  The legal entity responsible for paying employees. Details already on your
                  company profile are pre-filled.
                </p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="md:col-span-2">
                  <label className="label">Legal company name</label>
                  <input
                    className="input"
                    value={form.LEGAL.legalName}
                    onChange={(e) => updateField('LEGAL', 'legalName', e.target.value)}
                    placeholder="Acme Technologies Pvt Ltd"
                  />
                </div>
                <div>
                  <label className="label">PAN</label>
                  <input
                    className="input"
                    value={form.LEGAL.pan}
                    onChange={(e) => updateField('LEGAL', 'pan', e.target.value.toUpperCase())}
                    placeholder="ABCDE1234F"
                  />
                  <p className="mt-1 text-xs text-crewly-dim">Required when TDS is applicable.</p>
                </div>
                <div>
                  <label className="label">TAN</label>
                  <input
                    className="input"
                    value={form.LEGAL.tan}
                    onChange={(e) => updateField('LEGAL', 'tan', e.target.value.toUpperCase())}
                    placeholder="ABCD12345E"
                  />
                </div>
                <div>
                  <label className="label">GST number (optional)</label>
                  <input
                    className="input"
                    value={form.LEGAL.gst}
                    onChange={(e) => updateField('LEGAL', 'gst', e.target.value.toUpperCase())}
                    placeholder="27ABCDE1234F1Z5"
                  />
                </div>
                <div>
                  <label className="label">CIN (optional)</label>
                  <input
                    className="input"
                    value={form.LEGAL.cin}
                    onChange={(e) => updateField('LEGAL', 'cin', e.target.value.toUpperCase())}
                    placeholder="U72200KA2010PTC055123"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="label">Registered address</label>
                  <input
                    className="input"
                    value={form.LEGAL.addressLine}
                    onChange={(e) => updateField('LEGAL', 'addressLine', e.target.value)}
                  />
                </div>
                <div>
                  <label className="label">City</label>
                  <input
                    className="input"
                    value={form.LEGAL.city}
                    onChange={(e) => updateField('LEGAL', 'city', e.target.value)}
                  />
                </div>
                <div>
                  <label className="label">State</label>
                  <input
                    className="input"
                    value={form.LEGAL.state}
                    onChange={(e) => updateField('LEGAL', 'state', e.target.value)}
                    placeholder="Karnataka"
                  />
                  <p className="mt-1 text-xs text-crewly-dim">
                    Required — statutory rules depend on the state.
                  </p>
                </div>
                <div>
                  <label className="label">PIN code</label>
                  <input
                    className="input"
                    value={form.LEGAL.pincode}
                    onChange={(e) => updateField('LEGAL', 'pincode', e.target.value)}
                  />
                </div>
                <div>
                  <label className="label">Country</label>
                  <input
                    className="input"
                    value={form.LEGAL.country}
                    onChange={(e) => updateField('LEGAL', 'country', e.target.value)}
                  />
                </div>
              </div>
            </>
          )}

          {/* STEP 2 — STATUTORY */}
          {activeKey === 'STATUTORY' && (
            <>
              <div>
                <h2 className="text-lg font-semibold">Statutory Configuration</h2>
                <p className="text-sm text-crewly-dim">
                  Choose what applies to your company. Registration details are only required
                  for the components you switch on. Rates and calculations are configured in
                  later payroll phases.
                </p>
              </div>

              <div className="space-y-3 rounded-lg border border-crewly-border p-4">
                <label className="flex items-center gap-3 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={form.STATUTORY.pf.applicable}
                    onChange={(e) =>
                      updateNested('STATUTORY', 'pf', 'applicable', e.target.checked)
                    }
                  />
                  Provident Fund (PF) applicable
                </label>
                {form.STATUTORY.pf.applicable && (
                  <div>
                    <label className="label">PF establishment number</label>
                    <input
                      className="input"
                      value={form.STATUTORY.pf.establishmentNumber}
                      onChange={(e) =>
                        updateNested('STATUTORY', 'pf', 'establishmentNumber', e.target.value)
                      }
                      placeholder="KABOM1234567"
                    />
                    <p className="mt-1 text-xs text-crewly-dim">
                      Required because PF is switched on.
                    </p>
                  </div>
                )}
              </div>

              <div className="space-y-3 rounded-lg border border-crewly-border p-4">
                <label className="flex items-center gap-3 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={form.STATUTORY.esi.applicable}
                    onChange={(e) =>
                      updateNested('STATUTORY', 'esi', 'applicable', e.target.checked)
                    }
                  />
                  ESI applicable
                </label>
                {form.STATUTORY.esi.applicable && (
                  <div>
                    <label className="label">ESI registration number</label>
                    <input
                      className="input"
                      value={form.STATUTORY.esi.registrationNumber}
                      onChange={(e) =>
                        updateNested('STATUTORY', 'esi', 'registrationNumber', e.target.value)
                      }
                    />
                  </div>
                )}
              </div>

              <div className="space-y-3 rounded-lg border border-crewly-border p-4">
                <label className="flex items-center gap-3 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={form.STATUTORY.professionalTax.applicable}
                    onChange={(e) =>
                      updateNested('STATUTORY', 'professionalTax', 'applicable', e.target.checked)
                    }
                  />
                  Professional Tax applicable
                </label>
                {form.STATUTORY.professionalTax.applicable && (
                  <div>
                    <label className="label">Professional Tax state</label>
                    <input
                      className="input"
                      value={form.STATUTORY.professionalTax.state}
                      onChange={(e) =>
                        updateNested('STATUTORY', 'professionalTax', 'state', e.target.value)
                      }
                    />
                  </div>
                )}
              </div>

              <div className="space-y-3 rounded-lg border border-crewly-border p-4">
                <label className="flex items-center gap-3 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={form.STATUTORY.labourWelfareFund.applicable}
                    onChange={(e) =>
                      updateNested('STATUTORY', 'labourWelfareFund', 'applicable', e.target.checked)
                    }
                  />
                  Labour Welfare Fund applicable
                </label>
                {form.STATUTORY.labourWelfareFund.applicable && (
                  <div>
                    <label className="label">Labour Welfare Fund state</label>
                    <input
                      className="input"
                      value={form.STATUTORY.labourWelfareFund.state}
                      onChange={(e) =>
                        updateNested('STATUTORY', 'labourWelfareFund', 'state', e.target.value)
                      }
                    />
                  </div>
                )}
              </div>

              <div className="space-y-3 rounded-lg border border-crewly-border p-4">
                <label className="flex items-center gap-3 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={form.STATUTORY.gratuity.applicable}
                    onChange={(e) =>
                      updateNested('STATUTORY', 'gratuity', 'applicable', e.target.checked)
                    }
                  />
                  Gratuity applicable
                </label>
                <label className="flex items-center gap-3 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={form.STATUTORY.tds.applicable}
                    onChange={(e) =>
                      updateNested('STATUTORY', 'tds', 'applicable', e.target.checked)
                    }
                  />
                  TDS (payroll tax) applicable
                </label>
                <p className="text-xs text-crewly-dim">
                  TDS requires the company PAN in step 1.
                </p>
              </div>
            </>
          )}

          {/* STEP 3 — POLICY */}
          {activeKey === 'POLICY' && (
            <>
              <div>
                <h2 className="text-lg font-semibold">Payroll Policy</h2>
                <p className="text-sm text-crewly-dim">
                  How this company runs payroll. These settings are consumed by the payroll
                  engine in later phases.
                </p>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="label">Payroll frequency</label>
                  <select
                    className="input"
                    value={form.POLICY.frequency}
                    onChange={(e) => updateField('POLICY', 'frequency', e.target.value)}
                  >
                    {Object.entries(FREQUENCY_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">Currency</label>
                  <input
                    className="input"
                    value={form.POLICY.currency}
                    onChange={(e) => updateField('POLICY', 'currency', e.target.value.toUpperCase())}
                  />
                </div>
                <div>
                  <label className="label">Cycle start day</label>
                  <input
                    type="number"
                    min="1"
                    max="31"
                    className="input"
                    value={form.POLICY.cycleStartDay}
                    onChange={(e) => updateField('POLICY', 'cycleStartDay', Number(e.target.value))}
                  />
                </div>
                <div>
                  <label className="label">Cycle end day</label>
                  <input
                    type="number"
                    min="1"
                    max="31"
                    className="input"
                    value={form.POLICY.cycleEndDay}
                    onChange={(e) => updateField('POLICY', 'cycleEndDay', Number(e.target.value))}
                  />
                  <p className="mt-1 text-xs text-crewly-dim">
                    Examples: 1 → 31 or 26 → 25.
                  </p>
                </div>
                <div>
                  <label className="label">Salary payment date</label>
                  <select
                    className="input"
                    value={form.POLICY.paymentDateType}
                    onChange={(e) => updateField('POLICY', 'paymentDateType', e.target.value)}
                  >
                    <option value="SPECIFIC_DAY">Specific day of month</option>
                    <option value="LAST_WORKING_DAY">Last working day</option>
                    <option value="CUSTOM">Custom</option>
                  </select>
                </div>
                {form.POLICY.paymentDateType !== 'LAST_WORKING_DAY' && (
                  <div>
                    <label className="label">Payment day</label>
                    <input
                      type="number"
                      min="1"
                      max="31"
                      className="input"
                      value={form.POLICY.paymentDayOfMonth}
                      onChange={(e) =>
                        updateField('POLICY', 'paymentDayOfMonth', Number(e.target.value))
                      }
                    />
                  </div>
                )}
                {form.POLICY.paymentDateType === 'CUSTOM' && (
                  <div>
                    <label className="label">Paid in</label>
                    <select
                      className="input"
                      value={form.POLICY.paymentMonthOffset}
                      onChange={(e) =>
                        updateField('POLICY', 'paymentMonthOffset', Number(e.target.value))
                      }
                    >
                      <option value={0}>Same month</option>
                      <option value={1}>Following month</option>
                    </select>
                  </div>
                )}
                <div>
                  <label className="label">Financial year starts in</label>
                  <select
                    className="input"
                    value={form.POLICY.financialYearStartMonth}
                    onChange={(e) =>
                      updateField('POLICY', 'financialYearStartMonth', Number(e.target.value))
                    }
                  >
                    {[
                      'January',
                      'February',
                      'March',
                      'April',
                      'May',
                      'June',
                      'July',
                      'August',
                      'September',
                      'October',
                      'November',
                      'December',
                    ].map((month, index) => (
                      <option key={month} value={index + 1}>
                        {month}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">Weekend policy</label>
                  <select
                    className="input"
                    value={form.POLICY.weekendPolicy.type}
                    onChange={(e) =>
                      updateNested('POLICY', 'weekendPolicy', 'type', e.target.value)
                    }
                  >
                    <option value="SAT_SUN">Saturday + Sunday off</option>
                    <option value="SUN_ONLY">Sunday only off</option>
                    <option value="CUSTOM">Custom working days</option>
                  </select>
                </div>
                {form.POLICY.weekendPolicy.type === 'CUSTOM' && (
                  <div className="md:col-span-2">
                    <label className="label">Working days</label>
                    <div className="flex flex-wrap gap-2">
                      {DAY_OPTIONS.map((day) => {
                        const selected = form.POLICY.weekendPolicy.customWorkingDays.includes(day);
                        return (
                          <button
                            key={day}
                            type="button"
                            onClick={() => {
                              const current = form.POLICY.weekendPolicy.customWorkingDays;
                              const next = selected
                                ? current.filter((d) => d !== day)
                                : [...current, day];
                              updateNested('POLICY', 'weekendPolicy', 'customWorkingDays', next);
                            }}
                            className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                              selected
                                ? 'border-crewly-green bg-crewly-green/15 text-crewly-green'
                                : 'border-crewly-border text-crewly-dim'
                            }`}
                          >
                            {day}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                <div>
                  <label className="label">Loss of pay basis</label>
                  <select
                    className="input"
                    value={form.POLICY.lopPolicy.basis}
                    onChange={(e) => updateNested('POLICY', 'lopPolicy', 'basis', e.target.value)}
                  >
                    <option value="PER_DAY">Per day</option>
                    <option value="PER_HOUR">Per hour</option>
                    <option value="PAYABLE_WORKING_DAYS">Based on payable working days</option>
                  </select>
                </div>
                <div>
                  <label className="label">Payroll processing deadline (day of month)</label>
                  <input
                    type="number"
                    min="1"
                    max="31"
                    className="input"
                    value={form.POLICY.processingDeadlineDay}
                    onChange={(e) =>
                      updateField('POLICY', 'processingDeadlineDay', Number(e.target.value))
                    }
                  />
                  <p className="mt-1 text-xs text-crewly-dim">
                    Attendance and leave inputs should be finalised by this day.
                  </p>
                </div>
              </div>

              <div className="space-y-3 rounded-lg border border-crewly-border p-4">
                <label className="flex items-center gap-3 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={form.POLICY.overtimePolicy.enabled}
                    onChange={(e) =>
                      updateNested('POLICY', 'overtimePolicy', 'enabled', e.target.checked)
                    }
                  />
                  Overtime applicable
                </label>
                {form.POLICY.overtimePolicy.enabled && (
                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <label className="label">Calculation basis</label>
                      <select
                        className="input"
                        value={form.POLICY.overtimePolicy.basis}
                        onChange={(e) =>
                          updateNested('POLICY', 'overtimePolicy', 'basis', e.target.value)
                        }
                      >
                        <option value="HOURLY">Hourly</option>
                        <option value="FIXED">Fixed</option>
                        <option value="CUSTOM">Custom rule</option>
                      </select>
                    </div>
                    <div>
                      <label className="label">Multiplier</label>
                      <input
                        type="number"
                        step="0.1"
                        min="1"
                        max="5"
                        className="input"
                        value={form.POLICY.overtimePolicy.multiplier}
                        onChange={(e) =>
                          updateNested(
                            'POLICY',
                            'overtimePolicy',
                            'multiplier',
                            Number(e.target.value),
                          )
                        }
                      />
                    </div>
                  </div>
                )}
                <label className="flex items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={form.POLICY.lockRequiresReopen}
                    onChange={(e) => updateField('POLICY', 'lockRequiresReopen', e.target.checked)}
                  />
                  Processed payroll requires an explicit reopen
                </label>
              </div>
            </>
          )}

          {/* STEP 4 — BANK */}
          {activeKey === 'BANK' && (
            <>
              <div>
                <h2 className="text-lg font-semibold">Company Bank Account</h2>
                <p className="text-sm text-crewly-dim">
                  The account salaries will be paid from. Crewly never transfers money — it
                  only stores this configuration for payment file generation later.
                </p>
              </div>
              {config?.bankAccount?.hasAccountNumber && (
                <div className="rounded-lg border border-crewly-border bg-crewly-bg p-3 text-sm">
                  <div className="font-medium">{config.bankAccount.bankName}</div>
                  <div className="text-crewly-dim">{config.bankAccount.maskedAccountNumber}</div>
                  <div className="mt-1 text-xs text-crewly-dim">
                    Leave the account number blank below to keep the stored one.
                  </div>
                </div>
              )}
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="label">Bank name</label>
                  <input
                    className="input"
                    value={form.BANK.bankName}
                    onChange={(e) => updateField('BANK', 'bankName', e.target.value)}
                  />
                </div>
                <div>
                  <label className="label">Account holder name</label>
                  <input
                    className="input"
                    value={form.BANK.accountHolderName}
                    onChange={(e) => updateField('BANK', 'accountHolderName', e.target.value)}
                  />
                </div>
                <div>
                  <label className="label">Account number</label>
                  <input
                    className="input"
                    value={form.BANK.accountNumber}
                    onChange={(e) => updateField('BANK', 'accountNumber', e.target.value)}
                    placeholder="Stored encrypted, never shown again"
                    autoComplete="off"
                  />
                  <p className="mt-1 text-xs text-crewly-dim">
                    Encrypted at rest and only ever displayed masked. Not autosaved while typing.
                  </p>
                </div>
                <div>
                  <label className="label">IFSC</label>
                  <input
                    className="input"
                    value={form.BANK.ifsc}
                    onChange={(e) => updateField('BANK', 'ifsc', e.target.value.toUpperCase())}
                    placeholder="HDFC0001234"
                  />
                </div>
                <div>
                  <label className="label">Branch</label>
                  <input
                    className="input"
                    value={form.BANK.branch}
                    onChange={(e) => updateField('BANK', 'branch', e.target.value)}
                  />
                </div>
                <div>
                  <label className="label">Account type</label>
                  <select
                    className="input"
                    value={form.BANK.accountType}
                    onChange={(e) => updateField('BANK', 'accountType', e.target.value)}
                  >
                    <option value="CURRENT">Current</option>
                    <option value="SAVINGS">Savings</option>
                    <option value="OTHER">Other</option>
                  </select>
                </div>
                <div>
                  <label className="label">Payment reference prefix</label>
                  <input
                    className="input"
                    value={form.BANK.paymentReferencePrefix}
                    onChange={(e) =>
                      updateField('BANK', 'paymentReferencePrefix', e.target.value.toUpperCase())
                    }
                    placeholder="CREWLYSAL"
                  />
                  <p className="mt-1 text-xs text-crewly-dim">
                    Payment batches use it as CREWLYSAL-2026-08.
                  </p>
                </div>
              </div>
            </>
          )}

          {/* STEP 5 — REVIEW */}
          {review && (
            <>
              <div>
                <h2 className="text-lg font-semibold">Review &amp; Activate</h2>
                <p className="text-sm text-crewly-dim">
                  Check every section before activating payroll for this company.
                </p>
              </div>

              {evaluation?.warnings?.length ? (
                <div className="space-y-2 rounded-lg border border-crewly-orange/40 bg-crewly-orange/10 p-4 text-sm text-crewly-orange">
                  {evaluation.warnings.map((warning) => (
                    <div key={warning.code} className="flex gap-2">
                      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                      <span>{warning.message}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="grid gap-4 md:grid-cols-2">
                <SectionReview title="Company Information" errors={evaluation?.errors?.LEGAL}>
                  <Row label="Legal name" value={form.LEGAL.legalName} />
                  <Row label="PAN" value={form.LEGAL.pan} />
                  <Row label="TAN" value={form.LEGAL.tan} />
                  <Row label="State" value={form.LEGAL.state} />
                  <Row label="Country" value={form.LEGAL.country} />
                </SectionReview>

                <SectionReview title="Statutory" errors={evaluation?.errors?.STATUTORY}>
                  <Row
                    label="PF"
                    value={
                      form.STATUTORY.pf.applicable
                        ? `Enabled · ${form.STATUTORY.pf.establishmentNumber || 'no number'}`
                        : 'Disabled'
                    }
                  />
                  <Row
                    label="ESI"
                    value={
                      form.STATUTORY.esi.applicable
                        ? `Enabled · ${form.STATUTORY.esi.registrationNumber || 'no number'}`
                        : 'Disabled'
                    }
                  />
                  <Row
                    label="Professional Tax"
                    value={
                      form.STATUTORY.professionalTax.applicable
                        ? `Enabled · ${form.STATUTORY.professionalTax.state || 'no state'}`
                        : 'Disabled'
                    }
                  />
                  <Row
                    label="Labour Welfare Fund"
                    value={form.STATUTORY.labourWelfareFund.applicable ? 'Enabled' : 'Disabled'}
                  />
                  <Row
                    label="Gratuity"
                    value={form.STATUTORY.gratuity.applicable ? 'Enabled' : 'Disabled'}
                  />
                  <Row label="TDS" value={form.STATUTORY.tds.applicable ? 'Enabled' : 'Disabled'} />
                </SectionReview>

                <SectionReview title="Payroll Policy" errors={evaluation?.errors?.POLICY}>
                  <Row label="Frequency" value={FREQUENCY_LABELS[form.POLICY.frequency]} />
                  <Row label="Cycle" value={`${form.POLICY.cycleStartDay} – ${form.POLICY.cycleEndDay}`} />
                  <Row
                    label="Salary date"
                    value={
                      form.POLICY.paymentDateType === 'LAST_WORKING_DAY'
                        ? 'Last working day'
                        : `Day ${form.POLICY.paymentDayOfMonth}${
                            Number(form.POLICY.paymentMonthOffset) === 1
                              ? ' of the following month'
                              : ''
                          }`
                    }
                  />
                  <Row label="Currency" value={form.POLICY.currency} />
                  <Row
                    label="Financial year"
                    value={`Starts ${new Date(2000, form.POLICY.financialYearStartMonth - 1, 1).toLocaleString(
                      'en-IN',
                      { month: 'long' },
                    )}`}
                  />
                  <Row label="Weekend" value={form.POLICY.weekendPolicy.type.replace('_', ' + ')} />
                  <Row label="Loss of pay" value={form.POLICY.lopPolicy.basis.replace(/_/g, ' ')} />
                  <Row
                    label="Overtime"
                    value={form.POLICY.overtimePolicy.enabled ? 'Enabled' : 'Disabled'}
                  />
                </SectionReview>

                <SectionReview title="Bank" errors={evaluation?.errors?.BANK}>
                  <Row label="Bank" value={form.BANK.bankName} />
                  <Row
                    label="Account"
                    value={
                      config?.bankAccount?.maskedAccountNumber ||
                      (form.BANK.accountNumber ? 'Will be saved encrypted' : 'Not set')
                    }
                  />
                  <Row label="IFSC" value={form.BANK.ifsc} />
                  <Row label="Reference prefix" value={form.BANK.paymentReferencePrefix} />
                </SectionReview>
              </div>

              {!canActivateNow && canActivate && (
                <p className="text-sm text-crewly-orange">
                  Complete every section to activate payroll.
                </p>
              )}
            </>
          )}

          {/* Wizard actions */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-crewly-border pt-4">
            <button
              className="btn-ghost"
              onClick={() => (step === 1 ? setMode('dashboard') : setStep(step - 1))}
            >
              {step === 1 ? 'Back to overview' : 'Back'}
            </button>

            <div className="flex flex-wrap items-center gap-2">
              {!review && (
                <>
                  <button
                    className="btn-ghost"
                    onClick={() => saveCurrentStep()}
                    disabled={saving || !canEdit}
                  >
                    {saving ? 'Saving…' : 'Save draft'}
                  </button>
                  <button
                    className="btn-primary"
                    onClick={() => saveCurrentStep({ advance: true })}
                    disabled={saving || !canEdit}
                  >
                    Save &amp; Continue
                  </button>
                </>
              )}
              {review && (
                <>
                  {config?.status === 'ACTIVE' && (
                    <button className="btn-ghost" onClick={() => setMode('dashboard')}>
                      Done
                    </button>
                  )}
                  <button
                    className="btn-primary"
                    onClick={() => setConfirmActivate(true)}
                    disabled={!canActivateNow || saving}
                    title={canActivate ? '' : 'Activation requires payroll setup permission'}
                  >
                    Activate Payroll
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {confirmActivate && (
        <Modal title="Activate payroll" onClose={() => setConfirmActivate(false)}>
          <div className="space-y-4 text-sm">
            <p>
              Payroll setup will become active. Payroll processing will use these company
              settings.
            </p>
            <div className="flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setConfirmActivate(false)}>
                Cancel
              </button>
              <button className="btn-primary" onClick={activate} disabled={saving}>
                {saving ? 'Activating…' : 'Activate Payroll'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

const SectionReview = ({ title, errors = [], children }) => (
  <div className="rounded-lg border border-crewly-border p-4 text-sm">
    <div className="mb-2 flex items-center justify-between">
      <span className="font-medium">{title}</span>
      {errors.length ? (
        <span className="badge bg-crewly-red/15 text-crewly-red">Incomplete</span>
      ) : (
        <span className="badge bg-crewly-green/15 text-crewly-green">Complete</span>
      )}
    </div>
    <div className="space-y-1">{children}</div>
    {errors.length ? (
      <div className="mt-2 space-y-1 text-xs text-crewly-red">
        {errors.map((err) => (
          <div key={err.field}>{err.message}</div>
        ))}
      </div>
    ) : null}
  </div>
);

const Row = ({ label, value }) => (
  <div className="flex justify-between gap-3">
    <span className="text-crewly-dim">{label}</span>
    <span className="text-right">{value || '—'}</span>
  </div>
);

export default PayrollSetupPage;
