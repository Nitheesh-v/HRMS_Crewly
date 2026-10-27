import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  BellRing,
  Building2,
  CalendarClock,
  CheckCircle2,
  Clock,
  Coffee,
  Crosshair,
  Gauge,
  History,
  Hourglass,
  Info,
  MapPin,
  Pencil,
  Plus,
  Power,
  Save,
  Scale,
  ShieldCheck,
  Sparkles,
  Timer,
  Users,
  Wifi,
  Target,
} from 'lucide-react';
import usePermission from '../../hooks/usePermission.js';
import attendancePolicyService from '../../services/attendancePolicyService.js';
import attendanceLocationService from '../../services/attendanceLocationService.js';
import { notify } from '../../utils/notify.js';
import EmptyState from '../../components/common/EmptyState.jsx';

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
    normalDayBenefit: 'OVERTIME',
    weeklyOffBenefit: 'NONE',
    holidayBenefit: 'NONE',
    compOffMinutesPerDay: 480,
  },
  // Weekly-hours flexi target — OFF by default; the form keeps the goal in
  // whole hours for readability and the payload converts to minutes.
  weeklyTarget: {
    enabled: false,
    targetHours: 40,
    restDayMode: 'AUTO_MARK',
    includeApprovedOvertime: false,
  },
  weekendHoliday: { allowWorkOnWeeklyOff: true, allowWorkOnHoliday: true },
  workModes: { office: true, wfh: false, field: false, clientSite: false, businessTravel: false },
  workModeApproval: { wfh: true, field: true, clientSite: true, businessTravel: true },
  // 31.13 — all reminder types OFF by default (HR opts in per type).
  notifications: {
    shiftStart: { enabled: false, minutesBefore: 30 },
    missingClockIn: { enabled: false, minutesAfter: 30 },
    missingClockOut: { enabled: false, minutesAfter: 30 },
    incompleteBreak: { enabled: false, minutesAfter: 45 },
  },
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
      normalDayBenefit: policy.overtime?.normalDayBenefit ?? 'OVERTIME',
      weeklyOffBenefit: policy.overtime?.weeklyOffBenefit ?? 'NONE',
      holidayBenefit: policy.overtime?.holidayBenefit ?? 'NONE',
      compOffMinutesPerDay: policy.overtime?.compOffMinutesPerDay ?? 480,
    },
    weeklyTarget: {
      enabled: policy.weeklyTarget?.enabled ?? false,
      targetHours: policy.weeklyTarget?.targetMinutes != null
        ? Math.round((Number(policy.weeklyTarget.targetMinutes) / 60) * 100) / 100
        : 40,
      restDayMode: policy.weeklyTarget?.restDayMode ?? 'AUTO_MARK',
      includeApprovedOvertime: policy.weeklyTarget?.includeApprovedOvertime ?? false,
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
    workModeApproval: {
      wfh: policy.workModeApproval?.wfh ?? true,
      field: policy.workModeApproval?.field ?? true,
      clientSite: policy.workModeApproval?.clientSite ?? true,
      businessTravel: policy.workModeApproval?.businessTravel ?? true,
    },
    notifications: {
      shiftStart: {
        enabled: policy.notifications?.shiftStart?.enabled ?? false,
        minutesBefore: policy.notifications?.shiftStart?.minutesBefore ?? 30,
      },
      missingClockIn: {
        enabled: policy.notifications?.missingClockIn?.enabled ?? false,
        minutesAfter: policy.notifications?.missingClockIn?.minutesAfter ?? 30,
      },
      missingClockOut: {
        enabled: policy.notifications?.missingClockOut?.enabled ?? false,
        minutesAfter: policy.notifications?.missingClockOut?.minutesAfter ?? 30,
      },
      incompleteBreak: {
        enabled: policy.notifications?.incompleteBreak?.enabled ?? false,
        minutesAfter: policy.notifications?.incompleteBreak?.minutesAfter ?? 45,
      },
    },
    locationEnforcement: policy.locationEnforcement || 'DISABLED',
  };
};

const toPayload = (form, expectedConfigVersion) => ({
  // Omit the token on first save — the API treats a missing token as "no check".
  ...(expectedConfigVersion == null ? {} : { expectedConfigVersion }),
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
    normalDayBenefit: form.overtime.normalDayBenefit || 'OVERTIME',
    weeklyOffBenefit: form.overtime.weeklyOffBenefit || 'NONE',
    holidayBenefit: form.overtime.holidayBenefit || 'NONE',
    compOffMinutesPerDay: Number(form.overtime.compOffMinutesPerDay) || 480,
  },
  weeklyTarget: {
    enabled: Boolean(form.weeklyTarget.enabled),
    targetMinutes: Math.round(Number(form.weeklyTarget.targetHours || 0) * 60) || 2400,
    restDayMode: form.weeklyTarget.restDayMode || 'AUTO_MARK',
    includeApprovedOvertime: Boolean(form.weeklyTarget.includeApprovedOvertime),
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
  workModeApproval: {
    wfh: Boolean(form.workModeApproval.wfh),
    field: Boolean(form.workModeApproval.field),
    clientSite: Boolean(form.workModeApproval.clientSite),
    businessTravel: Boolean(form.workModeApproval.businessTravel),
  },
  notifications: {
    shiftStart: {
      enabled: Boolean(form.notifications.shiftStart.enabled),
      minutesBefore: Number(form.notifications.shiftStart.minutesBefore),
    },
    missingClockIn: {
      enabled: Boolean(form.notifications.missingClockIn.enabled),
      minutesAfter: Number(form.notifications.missingClockIn.minutesAfter),
    },
    missingClockOut: {
      enabled: Boolean(form.notifications.missingClockOut.enabled),
      minutesAfter: Number(form.notifications.missingClockOut.minutesAfter),
    },
    incompleteBreak: {
      enabled: Boolean(form.notifications.incompleteBreak.enabled),
      minutesAfter: Number(form.notifications.incompleteBreak.minutesAfter),
    },
  },
  locationEnforcement: form.locationEnforcement,
});

const formatMinutes = (value) => {
  const total = Math.max(0, Math.trunc(Number(value) || 0));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
};

const Toggle = ({ label, checked, onChange, disabled, hint }) => (
  <label className="flex cursor-pointer items-start gap-2.5">
    <input
      type="checkbox"
      className="mt-0.5 h-4 w-4 accent-st-secondary"
      checked={Boolean(checked)}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
    <span>
      <span className="block text-xs font-semibold text-st-on">{label}</span>
      {hint && <span className="block text-[11px] leading-snug text-st-on-variant">{hint}</span>}
    </span>
  </label>
);

