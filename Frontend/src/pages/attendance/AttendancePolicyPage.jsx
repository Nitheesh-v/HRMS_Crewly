import { useCallback, useEffect, useState } from 'react';
import {
  AlarmClock,
  BellOff,
  Briefcase,
  Coffee,
  Hourglass,
  MapPin,
  MoonStar,
  Save,
  ShieldCheck,
} from 'lucide-react';
import usePermission from '../../hooks/usePermission.js';
import attendancePolicyService from '../../services/attendancePolicyService.js';

const DEFAULT_FORM = {
  name: 'Attendance Policy',
  description: '',
  timezone: 'Asia/Kolkata',
  thresholds: { fullDayMinutes: 480, halfDayMinutes: 240 },
  grace: { lateInMinutes: 15, earlyOutMinutes: 15 },
  breaks: { enabled: true, includeInWorkedTime: false, dailyLimitMinutes: '' },
  missingPunch: { keepUnresolved: true, allowRegularization: true, regularizationWindowDays: 7 },
  overtime: {
    trackingEnabled: false,
    minimumExtraMinutes: 30,
    approvalRequired: true,
    weekendEligible: false,
    holidayEligible: false,
  },
  weekendHoliday: { allowWorkOnWeeklyOff: true, allowWorkOnHoliday: true },
  workModes: { office: true, wfh: false, field: false, clientSite: false, businessTravel: false },
  locationEnforcement: 'DISABLED',
};

const toForm = (policy) => {
  if (!policy) return structuredClone(DEFAULT_FORM);

  return {
    name: policy.name || 'Attendance Policy',
    description: policy.description || '',
    timezone: policy.timezone || 'Asia/Kolkata',
    thresholds: {
      fullDayMinutes: policy.thresholds?.fullDayMinutes ?? 480,
      halfDayMinutes: policy.thresholds?.halfDayMinutes ?? 240,
    },
    grace: {
      lateInMinutes: policy.grace?.lateInMinutes ?? 15,
      earlyOutMinutes: policy.grace?.earlyOutMinutes ?? 15,
    },
    breaks: {
      enabled: policy.breaks?.enabled ?? true,
      includeInWorkedTime: policy.breaks?.includeInWorkedTime ?? false,
      dailyLimitMinutes: policy.breaks?.dailyLimitMinutes ?? '',
    },
    missingPunch: {
      keepUnresolved: policy.missingPunch?.keepUnresolved ?? true,
      allowRegularization: policy.missingPunch?.allowRegularization ?? true,
      regularizationWindowDays: policy.missingPunch?.regularizationWindowDays ?? 7,
    },
    overtime: {
      trackingEnabled: policy.overtime?.trackingEnabled ?? false,
      minimumExtraMinutes: policy.overtime?.minimumExtraMinutes ?? 30,
      approvalRequired: policy.overtime?.approvalRequired ?? true,
      weekendEligible: policy.overtime?.weekendEligible ?? false,
      holidayEligible: policy.overtime?.holidayEligible ?? false,
    },
    weekendHoliday: {
      allowWorkOnWeeklyOff: policy.weekendHoliday?.allowWorkOnWeeklyOff ?? true,
      allowWorkOnHoliday: policy.weekendHoliday?.allowWorkOnHoliday ?? true,
    },
    workModes: {
      office: policy.workModes?.office ?? true,
      wfh: policy.workModes?.wfh ?? false,
      field: policy.workModes?.field ?? false,
      clientSite: policy.workModes?.clientSite ?? false,
      businessTravel: policy.workModes?.businessTravel ?? false,
    },
    locationEnforcement: policy.locationEnforcement || 'DISABLED',
  };
};