const AttendancePolicyPage = () => {
  const { hasPermission, loading: permissionsLoading } = usePermission();

  const canRead = hasPermission('ATTENDANCE_POLICY_READ');
  const canManage =
    hasPermission('ATTENDANCE_POLICY_MANAGE') || hasPermission('ATTENDANCE_POLICY_ACTIVATE');
  const canActivate = hasPermission('ATTENDANCE_POLICY_ACTIVATE');
  const canReadLocations = hasPermission('ATTENDANCE_LOCATION_READ');
  const canManageLocations = hasPermission('ATTENDANCE_LOCATION_MANAGE');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activating, setActivating] = useState(false);
  const [policy, setPolicy] = useState(null);
  const [history, setHistory] = useState([]);
  const [form, setForm] = useState(() => structuredClone(DEFAULT_FORM));
  const [message, setMessage] = useState('');

  // Phase 31.3 — office locations share this page (no extra route).
  const [locations, setLocations] = useState([]);
  const [locForm, setLocForm] = useState({
    id: null,
    name: '',
    code: '',
    displayAddress: '',
    latitude: '',
    longitude: '',
    radiusMeters: 200,
    isActive: true,
  });
  const [locBusy, setLocBusy] = useState(false);
  const [locError, setLocError] = useState('');
  // Phase 31 — geofence UX: Use Current Location (one-shot only, never watchPosition)
  const [locGeo, setLocGeo] = useState({ status: 'idle', message: '', accuracy: null });

  const handleUseCurrentLocation = useCallback(() => {
    setLocError('');
    // Insecure context (HTTP) blocks geolocation on most browsers except localhost
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      const host = window.location.hostname || '';
      const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
      if (!isLocalhost) {
        setLocGeo({ status: 'error', message: 'Location requires HTTPS or localhost. Please use HTTPS or enter the office coordinates manually under Advanced.', accuracy: null });
        return;
      }
    }
    if (!navigator.geolocation || typeof navigator.geolocation.getCurrentPosition !== 'function') {
      setLocGeo({ status: 'error', message: 'Location is not available in this browser. Please enter the office coordinates manually under Advanced.', accuracy: null });
      return;
    }
    setLocGeo({ status: 'loading', message: 'Getting your location…', accuracy: null });
    // One-shot only — never watchPosition, never on page load, only on explicit click
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords || {};
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          setLocGeo({ status: 'error', message: 'Could not determine your location — please retry or enter coordinates manually.', accuracy: null });
          return;
        }
        if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
          setLocGeo({ status: 'error', message: 'Location returned invalid coordinates — please retry or enter manually.', accuracy: null });
          return;
        }
        setLocForm((prev) => ({ ...prev, latitude: String(latitude), longitude: String(longitude) }));
        setLocGeo({
          status: 'success',
          message: 'Location captured',
          accuracy: Number.isFinite(accuracy) ? accuracy : null,
        });
      },
      (err) => {
        const code = err?.code;
        let msg = 'Could not determine your location — please retry or enter the office coordinates manually.';
        if (code === 1) msg = 'Location permission was denied. Allow location access in your browser or enter the office coordinates manually.';
        else if (code === 2) msg = 'Location is unavailable. Your device could not determine its location — enter the office coordinates manually.';
        else if (code === 3) msg = 'Location request timed out — please retry or enter the office coordinates manually.';
        else if (err?.message && /secure/i.test(err.message)) msg = 'Location requires HTTPS or localhost. Please use HTTPS or enter the office coordinates manually.';
        setLocGeo({ status: 'error', message: msg, accuracy: null });
      },
      { timeout: 10000, maximumAge: 0 }
    );
  }, []);

  const loadLocations = useCallback(async () => {
    if (!canReadLocations && !canManageLocations) return;
    try {
      const result = await attendanceLocationService.list();
      const rows = result?.data;
      setLocations(Array.isArray(rows) ? rows : []);
    } catch (loadError) {
      setLocError(loadError?.message || 'Could not load the office locations');
    }
  }, [canReadLocations, canManageLocations]);

  useEffect(() => {
    if (!permissionsLoading) loadLocations();
  }, [permissionsLoading, loadLocations]);

  const load = useCallback(async () => {
    setLoading(true);
    /* 35.1 — nothing to report (failure state cleared) */

    try {
      const [current, past] = await Promise.all([
        attendancePolicyService.get(),
        attendancePolicyService.history({ limit: 10 }).catch(() => ({ data: [] })),
      ]);

      setPolicy(current?.data || null);
      setForm(toForm(current?.data));
      setHistory(Array.isArray(past?.data) ? past.data : []);
    } catch (loadError) {
      notify.error(loadError?.message || 'Could not load the attendance policy');
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

  // 31.13 — notifications are nested one level deeper than setSection handles.
  const setNotification = (section, field, value) =>
    setForm((previous) => ({
      ...previous,
      notifications: {
        ...previous.notifications,
        [section]: { ...previous.notifications[section], [field]: value },
      },
    }));

  const save = async () => {
    setSaving(true);
    setMessage('');
    /* 35.1 — nothing to report (failure state cleared) */

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
      notify.error(saveError?.message || 'Could not save the draft');
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
    /* 35.1 — nothing to report (failure state cleared) */

    try {
      const result = await attendancePolicyService.activate(policy?.configVersion ?? null);

      setPolicy(result?.data || null);
      setForm(toForm(result?.data));
      setMessage(result?.message || 'Policy activated');
      const past = await attendancePolicyService.history({ limit: 10 }).catch(() => null);
      if (past) setHistory(Array.isArray(past.data) ? past.data : []);
    } catch (activationError) {
      notify.error(activationError?.message || 'Could not activate the policy');
    } finally {
      setActivating(false);
    }
  };

  const resetLocForm = () => {
    setLocForm({
      id: null,
      name: '',
      code: '',
      displayAddress: '',
      latitude: '',
      longitude: '',
      radiusMeters: 200,
      isActive: true,
    });
    setLocGeo({ status: 'idle', message: '', accuracy: null });
  };

  const saveLocation = async () => {
    setLocBusy(true);
    setLocError('');
    setMessage('');

    try {
      const payload = {
        name: locForm.name.trim(),
        code: locForm.code.trim() || null,
        displayAddress: locForm.displayAddress.trim() || null,
        latitude: Number(locForm.latitude),
        longitude: Number(locForm.longitude),
        radiusMeters: Number(locForm.radiusMeters),
        isActive: locForm.isActive,
      };
      if (locForm.id) {
        await attendanceLocationService.update(locForm.id, payload);
      } else {
        await attendanceLocationService.create(payload);
      }
      setMessage(locForm.id ? 'Location updated' : 'Location created');
      resetLocForm();
      await loadLocations();
    } catch (saveError) {
      setLocError(saveError?.message || 'Could not save the location');
    } finally {
      setLocBusy(false);
    }
  };

  const toggleLocationActive = async (row) => {
    setLocBusy(true);
    setLocError('');

    try {
      if (row.isActive) {
        await attendanceLocationService.deactivate(row.id);
      } else {
        await attendanceLocationService.activate(row.id);
      }
      await loadLocations();
    } catch (toggleError) {
      setLocError(toggleError?.message || 'Could not update the location');
    } finally {
      setLocBusy(false);
    }
  };


  // The rule groups the mock tabs across. Each one is a real group of fields on
  // the policy document — the tab scrolls to it and the rail reports which are
  // configured, rather than inventing a completeness figure.
  const GROUPS = [
    { id: 'core', label: 'Core hours & grace', Icon: Clock },
    { id: 'breaks', label: 'Break & meals', Icon: Coffee },
    { id: 'missing', label: 'Missing punch & regularization', Icon: CalendarClock },
    { id: 'overtime', label: 'Overtime & comp-off', Icon: Timer },
    { id: 'geofence', label: 'Geofence & locations', Icon: Crosshair },
    { id: 'audit', label: 'Audit & notifications', Icon: Bell },
  ];

  const fmtDateTime = (value) => {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString([], {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const activeLocations = locations.filter((row) => row.isActive);
  const policyStatus = policy?.status || 'DRAFT';
  const isLive = policyStatus === 'ACTIVE';
  const publishedAt = fmtDateTime(policy?.activatedAt || (isLive ? policy?.updatedAt : null));

  /* How much of the rule set has been decided, out of the toggles and numbers
     this policy actually owns. A ratio over real fields — not a score someone
     made up. */
  const checks = [
    form.thresholds.fullDayMinutes > 0,
    form.thresholds.halfDayMinutes > 0,
    form.grace.lateInMinutes >= 0,
    form.grace.earlyOutMinutes >= 0,
    form.breaks.enabled,
    form.missingPunch.regularizationWindowDays > 0,
    form.overtime.trackingEnabled,
    form.overtime.minimumExtraMinutes > 0,
    form.overtime.compOffMinutesPerDay > 0,
    form.weeklyTarget.enabled,
    activeLocations.length > 0,
    form.locationEnforcement !== 'DISABLED',
    Object.values(form.notifications).some((n) => n.enabled),
  ];
  const configured = checks.filter(Boolean).length;
  const completeness = Math.round((configured / checks.length) * 100);

  const enforcementLabel =
    form.locationEnforcement === 'ENFORCED'
      ? 'Strict — punches need a verified location'
      : form.locationEnforcement === 'WARN'
        ? 'Warn only — mismatched punches are flagged'
        : 'Off — location is recorded, never required';

  const jumpTo = (id) => {
    const el = document.getElementById(`policy-${id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const rulePill = (n) => (
    <span className="shrink-0 rounded-full bg-st-secondary-container/70 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-st-on-secondary-container">
      Rule group {String(n).padStart(2, '0')}
    </span>
  );

  if (permissionsLoading || loading) {
    return <p className="st-surface p-6 text-sm text-st-on-variant">Reading attendance policy…</p>;
  }

  if (!canRead) {
    return (
      <div className="st-surface min-h-screen">
        <div className="rounded-xl bg-st-lowest p-6 shadow-sm">
          <h1 className="text-xl font-bold text-st-on">Attendance policy</h1>
          <p className="mt-2 text-sm text-st-on-variant">
            You do not have permission to view the company attendance policy.
          </p>
        </div>
      </div>
    );
  }

  const readOnly = !canManage;

  return (
    <div className="st-surface min-h-screen">
      <div className="flex flex-col gap-6">
        {/* ── hero ─────────────────────────────────────────────────────── */}
        <section className="rounded-xl bg-st-lowest p-6 shadow-sm md:p-7">
          <div className="flex flex-col justify-between gap-6 xl:flex-row xl:items-start">
            <div className="max-w-3xl space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-st-secondary-container px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-st-on-secondary-container">
                  Workforce governance
                </span>
                <span className="text-[11px] font-medium text-st-on-variant">
                  v{policy?.configVersion ?? 1} · {isLive ? 'Active production' : 'Draft'}
                </span>
                <span className="rounded-full bg-st-high px-2.5 py-0.5 text-[11px] font-semibold text-st-on">
                  {policy?.name || 'Default org policy'}
                </span>
              </div>
              <h1 className="text-3xl font-bold tracking-tight text-st-on lg:text-4xl">
                Enterprise attendance policy
              </h1>
              <p className="max-w-2xl text-sm leading-relaxed text-st-on-variant">
                Thresholds, grace brackets, break ceilings, comp-off accrual and location rules. The
                engine evaluates every punch against this one document.
              </p>
            </div>

            <div className="flex w-full max-w-md shrink-0 flex-col gap-2 rounded-xl bg-st-low p-4">
              <div className="flex items-start gap-2 text-xs">
                <Clock className="mt-0.5 h-4 w-4 shrink-0 text-st-secondary" aria-hidden="true" />
                <span className="text-st-on-variant">
                  Base zone: <strong className="font-semibold text-st-on">{form.timezone}</strong>
                </span>
              </div>
              <div className="flex items-start gap-2 text-xs">
                <History className="mt-0.5 h-4 w-4 shrink-0 text-st-secondary" aria-hidden="true" />
                <span className="text-st-on-variant">
                  {publishedAt ? (
                    <>
                      Last published:{' '}
                      <strong className="font-semibold text-st-on">{publishedAt}</strong>
                    </>
                  ) : (
                    'Never published — the draft is not in force'
                  )}
                </span>
              </div>
              <div className="flex items-start gap-2 text-xs">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-st-secondary" aria-hidden="true" />
                <span className="text-st-on-variant">
                  Enforcement: <strong className="font-semibold text-st-on">{enforcementLabel}</strong>
                </span>
              </div>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-st-high pt-4">
            <button
              type="button"
              onClick={() => jumpTo('timeline')}
              className="inline-flex items-center gap-2 rounded-lg bg-st-container px-3.5 py-2 text-xs font-semibold text-st-on transition hover:bg-st-high"
            >
              <History className="h-4 w-4" aria-hidden="true" />
              Version history ({history.length})
            </button>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={save}
                disabled={saving || readOnly}
                className="inline-flex items-center gap-2 rounded-lg bg-st-container px-3.5 py-2 text-xs font-semibold text-st-on transition hover:bg-st-high disabled:opacity-50"
              >
                <Save className="h-4 w-4" aria-hidden="true" />
                {saving ? 'Saving…' : 'Save draft'}
              </button>
              <button
                type="button"
                onClick={activate}
                disabled={activating || !canActivate || saving}
                title={
                  canActivate
                    ? 'Make this draft the company rule for future evaluation'
                    : 'Activating a policy needs the activate permission'
                }
                className="inline-flex items-center gap-2 rounded-lg bg-st-primary-container px-4 py-2 text-xs font-bold text-st-on-primary-container shadow-sm transition hover:opacity-95 disabled:opacity-50"
              >
                <Sparkles className="h-4 w-4" aria-hidden="true" />
                {activating ? 'Publishing…' : isLive ? 'Republish policy' : 'Publish policy update'}
              </button>
            </div>
          </div>

          {message ? (
            <p className="mt-3 flex items-center gap-1.5 rounded-lg bg-st-secondary-container/50 px-3 py-2 text-xs font-medium text-st-on-secondary-container">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> {message}
            </p>
          ) : null}
          {readOnly ? (
            <p className="mt-3 rounded-lg bg-st-container px-3 py-2 text-xs text-st-on-variant">
              You can read this policy but not change it — saving and publishing need the manage
              permission.
            </p>
          ) : null}
          {locError ? (
            <p className="mt-3 flex items-center gap-1.5 rounded-lg bg-st-error-container px-3 py-2 text-xs font-medium text-st-on-error-container">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> {locError}
            </p>
          ) : null}

          {/* anchors, not a second state machine — every group stays on the page */}
          <div className="mt-4 flex flex-wrap items-center gap-1.5 overflow-x-auto rounded-xl bg-st-high p-1">
            {GROUPS.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => jumpTo(g.id)}
                className="inline-flex whitespace-nowrap items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold text-st-on-variant transition hover:bg-st-lowest hover:text-st-on"
              >
                <g.Icon className="h-3.5 w-3.5" aria-hidden="true" />
                {g.label}
              </button>
            ))}
          </div>
        </section>

        <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-12">
          <div className="flex flex-col gap-6 xl:col-span-9">
            {/* ── core hours ───────────────────────────────────────────── */}
            <section id="policy-core" className="rounded-xl bg-st-lowest p-6 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-st-secondary-container text-st-secondary">
                    <Clock className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div>
                    <h2 className="text-base font-bold text-st-on">
                      Core working hours &amp; minimum durations
                    </h2>
                    <p className="text-xs text-st-on-variant">
                      The credit thresholds every presence calculation is measured against.
                    </p>
                  </div>
                </div>
                {rulePill(1)}
              </div>

              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                {[
                  ['Full-day credit', 'Full shift minimum', 'fullDayMinutes', '1.0 day'],
                  ['Half-day credit', 'Partial shift minimum', 'halfDayMinutes', '0.5 day'],
                ].map(([title, sub, key, credit]) => (
                  <div key={key} className="rounded-xl bg-st-low p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-bold text-st-on">{title}</h3>
                        <p className="text-[11px] text-st-on-variant">{sub}</p>
                      </div>
                      <span className="rounded-full bg-st-secondary-container/60 px-2 py-0.5 text-[10px] font-bold text-st-on-secondary-container">
                        {credit}
                      </span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <label className="block">
                        <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-st-outline">
                          Minutes / day
                        </span>
                        <input
                          type="number"
                          min="0"
                          max="1440"
                          disabled={readOnly}
                          value={form.thresholds[key]}
                          onChange={(e) => setSection('thresholds', key, e.target.value)}
                          className="w-full rounded-lg bg-st-lowest px-3 py-2 text-sm font-bold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40 disabled:opacity-60"
                        />
                      </label>
                      <div className="rounded-lg bg-st-lowest px-3 py-2">
                        <span className="block text-[10px] font-bold uppercase tracking-wider text-st-outline">
                          Equivalent
                        </span>
                        <span className="text-sm font-bold text-st-primary">
                          {formatMinutes(form.thresholds[key])}
                        </span>
                      </div>
                    </div>
                    <p className="mt-2 text-[11px] leading-snug text-st-on-variant">
                      {key === 'fullDayMinutes'
                        ? `Anything under ${form.thresholds.fullDayMinutes} minutes falls to half-day or a deficit review.`
                        : `Under ${form.thresholds.halfDayMinutes} minutes the day is flagged absent.`}
                    </p>
                  </div>
                ))}
              </div>

              <div className="mt-4 rounded-xl bg-st-low p-4">
                <h3 className="flex items-center gap-1.5 text-sm font-bold text-st-on">
                  <Hourglass className="h-4 w-4 text-st-secondary" aria-hidden="true" />
                  Leniency &amp; grace tolerances
                </h3>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-semibold text-st-on">
                      Late arrival grace
                    </span>
                    <span className="mb-1.5 block text-[10px] text-st-on-variant">
                      Minutes past the shift start
                    </span>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min="0"
                        max="240"
                        disabled={readOnly}
                        value={form.grace.lateInMinutes}
                        onChange={(e) => setSection('grace', 'lateInMinutes', e.target.value)}
                        className="w-full rounded-lg bg-st-lowest px-3 py-2 text-sm font-bold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40 disabled:opacity-60"
                      />
                      <span className="text-[10px] font-semibold text-st-outline">mins</span>
                    </div>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-semibold text-st-on">
                      Early departure grace
                    </span>
                    <span className="mb-1.5 block text-[10px] text-st-on-variant">
                      Leeway before the shift end
                    </span>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min="0"
                        max="240"
                        disabled={readOnly}
                        value={form.grace.earlyOutMinutes}
                        onChange={(e) => setSection('grace', 'earlyOutMinutes', e.target.value)}
                        className="w-full rounded-lg bg-st-lowest px-3 py-2 text-sm font-bold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40 disabled:opacity-60"
                      />
                      <span className="text-[10px] font-semibold text-st-outline">mins</span>
                    </div>
                  </label>
                  <div className="rounded-lg bg-st-lowest px-3 py-2">
                    <span className="block text-[11px] font-semibold text-st-on">
                      Monthly grace occurrences
                    </span>
                    <span className="mt-1 block text-sm font-bold text-st-outline">Not configured</span>
                    <span className="mt-0.5 block text-[10px] leading-snug text-st-on-variant">
                      The policy has no occurrence cap — late marks accumulate on the record and are
                      reviewed, not auto-deducted.
                    </span>
                  </div>
                </div>
              </div>
            </section>

            {/* ── breaks ───────────────────────────────────────────────── */}
            <section id="policy-breaks" className="rounded-xl bg-st-lowest p-6 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-st-primary-fixed text-st-primary">
                    <Coffee className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div>
                    <h2 className="text-base font-bold text-st-on">Break protocols &amp; meal sessions</h2>
                    <p className="text-xs text-st-on-variant">
                      Mid-day punches, paid windows and the automatic deduction on net hours.
                    </p>
                  </div>
                </div>
                {rulePill(2)}
              </div>

              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Toggle
                  label="Allow mid-day breaks"
                  checked={form.breaks.enabled}
                  disabled={readOnly}
                  onChange={(v) => setSection('breaks', 'enabled', v)}
                  hint="Permits a check-out and re-check-in inside the workday."
                />
                <Toggle
                  label="Paid meal window"
                  checked={form.breaks.includeInWorkedTime}
                  disabled={readOnly}
                  onChange={(v) => setSection('breaks', 'includeInWorkedTime', v)}
                  hint="Break time counts toward the required minutes when on."
                />
                <div className="rounded-lg border border-dashed border-st-high px-3 py-2">
                  <span className="block text-xs font-semibold text-st-on">Biometric break validation</span>
                  <span className="mt-0.5 block text-[11px] text-st-on-variant">
                    Not configured — turnstile terminals are not wired to break events.
                  </span>
                </div>
              </div>

              <div className="mt-4 flex flex-col gap-3 rounded-xl bg-st-low p-4 sm:flex-row sm:items-center">
                <div className="flex items-end gap-3">
                  <div className="text-center">
                    <div className="text-2xl font-bold text-st-on">
                      {form.breaks.dailyLimitMinutes === '' ? '—' : form.breaks.dailyLimitMinutes}
                    </div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-st-outline">m</div>
                  </div>
                  <p className="max-w-md text-[11px] leading-snug text-st-on-variant">
                    <strong className="font-semibold text-st-on">Maximum cumulative daily break.</strong>{' '}
                    Leave it blank for no ceiling. Time beyond it extends the required departure, it is
                    never silently dropped.
                  </p>
                </div>
                <label className="block sm:ml-auto sm:w-40">
                  <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-st-outline">
                    Ceiling (mins)
                  </span>
                  <input
                    type="number"
                    min="0"
                    max="720"
                    disabled={readOnly}
                    placeholder="No ceiling"
                    value={form.breaks.dailyLimitMinutes}
                    onChange={(e) => setSection('breaks', 'dailyLimitMinutes', e.target.value)}
                    className="w-full rounded-lg bg-st-lowest px-3 py-2 text-sm font-bold text-st-on placeholder:font-normal placeholder:text-st-on-variant/60 focus:outline-none focus:ring-2 focus:ring-st-primary-container/40 disabled:opacity-60"
                  />
                </label>
              </div>
            </section>

            {/* ── missing punch ────────────────────────────────────────── */}
            <section id="policy-missing" className="rounded-xl bg-st-lowest p-6 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-st-tertiary-fixed text-st-on-tertiary-fixed">
                    <CalendarClock className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div>
                    <h2 className="text-base font-bold text-st-on">
                      Missing punch &amp; regularization protocol
                    </h2>
                    <p className="text-xs text-st-on-variant">
                      Retrospective correction rights, before the cycle freezes the log.
                    </p>
                  </div>
                </div>
                {rulePill(3)}
              </div>

              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="rounded-xl bg-st-low p-4">
                  <h3 className="text-sm font-bold text-st-on">Regularization claim window</h3>
                  <p className="mt-0.5 text-[11px] leading-snug text-st-on-variant">
                    Days after the punch that a correction can still be filed online.
                  </p>
                  <div className="mt-3 flex items-end gap-2">
                    <input
                      type="number"
                      min="0"
                      max="90"
                      disabled={readOnly}
                      value={form.missingPunch.regularizationWindowDays}
                      onChange={(e) =>
                        setSection('missingPunch', 'regularizationWindowDays', e.target.value)
                      }
                      className="w-20 rounded-lg bg-st-lowest px-3 py-2 text-lg font-bold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40 disabled:opacity-60"
                    />
                    <span className="pb-2 text-[11px] font-semibold text-st-on-variant">
                      calendar days before auto-lock
                    </span>
                  </div>
                  <Toggle
                    label="Corrections allowed"
                    checked={form.missingPunch.allowRegularization}
                    disabled={readOnly}
                    onChange={(v) => setSection('missingPunch', 'allowRegularization', v)}
                    hint="When off, a missing punch can only be resolved by an admin."
                  />
                </div>

                <div className="rounded-xl bg-st-low p-4">
                  <h3 className="text-sm font-bold text-st-on">Monthly regularization limit</h3>
                  <p className="mt-0.5 text-[11px] leading-snug text-st-on-variant">
                    A cap on claims per employee each month.
                  </p>
                  <div className="mt-3 flex items-end gap-2">
                    <span className="text-lg font-bold text-st-outline">Not configured</span>
                  </div>
                  <p className="mt-1 text-[10px] leading-snug text-st-on-variant">
                    The policy has no per-month ceiling; every claim is reviewed on its own.
                  </p>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-st-low px-4 py-3">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-st-secondary" aria-hidden="true" />
                  <span className="text-xs text-st-on">
                    <strong className="font-semibold">Exception-first:</strong> an unresolved single
                    punch is flagged for review, never turned into a loss of pay automatically.
                  </span>
                </div>
                <span
                  className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${
                    form.missingPunch.keepUnresolved
                      ? 'bg-st-secondary-container text-st-on-secondary-container'
                      : 'bg-st-high text-st-on-variant'
                  }`}
                >
                  {form.missingPunch.keepUnresolved ? 'Enforced' : 'Off'}
                </span>
              </div>
            </section>

            {/* ── overtime ─────────────────────────────────────────────── */}
            <section id="policy-overtime" className="rounded-xl bg-st-lowest p-6 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-st-secondary-container text-st-secondary">
                    <Timer className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div>
                    <h2 className="text-base font-bold text-st-on">
                      Overtime &amp; compensatory off
                    </h2>
                    <p className="text-xs text-st-on-variant">
                      Surplus hours become eligible time, then a human approves it. Never a payroll
                      figure on this page.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {rulePill(4)}
                  <span
                    className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${
                      form.overtime.trackingEnabled
                        ? 'bg-st-secondary-container text-st-on-secondary-container'
                        : 'bg-st-high text-st-on-variant'
                    }`}
                  >
                    {form.overtime.trackingEnabled ? 'Active' : 'Off'}
                  </span>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                {[
                  [
                    'OT trigger threshold',
                    form.overtime.minimumExtraMinutes,
                    'min beyond shift',
                    'Surplus under this is disregarded.',
                  ],
                  [
                    'Weekend accrual',
                    form.overtime.weekendEligible ? 'Eligible' : 'Not eligible',
                    form.overtime.weeklyOffBenefit === 'NONE' ? 'no benefit set' : form.overtime.weeklyOffBenefit,
                    'Scheduled weekly-off effort.',
                  ],
                  [
                    'Holiday work',
                    form.overtime.holidayEligible ? 'Eligible' : 'Not eligible',
                    form.overtime.holidayBenefit === 'NONE' ? 'no benefit set' : form.overtime.holidayBenefit,
                    'Declared holiday shifts.',
                  ],
                ].map(([title, value, unit, note]) => (
                  <div key={title} className="rounded-xl bg-st-low p-4">
                    <span className="block text-[11px] font-semibold text-st-on-variant">{title}</span>
                    <span className="mt-1 block text-xl font-bold text-st-on">{value}</span>
                    <span className="block text-[10px] font-semibold text-st-primary">{unit}</span>
                    <span className="mt-1 block text-[10px] leading-snug text-st-on-variant">{note}</span>
                  </div>
                ))}
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="rounded-xl bg-st-low p-4">
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold text-st-on">
                    <Gauge className="h-3.5 w-3.5 text-st-secondary" aria-hidden="true" />
                    Comp-off conversion
                  </span>
                  <span className="mt-1 block text-sm font-bold text-st-on">
                    {form.overtime.compOffMinutesPerDay} mins = 1.0 comp-off day
                  </span>
                  <input
                    type="number"
                    min="60"
                    max="1440"
                    step="30"
                    disabled={readOnly}
                    value={form.overtime.compOffMinutesPerDay}
                    onChange={(e) => setSection('overtime', 'compOffMinutesPerDay', e.target.value)}
                    className="mt-2 w-full rounded-lg bg-st-lowest px-3 py-2 text-sm font-bold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40 disabled:opacity-60"
                  />
                </label>
                <div className="rounded-xl bg-st-low p-4">
                  <Toggle
                    label="Manager pre-approval required"
                    checked={form.overtime.approvalRequired}
                    disabled={readOnly}
                    onChange={(v) => setSection('overtime', 'approvalRequired', v)}
                    hint="Every claim waits for a decision before it counts."
                  />
                  <div className="mt-3 border-t border-st-high pt-3">
                    <Toggle
                      label="Track overtime at all"
                      checked={form.overtime.trackingEnabled}
                      disabled={readOnly}
                      onChange={(v) => setSection('overtime', 'trackingEnabled', v)}
                      hint="The master switch for this whole rule group."
                    />
                  </div>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-st-low px-4 py-3">
                <span className="text-xs text-st-on">
                  <strong className="font-semibold">Comp-off validity window</strong>
                </span>
                <span className="rounded-full bg-st-high px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-st-on-variant">
                  Not configured — earned days do not expire here
                </span>
              </div>
            </section>

            {/* ── weekly hours target ──────────────────────────────────── */}
            <section id="policy-weekly" className="rounded-xl bg-st-lowest p-6 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-st-secondary-container text-st-secondary">
                    <Target className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div>
                    <h2 className="text-base font-bold text-st-on">Weekly hours target (flexi week)</h2>
                    <p className="text-xs text-st-on-variant">
                      A goal for the week rather than a fixed daily minimum — never absent, never LOP, no leave deducted.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-st-high px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-st-on-variant">
                    Optional
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={Boolean(form.weeklyTarget.enabled)}
                    disabled={readOnly}
                    onClick={() => setSection('weeklyTarget', 'enabled', !form.weeklyTarget.enabled)}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${
                      form.weeklyTarget.enabled ? 'bg-st-secondary' : 'bg-st-highest'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-5 w-5 rounded-full bg-st-lowest shadow transition ${
                        form.weeklyTarget.enabled ? 'translate-x-[22px]' : 'translate-x-0.5'
                      }`}
                    />
                    <span className="sr-only">Enable the weekly hours target</span>
                  </button>
                </div>
              </div>

              <div className={`mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3 ${form.weeklyTarget.enabled ? '' : 'opacity-60'}`}>
                <label className="block rounded-xl bg-st-low p-4">
                  <span className="block text-[11px] font-semibold text-st-on">Target per week</span>
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      type="number"
                      min="1"
                      max="80"
                      step="0.5"
                      disabled={readOnly || !form.weeklyTarget.enabled}
                      value={form.weeklyTarget.targetHours}
                      onChange={(e) => setSection('weeklyTarget', 'targetHours', e.target.value)}
                      className="w-20 rounded-lg bg-st-lowest px-3 py-2 text-lg font-bold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40 disabled:opacity-60"
                    />
                    <span className="text-[11px] font-semibold text-st-on-variant">hours</span>
                  </div>
                  <span className="mt-1 block text-[10px] text-st-on-variant">
                    Stored as {Math.round(Number(form.weeklyTarget.targetHours || 0) * 60) || 2400} minutes.
                  </span>
                </label>

                <label className="block rounded-xl bg-st-low p-4">
                  <span className="block text-[11px] font-semibold text-st-on">Short week handling</span>
                  <select
                    disabled={readOnly || !form.weeklyTarget.enabled}
                    value={form.weeklyTarget.restDayMode}
                    onChange={(e) => setSection('weeklyTarget', 'restDayMode', e.target.value)}
                    className="mt-2 w-full rounded-lg bg-st-lowest px-3 py-2 text-xs font-semibold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40 disabled:opacity-60"
                  >
                    <option value="AUTO_MARK">Auto-mark remaining days as earned rest</option>
                    <option value="SUGGEST_ONLY">Only suggest (no auto-marking)</option>
                  </select>
                  <span className="mt-1 block text-[10px] text-st-on-variant">
                    Earned rest is a label on the day, not a deduction.
                  </span>
                </label>

                <div className="rounded-xl bg-st-low p-4">
                  <span className="block text-[11px] font-semibold text-st-on">Counting</span>
                  <label className="mt-2 flex items-start gap-2 text-[11px] text-st-on">
                    <input
                      type="checkbox"
                      disabled={readOnly || !form.weeklyTarget.enabled}
                      checked={form.weeklyTarget.includeApprovedOvertime}
                      onChange={(e) => setSection('weeklyTarget', 'includeApprovedOvertime', e.target.checked)}
                      className="mt-0.5 accent-st-secondary"
                    />
                    <span>Count approved overtime toward the goal</span>
                  </label>
                  <span className="mt-1 block text-[10px] text-st-on-variant">
                    Off by default: overtime stays a separate credit.
                  </span>
                </div>
              </div>
            </section>

            {/* ── locations ────────────────────────────────────────────── */}
            <section id="policy-geofence" className="rounded-xl bg-st-lowest p-6 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-st-primary-fixed text-st-primary">
                    <Crosshair className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div>
                    <h2 className="text-base font-bold text-st-on">
                      Office locations &amp; physical geofencing
                    </h2>
                    <p className="text-xs text-st-on-variant">
                      The perimeters a punch can be validated against, and what the policy does when a
                      punch falls outside one.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 rounded-lg bg-st-low px-2.5 py-1.5 text-[11px] font-semibold text-st-on">
                    <span className="text-st-on-variant">Enforcement</span>
                    <select
                      value={form.locationEnforcement}
                      disabled={readOnly}
                      onChange={(e) => setForm((p) => ({ ...p, locationEnforcement: e.target.value }))}
                      className="rounded bg-st-lowest px-1.5 py-1 text-[11px] font-bold text-st-on focus:outline-none"
                    >
                      <option value="DISABLED">Off</option>
                      <option value="WARN">Warn only</option>
                      <option value="ENFORCED">Strict</option>
                    </select>
                  </label>
                  {canManageLocations ? (
                    <button
                      type="button"
                      onClick={() => {
                        resetLocForm();
                        document.getElementById('policy-location-form')?.scrollIntoView({ behavior: 'smooth' });
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-st-primary-container px-3 py-1.5 text-[11px] font-bold text-st-on-primary-container transition hover:opacity-95"
                    >
                      <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add geofence
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="mt-4 space-y-3">
                {activeLocations.map((loc) => (
                  <div key={loc.id} className="rounded-xl bg-st-low p-4">
                    <div className="flex flex-col gap-4 sm:flex-row">
                      <div
                        className="relative flex h-28 w-full shrink-0 items-center justify-center overflow-hidden rounded-lg bg-st-high sm:w-40"
                        aria-hidden="true"
                      >
                        <div className="absolute inset-0 opacity-40 [background-image:linear-gradient(to_right,#85746822_1px,transparent_1px),linear-gradient(to_bottom,#85746822_1px,transparent_1px)] [background-size:14px_14px]" />
                        <span className="absolute h-16 w-16 rounded-full border-2 border-dashed border-st-secondary/60" />
                        <span className="relative flex h-8 w-8 items-center justify-center rounded-full bg-st-secondary text-st-on-secondary shadow">
                          <MapPin className="h-4 w-4" />
                        </span>
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-bold text-st-on">{loc.name}</h3>
                          <span className="rounded-full bg-st-secondary-container px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-st-on-secondary-container">
                            {loc.code || 'Site'}
                          </span>
                          <span className="text-[10px] font-semibold text-st-on-variant">
                            {Number(loc.latitude).toFixed(4)}° N, {Number(loc.longitude).toFixed(4)}° E
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11px] text-st-on-variant">
                          {loc.displayAddress || 'No address on file'}
                        </p>
                        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                          {[
                            ['Geofence radius', `${loc.radiusMeters} m`],
                            ['Wi-Fi BSSID', 'Not configured'],
                            ['Mock GPS block', 'Server-side only'],
                            ['State', loc.isActive ? 'Active' : 'Inactive'],
                          ].map(([label, value]) => (
                            <div key={label}>
                              <span className="block text-[9px] font-bold uppercase tracking-wider text-st-outline">
                                {label}
                              </span>
                              <span
                                className={`block text-[11px] font-semibold ${
                                  value === 'Not configured' ? 'text-st-on-variant' : 'text-st-on'
                                }`}
                              >
                                {value}
                              </span>
                            </div>
                          ))}
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setLocForm({
                                id: loc.id,
                                name: loc.name || '',
                                code: loc.code || '',
                                displayAddress: loc.displayAddress || '',
                                latitude: String(loc.latitude ?? ''),
                                longitude: String(loc.longitude ?? ''),
                                radiusMeters: loc.radiusMeters ?? 200,
                                isActive: Boolean(loc.isActive),
                              });
                              document.getElementById('policy-location-form')?.scrollIntoView({ behavior: 'smooth' });
                            }}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-st-lowest px-2.5 py-1.5 text-[11px] font-semibold text-st-on shadow-sm transition hover:bg-st-container"
                          >
                            <Pencil className="h-3 w-3" aria-hidden="true" /> Configure parameters
                          </button>
                          {canManageLocations ? (
                            <button
                              type="button"
                              disabled={locBusy}
                              onClick={() => toggleLocationActive(loc)}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-st-lowest px-2.5 py-1.5 text-[11px] font-semibold text-st-on-variant shadow-sm transition hover:text-st-on disabled:opacity-50"
                            >
                              <Power className="h-3 w-3" aria-hidden="true" />
                              {loc.isActive ? 'Deactivate' : 'Activate'}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}

                {!activeLocations.length ? (
                  <EmptyState
                    illustration="shield"
                    title="No geofence configured"
                    description="Punches are accepted from anywhere and the location is recorded without being enforced. Add an office perimeter to validate against it."
                    size="sm"
                  />
                ) : null}
              </div>

              {/* the form the mock opens from “Configure parameters” */}
              {canManageLocations ? (
                <div id="policy-location-form" className="mt-4 rounded-xl border border-st-high p-4">
                  <h3 className="text-sm font-bold text-st-on">
                    {locForm.id ? `Edit ${locForm.name || 'location'}` : 'Add a geofence'}
                  </h3>
                  <p className="mt-0.5 text-[11px] text-st-on-variant">
                    Radius is metres. A punch within it is a location match; outside it the enforcement
                    setting above decides what happens.
                  </p>
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {[
                      ['name', 'Site name', 'text'],
                      ['code', 'Short code', 'text'],
                      ['displayAddress', 'Address', 'text'],
                      ['radiusMeters', 'Radius (m)', 'number'],
                      ['latitude', 'Latitude', 'number'],
                      ['longitude', 'Longitude', 'number'],
                    ].map(([key, label, type]) => (
                      <label key={key} className="block">
                        <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-st-outline">
                          {label}
                        </span>
                        <input
                          type={type}
                          step={key === 'radiusMeters' ? 10 : 'any'}
                          value={locForm[key]}
                          onChange={(e) => setLocForm((p) => ({ ...p, [key]: e.target.value }))}
                          className="w-full rounded-lg bg-st-low px-3 py-2 text-xs text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                        />
                      </label>
                    ))}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={handleUseCurrentLocation}
                      disabled={locGeo.status === 'loading'}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-st-container px-3 py-2 text-[11px] font-semibold text-st-on transition hover:bg-st-high disabled:opacity-50"
                    >
                      <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />
                      {locGeo.status === 'loading' ? 'Locating…' : 'Use my current location'}
                    </button>
                    <label className="flex items-center gap-1.5 text-[11px] font-medium text-st-on">
                      <input
                        type="checkbox"
                        checked={locForm.isActive}
                        onChange={(e) => setLocForm((p) => ({ ...p, isActive: e.target.checked }))}
                        className="accent-st-primary"
                      />
                      Active
                    </label>
                    <div className="ml-auto flex gap-2">
                      <button
                        type="button"
                        onClick={resetLocForm}
                        className="rounded-lg bg-st-low px-3 py-2 text-[11px] font-semibold text-st-on-variant transition hover:bg-st-container hover:text-st-on"
                      >
                        Clear
                      </button>
                      <button
                        type="button"
                        onClick={saveLocation}
                        disabled={locBusy || !locForm.name.trim() || locForm.latitude === '' || locForm.longitude === ''}
                        className="rounded-lg bg-st-primary-container px-4 py-2 text-[11px] font-bold text-st-on-primary-container transition hover:opacity-95 disabled:opacity-50"
                      >
                        {locBusy ? 'Saving…' : locForm.id ? 'Update geofence' : 'Create geofence'}
                      </button>
                    </div>
                  </div>
                  {locGeo.message ? (
                    <p
                      className={`mt-2 text-[11px] ${
                        locGeo.status === 'error' ? 'text-st-error' : 'text-st-on-variant'
                      }`}
                    >
                      {locGeo.message}
                      {locGeo.accuracy ? ` · ±${Math.round(locGeo.accuracy)} m` : ''}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </section>

            {/* ── notifications ────────────────────────────────────────── */}
            <section id="policy-audit" className="rounded-xl bg-st-lowest p-6 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-st-secondary-container text-st-secondary">
                    <BellRing className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div>
                    <h2 className="text-base font-bold text-st-on">
                      Automated notifications &amp; daily nudges
                    </h2>
                    <p className="text-xs text-st-on-variant">
                      In-app and email cues the scheduler sends. Slack and WhatsApp are not wired to
                      this deployment.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {rulePill(5)}
                  <span
                    className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${
                      Object.values(form.notifications).some((n) => n.enabled)
                        ? 'bg-st-secondary-container text-st-on-secondary-container'
                        : 'bg-st-high text-st-on-variant'
                    }`}
                  >
                    {Object.values(form.notifications).some((n) => n.enabled) ? 'Some on' : 'All off'}
                  </span>
                </div>
              </div>

              <ul className="mt-4 space-y-2">
                {[
                  ['missingClockOut', 'Missed punch-out reminder', 'Sent when a check-in has no check-out.', 'minutesAfter'],
                  ['missingClockIn', 'Missed punch-in reminder', 'Sent when a shift started with no check-in.', 'minutesAfter'],
                  ['incompleteBreak', 'Break left open', 'Sent when a break is never closed.', 'minutesAfter'],
                  ['shiftStart', 'Shift starting soon', 'A heads-up before the assigned window.', 'minutesBefore'],
                ].map(([key, title, note, field]) => {
                  const cfg = form.notifications[key] || { enabled: false, [field]: 30 };
                  return (
                    <li
                      key={key}
                      className="flex flex-col gap-2 rounded-xl bg-st-low p-3 sm:flex-row sm:items-center"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-bold text-st-on">{title}</p>
                        <p className="text-[11px] text-st-on-variant">{note}</p>
                      </div>
                      <label className="flex items-center gap-1.5 text-[11px] text-st-on-variant">
                        {field === 'minutesBefore' ? 'before' : 'after'}
                        <input
                          type="number"
                          min="0"
                          max="240"
                          disabled={readOnly}
                          value={cfg[field]}
                          onChange={(e) => setNotification(key, field, e.target.value)}
                          className="w-16 rounded-lg bg-st-lowest px-2 py-1 text-xs font-bold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40 disabled:opacity-60"
                        />
                        min
                      </label>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={Boolean(cfg.enabled)}
                        disabled={readOnly}
                        onClick={() => setNotification(key, 'enabled', !cfg.enabled)}
                        className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${
                          cfg.enabled ? 'bg-st-secondary' : 'bg-st-highest'
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 h-5 w-5 rounded-full bg-st-lowest shadow transition ${
                            cfg.enabled ? 'translate-x-[22px]' : 'translate-x-0.5'
                          }`}
                        />
                        <span className="sr-only">{title}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>

            {/* ── timeline ─────────────────────────────────────────────── */}
            <section id="policy-timeline" className="rounded-xl bg-st-lowest p-6 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-st-high text-st-on">
                    <History className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div>
                    <h2 className="text-base font-bold text-st-on">Policy version timeline</h2>
                    <p className="text-xs text-st-on-variant">
                      Every stored iteration, newest first. Publishing never deletes the previous one.
                    </p>
                  </div>
                </div>
                <span className="rounded-full bg-st-container px-2.5 py-1 text-[10px] font-bold text-st-on-variant">
                  {history.length} stored
                </span>
              </div>

              <ol className="mt-4 space-y-2">
                {history.map((row) => {
                  const stamp = fmtDateTime(row.activatedAt || row.updatedAt || row.createdAt);
                  const live = row.isCurrent || row.id === policy?.id;
                  return (
                    <li key={row.id} className="flex items-start gap-3 rounded-xl bg-st-low p-3">
                      <span
                        className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                          live ? 'bg-st-secondary' : 'bg-st-outline'
                        }`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-bold text-st-on">
                            Version {row.configVersion}
                          </span>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                              live
                                ? 'bg-st-secondary-container text-st-on-secondary-container'
                                : row.status === 'DRAFT'
                                  ? 'bg-st-primary-fixed text-st-on-primary-fixed-variant'
                                  : 'bg-st-high text-st-on-variant'
                            }`}
                          >
                            {live ? 'Active' : row.status}
                          </span>
                          <span className="text-[10px] text-st-on-variant">{stamp || '—'}</span>
                        </div>
                        <p className="mt-0.5 truncate text-[11px] text-st-on-variant">
                          {row.name || 'Attendance policy'} · {row.timezone || form.timezone} · grace{' '}
                          {row.grace?.lateInMinutes ?? '—'}/{row.grace?.earlyOutMinutes ?? '—'} min · full
                          day {row.thresholds?.fullDayMinutes ?? '—'} min
                        </p>
                      </div>
                    </li>
                  );
                })}
                {!history.length ? (
                  <li className="rounded-xl border border-dashed border-st-high px-3 py-4 text-center text-[11px] text-st-on-variant">
                    No earlier version is stored — this is the first draft.
                  </li>
                ) : null}
              </ol>
            </section>
          </div>

          {/* ── rail ─────────────────────────────────────────────────────── */}
          <aside className="flex flex-col gap-6 xl:col-span-3">
            <div className="rounded-xl bg-st-lowest p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold uppercase tracking-wider text-st-outline">
                  Policy coverage
                </h3>
                <span className="rounded-full bg-st-tertiary-fixed px-2 py-0.5 text-[10px] font-bold uppercase text-st-on-tertiary-fixed">
                  {completeness >= 90 ? 'A' : completeness >= 75 ? 'B' : 'C'}
                </span>
              </div>
              <div className="mt-4 flex items-center gap-4">
                <div className="relative h-20 w-20 shrink-0">
                  <svg viewBox="0 0 100 100" className="h-20 w-20 -rotate-90" role="img" aria-label={`${completeness}% of rules configured`}>
                    <circle cx="50" cy="50" r="42" fill="none" strokeWidth="12" className="stroke-st-high" />
                    <circle
                      cx="50"
                      cy="50"
                      r="42"
                      fill="none"
                      strokeWidth="12"
                      strokeLinecap="round"
                      className="stroke-st-secondary"
                      strokeDasharray={`${(completeness / 100) * 264} 264`}
                    />
                  </svg>
                  <span className="absolute inset-0 flex items-center justify-center text-sm font-bold text-st-on">
                    {completeness}%
                  </span>
                </div>
                <ul className="min-w-0 flex-1 space-y-1 text-[11px]">
                  <li className="flex items-center justify-between gap-2">
                    <span className="text-st-on-variant">Rules decided</span>
                    <span className="font-bold text-st-on">
                      {configured}/{checks.length}
                    </span>
                  </li>
                  <li className="flex items-center justify-between gap-2">
                    <span className="text-st-on-variant">Sites enforced</span>
                    <span className="font-bold text-st-on">{activeLocations.length}</span>
                  </li>
                  <li className="flex items-center justify-between gap-2">
                    <span className="text-st-on-variant">State</span>
                    <span className="font-bold text-st-on">{policyStatus}</span>
                  </li>
                </ul>
              </div>
              <p className="mt-3 text-[10px] leading-relaxed text-st-on-variant">
                A ratio over the fields this policy actually owns — not a compliance score. The engine
                evaluates against whatever is published here.
              </p>
            </div>

            <div className="rounded-xl bg-st-lowest p-5 shadow-sm">
              <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-st-outline">
                <Users className="h-3.5 w-3.5" aria-hidden="true" /> Who this applies to
              </h3>
              <div className="mt-3 space-y-2 text-[11px]">
                {[
                  ['Work modes allowed', Object.entries(form.workModes).filter(([, v]) => v).map(([k]) => k.toLowerCase()).join(', ') || 'None'],
                  ['Approval needed for', Object.entries(form.workModeApproval).filter(([, v]) => v).map(([k]) => k.toLowerCase()).join(', ') || 'None'],
                  ['Weekly flexi target', form.weeklyTarget.enabled ? `${form.weeklyTarget.targetHours} h · ${form.weeklyTarget.restDayMode}` : 'Off'],
                  ['Working on weekly off', form.weekendHoliday.allowWorkOnWeeklyOff ? 'Allowed' : 'Blocked'],
                  ['Working on a holiday', form.weekendHoliday.allowWorkOnHoliday ? 'Allowed' : 'Blocked'],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-start justify-between gap-2">
                    <span className="text-st-on-variant">{label}</span>
                    <span className="max-w-[55%] text-right font-semibold text-st-on">{value}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 grid grid-cols-3 gap-1">
                {Object.entries(form.workModes).map(([key, on]) => (
                  <button
                    key={key}
                    type="button"
                    disabled={readOnly}
                    onClick={() => setSection('workModes', key, !on)}
                    className={`rounded-lg px-1.5 py-1.5 text-[9px] font-bold uppercase transition disabled:opacity-60 ${
                      on
                        ? 'bg-st-secondary-container text-st-on-secondary-container'
                        : 'bg-st-container text-st-on-variant'
                    }`}
                  >
                    {key.toLowerCase()}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[10px] text-st-on-variant">
                Tap a mode to allow or block it, then save the draft.
              </p>
            </div>

            <div className="rounded-xl bg-st-secondary-container/40 p-5">
              <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-st-on-secondary-container">
                <Scale className="h-3.5 w-3.5" aria-hidden="true" /> Labour law reference
              </h3>
              <p className="mt-2 text-[11px] leading-relaxed text-st-on-variant">
                Rest intervals and spread-over limits are set by statute where they apply. Crewly
                records what the policy enforces; it does not adjudicate a statute. Confirm the
                applicable Act for each site with your compliance owner.
              </p>
              <a
                href="/app/governance"
                className="mt-2 inline-flex items-center gap-1 text-[11px] font-bold text-st-secondary hover:underline"
              >
                Audit log <ArrowRight className="h-3 w-3" aria-hidden="true" />
              </a>
            </div>

            <div className="rounded-xl bg-st-low p-5">
              <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-st-outline">
                <Info className="h-3.5 w-3.5" aria-hidden="true" /> Not configured here
              </h3>
              <ul className="mt-2 space-y-1.5 text-[10px] leading-relaxed text-st-on-variant">
                <li className="flex gap-1.5">
                  <Wifi className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" /> Wi-Fi BSSID matching
                  — the schema stores a site, not router identities.
                </li>
                <li className="flex gap-1.5">
                  <Building2 className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" /> Desk &amp; floor
                  capacity — no inventory behind it.
                </li>
                <li className="flex gap-1.5">
                  <Bell className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" /> Slack / WhatsApp
                  delivery — notifications are in-app and email only.
                </li>
              </ul>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
};

export default AttendancePolicyPage;