const toPayload = (form, expectedConfigVersion) => ({
  expectedConfigVersion,
  name: form.name.trim(),
  description: form.description.trim(),
  timezone: form.timezone.trim(),
  thresholds: {
    fullDayMinutes: Number(form.thresholds.fullDayMinutes),
    halfDayMinutes: Number(form.thresholds.halfDayMinutes),
  },
  grace: {
    lateInMinutes: Number(form.grace.lateInMinutes),
    earlyOutMinutes: Number(form.grace.earlyOutMinutes),
  },
  breaks: {
    enabled: Boolean(form.breaks.enabled),
    includeInWorkedTime: Boolean(form.breaks.includeInWorkedTime),
    dailyLimitMinutes:
      form.breaks.dailyLimitMinutes === '' || form.breaks.dailyLimitMinutes === null
        ? null
        : Number(form.breaks.dailyLimitMinutes),
  },
  missingPunch: {
    keepUnresolved: Boolean(form.missingPunch.keepUnresolved),
    allowRegularization: Boolean(form.missingPunch.allowRegularization),
    regularizationWindowDays: Number(form.missingPunch.regularizationWindowDays),
  },
  overtime: {
    trackingEnabled: Boolean(form.overtime.trackingEnabled),
    minimumExtraMinutes: Number(form.overtime.minimumExtraMinutes),
    approvalRequired: Boolean(form.overtime.approvalRequired),
    weekendEligible: Boolean(form.overtime.weekendEligible),
    holidayEligible: Boolean(form.overtime.holidayEligible),
  },
  weekendHoliday: {
    allowWorkOnWeeklyOff: Boolean(form.weekendHoliday.allowWorkOnWeeklyOff),
    allowWorkOnHoliday: Boolean(form.weekendHoliday.allowWorkOnHoliday),
  },
  workModes: {
    office: Boolean(form.workModes.office),
    wfh: Boolean(form.workModes.wfh),
    field: Boolean(form.workModes.field),
    clientSite: Boolean(form.workModes.clientSite),
    businessTravel: Boolean(form.workModes.businessTravel),
  },
  locationEnforcement: form.locationEnforcement,
});

const formatMinutes = (value) => {
  const total = Math.max(0, Math.trunc(Number(value) || 0));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
};

const NumberField = ({ label, value, onChange, hint, disabled, min = 0, max = 1440 }) => (
  <div>
    <label className="label">{label}</label>
    <input
      type="number"
      className="input w-full"
      value={value}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
    {hint && <p className="mt-1 text-xs text-crewly-dim">{hint}</p>}
  </div>
);

const Toggle = ({ label, checked, onChange, disabled, hint }) => (
  <label className="flex cursor-pointer items-start gap-3">
    <input
      type="checkbox"
      className="mt-1 h-4 w-4 accent-emerald-500"
      checked={Boolean(checked)}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
    <span>
      <span className="text-sm font-medium">{label}</span>
      {hint && <span className="block text-xs text-crewly-dim">{hint}</span>}
    </span>
  </label>
);

const Section = ({ icon: Icon, title, children }) => (
  <section className="card space-y-4 p-5">
    <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-crewly-dim">
      <Icon size={16} />
      {title}
    </h2>
    {children}
  </section>
);

const AttendancePolicyPage = () => {
  const { hasPermission, loading: permissionsLoading } = usePermission();

  const canRead = hasPermission('ATTENDANCE_POLICY_READ');
  const canManage =
    hasPermission('ATTENDANCE_POLICY_MANAGE') || hasPermission('ATTENDANCE_POLICY_ACTIVATE');
  const canActivate = hasPermission('ATTENDANCE_POLICY_ACTIVATE');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activating, setActivating] = useState(false);
  const [policy, setPolicy] = useState(null);
  const [history, setHistory] = useState([]);
  const [form, setForm] = useState(() => structuredClone(DEFAULT_FORM));
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const [current, past] = await Promise.all([
        attendancePolicyService.get(),
        attendancePolicyService.history({ limit: 10 }).catch(() => ({ data: [] })),
      ]);

      setPolicy(current?.data || null);
      setForm(toForm(current?.data));
      setHistory(Array.isArray(past?.data) ? past.data : []);
    } catch (loadError) {
      setError(loadError?.message || 'Could not load the attendance policy');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!permissionsLoading && canRead) {
      load();
    }

    if (!permissionsLoading && !canRead) {
      setLoading(false);
    }
  }, [permissionsLoading, canRead, load]);

  const setSection = (section, field, value) =>
    setForm((previous) => ({
      ...previous,
      [section]: { ...previous[section], [field]: value },
    }));

  const save = async () => {
    setSaving(true);
    setMessage('');
    setError('');

    try {
      const result = await attendancePolicyService.saveDraft(
        toPayload(form, policy?.configVersion ?? null),
      );

      setPolicy(result?.data || null);
      setForm(toForm(result?.data));
      setMessage(result?.message || 'Draft saved');
      const past = await attendancePolicyService.history({ limit: 10 }).catch(() => null);
      if (past) setHistory(Array.isArray(past.data) ? past.data : []);
    } catch (saveError) {
      setError(saveError?.message || 'Could not save the draft');
    } finally {
      setSaving(false);
    }
  };

  const activate = async () => {
    if (
      !window.confirm(
        'Activate this attendance policy? It becomes the company rule for future evaluation. History is preserved.',
      )
    ) {
      return;
    }

    setActivating(true);
    setMessage('');
    setError('');

    try {
      const result = await attendancePolicyService.activate(policy?.configVersion ?? null);

      setPolicy(result?.data || null);
      setForm(toForm(result?.data));
      setMessage(result?.message || 'Policy activated');
      const past = await attendancePolicyService.history({ limit: 10 }).catch(() => null);
      if (past) setHistory(Array.isArray(past.data) ? past.data : []);
    } catch (activationError) {
      setError(activationError?.message || 'Could not activate the policy');
    } finally {
      setActivating(false);
    }
  };

  if (permissionsLoading || loading) {
    return <p className="text-crewly-dim">Loading attendance policy…</p>;
  }

  if (!canRead) {
    return (
      <div className="card p-6">
        <h1 className="text-xl font-bold">Attendance Policy</h1>
        <p className="mt-2 text-crewly-dim">
          You do not have permission to view the company attendance policy.
        </p>
      </div>
    );
  }

  const readOnly = !canManage;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-crewly-dim">Time &amp; Leave</p>
          <h1 className="text-2xl font-black">Attendance Policy</h1>
          <p className="text-sm text-crewly-dim">
            Company rules for how attendance is evaluated. Punch In / Punch Out keeps
            working as today.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {policy && (
            <span className="badge">
              {policy.status}
              {policy.version > 0 ? ` · v${policy.version}` : ''}
            </span>
          )}
          {!policy && <span className="badge">Not configured</span>}
        </div>
      </div>

      {message && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-emerald-200">
          {message}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-red-200">
          {error}
        </div>
      )}

      <Section icon={Briefcase} title="General">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="label">Policy name</label>
            <input
              className="input w-full"
              value={form.name}
              disabled={readOnly}
              maxLength={80}
              onChange={(event) => setForm((previous) => ({ ...previous, name: event.target.value }))}
            />
          </div>
          <div>
            <label className="label">Timezone (IANA)</label>
            <input
              className="input w-full"
              value={form.timezone}
              disabled={readOnly}
              placeholder="Asia/Kolkata"
              onChange={(event) =>
                setForm((previous) => ({ ...previous, timezone: event.target.value }))
              }
            />
            <p className="mt-1 text-xs text-crewly-dim">
              Business-day boundaries are evaluated in this zone.
            </p>
          </div>
        </div>
        <div>
          <label className="label">Description</label>
          <textarea
            className="input w-full"
            rows={2}
            value={form.description}
            disabled={readOnly}
            maxLength={500}
            onChange={(event) =>
              setForm((previous) => ({ ...previous, description: event.target.value }))
            }
          />
        </div>
      </Section>

      <Section icon={Hourglass} title="Working hours">
        <div className="grid gap-4 md:grid-cols-2">
          <NumberField
            label="Full-day minimum (minutes)"
            value={form.thresholds.fullDayMinutes}
            disabled={readOnly}
            hint={`Worked ${formatMinutes(form.thresholds.fullDayMinutes)} or more counts as a full day.`}
            onChange={(value) => setSection('thresholds', 'fullDayMinutes', value)}
          />
          <NumberField
            label="Half-day minimum (minutes)"
            value={form.thresholds.halfDayMinutes}
            disabled={readOnly}
            hint={`At least ${formatMinutes(form.thresholds.halfDayMinutes)} counts as a half day. Must stay below the full-day minimum.`}
            onChange={(value) => setSection('thresholds', 'halfDayMinutes', value)}
          />
        </div>
      </Section>

      <Section icon={AlarmClock} title="Grace period">
        <div className="grid gap-4 md:grid-cols-2">
          <NumberField
            label="Late arrival grace (minutes)"
            value={form.grace.lateInMinutes}
            disabled={readOnly}
            max={120}
            onChange={(value) => setSection('grace', 'lateInMinutes', value)}
          />
          <NumberField
            label="Early departure grace (minutes)"
            value={form.grace.earlyOutMinutes}
            disabled={readOnly}
            max={120}
            onChange={(value) => setSection('grace', 'earlyOutMinutes', value)}
          />
        </div>
      </Section>

      <Section icon={Coffee} title="Break rules">
        <div className="space-y-3">
          <Toggle
            label="Breaks enabled"
            checked={form.breaks.enabled}
            disabled={readOnly}
            hint="Break punching arrives in a later phase; this only configures the rule."
            onChange={(value) => setSection('breaks', 'enabled', value)}
          />
          <Toggle
            label="Break time counts as worked time"
            checked={form.breaks.includeInWorkedTime}
            disabled={readOnly || !form.breaks.enabled}
            onChange={(value) => setSection('breaks', 'includeInWorkedTime', value)}
          />
          <div className="max-w-xs">
            <NumberField
              label="Daily counted-break cap (minutes, empty = uncapped)"
              value={form.breaks.dailyLimitMinutes}
              disabled={readOnly || !form.breaks.enabled || !form.breaks.includeInWorkedTime}
              onChange={(value) => setSection('breaks', 'dailyLimitMinutes', value)}
            />
          </div>
        </div>
      </Section>

      <Section icon={BellOff} title="Missing punch">
        <p className="text-sm text-crewly-dim">
          Incomplete days stay visible as exceptions — the system never invents a
          punch or a silent checkout.
        </p>
        <div className="space-y-3">
          <Toggle
            label="Keep incomplete days unresolved until reviewed"
            checked={form.missingPunch.keepUnresolved}
            disabled={readOnly}
            onChange={(value) => setSection('missingPunch', 'keepUnresolved', value)}
          />
          <Toggle
            label="Allow regularization requests (later phase)"
            checked={form.missingPunch.allowRegularization}
            disabled={readOnly}
            onChange={(value) => setSection('missingPunch', 'allowRegularization', value)}
          />
          <div className="max-w-xs">
            <NumberField
              label="Regularization window (days)"
              value={form.missingPunch.regularizationWindowDays}
              disabled={readOnly}
              max={31}
              onChange={(value) => setSection('missingPunch', 'regularizationWindowDays', value)}
            />
          </div>
        </div>
      </Section>

      <Section icon={MoonStar} title="Overtime (time only, never money)">
        <div className="space-y-3">
          <Toggle
            label="Track overtime minutes"
            checked={form.overtime.trackingEnabled}
            disabled={readOnly}
            hint="Eligibility in minutes. Salary math stays in Payroll."
            onChange={(value) => setSection('overtime', 'trackingEnabled', value)}
          />
          <div className="max-w-xs">
            <NumberField
              label="Minimum extra minutes before OT is eligible"
              value={form.overtime.minimumExtraMinutes}
              disabled={readOnly || !form.overtime.trackingEnabled}
              onChange={(value) => setSection('overtime', 'minimumExtraMinutes', value)}
            />
          </div>
          <Toggle
            label="OT requires approval"
            checked={form.overtime.approvalRequired}
            disabled={readOnly || !form.overtime.trackingEnabled}
            onChange={(value) => setSection('overtime', 'approvalRequired', value)}
          />
          <Toggle
            label="Weekend work is OT-eligible"
            checked={form.overtime.weekendEligible}
            disabled={readOnly || !form.overtime.trackingEnabled}
            onChange={(value) => setSection('overtime', 'weekendEligible', value)}
          />
          <Toggle
            label="Holiday work is OT-eligible"
            checked={form.overtime.holidayEligible}
            disabled={readOnly || !form.overtime.trackingEnabled}
            onChange={(value) => setSection('overtime', 'holidayEligible', value)}
          />
        </div>
      </Section>

      <Section icon={Briefcase} title="Weekend & holiday work">
        <div className="space-y-3">
          <Toggle
            label="Accept punches on weekly offs"
            checked={form.weekendHoliday.allowWorkOnWeeklyOff}
            disabled={readOnly}
            hint="Which days are offs/holidays is still decided by Work Schedule and Holidays."
            onChange={(value) => setSection('weekendHoliday', 'allowWorkOnWeeklyOff', value)}
          />
          <Toggle
            label="Accept punches on holidays"
            checked={form.weekendHoliday.allowWorkOnHoliday}
            disabled={readOnly}
            onChange={(value) => setSection('weekendHoliday', 'allowWorkOnHoliday', value)}
          />
        </div>
      </Section>

      <Section icon={MapPin} title="Work modes & location">
        <div className="grid gap-3 md:grid-cols-2">
          <Toggle
            label="Office"
            checked={form.workModes.office}
            disabled
            hint="Office stays available."
            onChange={() => {}}
          />
          <Toggle
            label="Work from home"
            checked={form.workModes.wfh}
            disabled={readOnly}
            hint="Approval workflows arrive in a later phase."
            onChange={(value) => setSection('workModes', 'wfh', value)}
          />
          <Toggle
            label="Field"
            checked={form.workModes.field}
            disabled={readOnly}
            onChange={(value) => setSection('workModes', 'field', value)}
          />
          <Toggle
            label="Client site"
            checked={form.workModes.clientSite}
            disabled={readOnly}
            onChange={(value) => setSection('workModes', 'clientSite', value)}
          />
          <Toggle
            label="Business travel"
            checked={form.workModes.businessTravel}
            disabled={readOnly}
            onChange={(value) => setSection('workModes', 'businessTravel', value)}
          />
        </div>
        <div className="max-w-xs">
          <label className="label">Location enforcement (future)</label>
          <select
            className="input w-full"
            value={form.locationEnforcement}
            disabled={readOnly}
            onChange={(event) =>
              setForm((previous) => ({ ...previous, locationEnforcement: event.target.value }))
            }
          >
            <option value="DISABLED">Disabled</option>
            <option value="OPTIONAL">Optional</option>
            <option value="REQUIRED">Required</option>
          </select>
          <p className="mt-1 text-xs text-crewly-dim">
            Geofence configuration arrives later. This page never requests device
            location.
          </p>
        </div>
      </Section>

      <Section icon={ShieldCheck} title="Policy state">
        <div className="flex flex-wrap items-center gap-3">
          <span className="badge">{policy?.status || 'NOT CONFIGURED'}</span>
          {policy?.version > 0 && <span className="badge">v{policy.version}</span>}
          {policy?.activatedAt && (
            <span className="text-xs text-crewly-dim">
              Active since {new Date(policy.activatedAt).toLocaleString('en-IN')}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className="btn-primary flex items-center gap-2 px-4 py-2"
            disabled={readOnly || saving}
            onClick={save}
          >
            <Save size={16} />
            {saving ? 'Saving…' : 'Save draft'}
          </button>
          <button
            type="button"
            className="btn-ghost px-4 py-2"
            disabled={!canActivate || activating || policy?.status === 'ACTIVE'}
            onClick={activate}
          >
            {activating ? 'Activating…' : 'Activate policy'}
          </button>
        </div>
        {history.length > 0 && (
          <div>
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-crewly-dim">
              Version history
            </h3>
            <div className="space-y-2">
              {history.map((row) => (
                <div
                  key={row.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-crewly-border px-3 py-2 text-sm"
                >
                  <span>
                    {row.name} · v{row.version} · {row.status}
                  </span>
                  <span className="text-xs text-crewly-dim">
                    {row.updatedAt ? new Date(row.updatedAt).toLocaleString('en-IN') : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Section>
    </div>
  );
};

export default AttendancePolicyPage;
