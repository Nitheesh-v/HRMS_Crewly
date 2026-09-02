/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Download, Loader2, Pause, Play, Trash2 } from 'lucide-react';

import usePermission from '../../../hooks/usePermission.js';
import payrollAnalyticsService, { saveBlob } from '../../../services/payrollAnalyticsService.js';

import {
  AccessDenied,
  Banner,
  DataTable,
  PageHeader,
  SectionCard,
} from './analyticsShared.jsx';
import {
  count,
  formatDateTime,
  useDepartments,
} from './analyticsShared.js';

// ───────────────────────────────────────────────────────────────────────────
// §20 — Scheduled Reports: standing instructions that generate themselves.
//
// Company Admin and Finance may schedule a report monthly, quarterly or
// yearly; BullMQ fires it and MongoDB remembers when it is next due, so a
// Redis restart cannot silently stop a CFO's report.
//
// Who is told is a PERMISSION, not a list of people — the audience stays
// correct as the company changes (§22).
// ───────────────────────────────────────────────────────────────────────────

const REPORTS = [
  { key: 'OVERVIEW', label: 'Monthly payroll summary' },
  { key: 'DEPARTMENT', label: 'Department payroll' },
  { key: 'SALARY_BANDS', label: 'Executive salary distribution' },
  { key: 'STATUTORY', label: 'Statutory summary' },
  { key: 'REGISTER', label: 'Payroll register' },
  { key: 'CTC', label: 'Cost to company' },
  { key: 'TREND', label: 'Payroll trends' },
  { key: 'BONUS', label: 'Bonus & incentive' },
  { key: 'OVERTIME', label: 'Overtime' },
];

const FREQUENCIES = [
  { key: 'MONTHLY', label: 'Monthly' },
  { key: 'QUARTERLY', label: 'Quarterly' },
  { key: 'YEARLY', label: 'Yearly' },
];

const FORMATS = ['XLSX', 'CSV', 'PDF'];

const NOTIFY_PERMISSIONS = [
  { key: '', label: 'Nobody — generate it silently' },
  { key: 'PAYROLL_REPORT_READ', label: 'Everyone who can read payroll reports' },
  { key: 'PAYROLL_ANALYTICS_FINANCIAL', label: 'Finance (financial analytics)' },
  { key: 'PAYROLL_ANALYTICS_SCHEDULE', label: 'Report schedulers' },
];

const RUN_STYLES = {
  SUCCESS: 'bg-emerald-500/15 text-emerald-300',
  FAILED: 'bg-red-500/15 text-red-300',
  NEVER: 'bg-slate-500/15 text-slate-300',
};

const ScheduledReportsPage = () => {
  const { loading: permsLoading, hasPermission } = usePermission();
  const canSchedule = hasPermission('PAYROLL_ANALYTICS_SCHEDULE');

  const departments = useDepartments();
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [banner, setBanner] = useState(null);
  const [busy, setBusy] = useState('');
  const [downloading, setDownloading] = useState('');

  const [draft, setDraft] = useState({
    name: 'Monthly payroll summary',
    reportKey: 'OVERVIEW',
    format: 'XLSX',
    frequency: 'MONTHLY',
    dayOfMonth: 3,
    departmentId: '',
    notifyPermission: 'PAYROLL_REPORT_READ',
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await payrollAnalyticsService.schedules();
      setSchedules(Array.isArray(data) ? data : data?.schedules || []);
      setDenied(false);
    } catch (error) {
      if (error?.status === 403 || error?.status === 401) setDenied(true);
      else setBanner({ type: 'error', text: error?.message || 'Unable to load the schedules' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!permsLoading && canSchedule) load();
    if (!permsLoading && !canSchedule) setLoading(false);
  }, [permsLoading, canSchedule, load]);

  const act = async (label, action, message) => {
    setBusy(label);
    try {
      const result = await action();
      setBanner({ type: 'success', text: typeof message === 'function' ? message(result) : message });
      await load();
    } catch (error) {
      setBanner({ type: 'error', text: error?.message || 'Unable to complete the action' });
    } finally {
      setBusy('');
    }
  };

  const create = () =>
    act('create', () => payrollAnalyticsService.createSchedule({
      name: draft.name,
      reportKey: draft.reportKey,
      format: draft.format,
      frequency: draft.frequency,
      dayOfMonth: Number(draft.dayOfMonth) || 1,
      departmentId: draft.departmentId || undefined,
      notifyPermission: draft.notifyPermission || undefined,
    }), () => 'Report scheduled — it will generate itself from now on');

  const toggle = (row) =>
    act(row._id, () => payrollAnalyticsService.updateSchedule(row._id, { active: !row.active }),
      () => (row.active ? 'Schedule paused' : 'Schedule resumed'));

  const remove = (row) =>
    act(row._id, () => payrollAnalyticsService.deleteSchedule(row._id), () => 'Schedule deleted');

  const download = async (row) => {
    if (!row.lastFileId) return;
    setDownloading(row._id);
    try {
      const blob = await payrollAnalyticsService.downloadFile(row.lastFileId);
      saveBlob(blob, row.lastFilename || 'scheduled-report.xlsx');
    } catch (error) {
      setBanner({ type: 'error', text: error?.message || 'Unable to download this report' });
    } finally {
      setDownloading('');
    }
  };

  if (!permsLoading && !canSchedule) {
    return (
      <div className="p-6">
        <PageHeader
          icon={CalendarClock}
          title="Scheduled Reports"
          subtitle="Reports that generate themselves, monthly, quarterly or yearly"
        />
        <AccessDenied message="Scheduling reports needs Company Admin or Finance access." />
      </div>
    );
  }

  return (
    <div className="p-6">
      <PageHeader
        icon={CalendarClock}
        title="Scheduled Reports"
        subtitle="§20 — standing instructions, generated automatically with BullMQ"
      />

      {banner ? <div className="mb-4"><Banner {...banner} onClose={() => setBanner(null)} /></div> : null}
      {denied ? <AccessDenied message="Your role does not allow scheduling payroll reports." /> : null}

      {/* §20 — new schedule */}
      <SectionCard title="New schedule" subtitle="§20 — who gets it is a permission, not a list of people">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-crewly-dim">
            Name
            <input
              className="rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm normal-case text-crewly-text"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="Monthly payroll summary"
            />
          </label>

          <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-crewly-dim">
            Report
            <select
              className="rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm normal-case text-crewly-text"
              value={draft.reportKey}
              onChange={(event) => setDraft({ ...draft, reportKey: event.target.value })}
            >
              {REPORTS.map((report) => (
                <option key={report.key} value={report.key}>{report.label}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-crewly-dim">
            Frequency
            <select
              className="rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm normal-case text-crewly-text"
              value={draft.frequency}
              onChange={(event) => setDraft({ ...draft, frequency: event.target.value })}
            >
              {FREQUENCIES.map((frequency) => (
                <option key={frequency.key} value={frequency.key}>{frequency.label}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-crewly-dim">
            Day of month
            <input
              type="number"
              min="1"
              max="31"
              className="rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm normal-case text-crewly-text"
              value={draft.dayOfMonth}
              onChange={(event) => setDraft({ ...draft, dayOfMonth: event.target.value })}
            />
          </label>

          <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-crewly-dim">
            Format
            <select
              className="rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm normal-case text-crewly-text"
              value={draft.format}
              onChange={(event) => setDraft({ ...draft, format: event.target.value })}
            >
              {FORMATS.map((format) => (
                <option key={format} value={format}>{format}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-crewly-dim">
            Department
            <select
              className="rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm normal-case text-crewly-text"
              value={draft.departmentId}
              onChange={(event) => setDraft({ ...draft, departmentId: event.target.value })}
            >
              <option value="">Whole company</option>
              {departments.map((department) => (
                <option key={department._id} value={department._id}>{department.name}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-crewly-dim xl:col-span-2">
            Notify
            <select
              className="rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm normal-case text-crewly-text"
              value={draft.notifyPermission}
              onChange={(event) => setDraft({ ...draft, notifyPermission: event.target.value })}
            >
              {NOTIFY_PERMISSIONS.map((option) => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-xs text-crewly-dim">
            A monthly schedule that fires on the 3rd reports on the month that has just closed, not on
            the month that has barely started.
          </p>
          <button
            type="button"
            onClick={create}
            disabled={Boolean(busy) || !draft.name.trim()}
            className="flex items-center gap-1.5 rounded-md bg-sky-500/20 px-3 py-1.5 text-sm text-sky-200 hover:bg-sky-500/30 disabled:opacity-50"
          >
            {busy === 'create' ? <Loader2 size={14} className="animate-spin" /> : <CalendarClock size={14} />}
            Schedule report
          </button>
        </div>
      </SectionCard>

      {/* §20 — the existing schedules */}
      <SectionCard className="mt-4" title="Schedules" subtitle="§20 — every standing instruction in this company">
        {loading ? (
          <p className="text-sm text-crewly-dim">Loading schedules…</p>
        ) : schedules.length ? (
          <DataTable
            headers={[
              { key: 'name', label: 'Schedule', strong: true, render: (row) => (
                <span>
                  {row.name}
                  <span className="block text-xs text-crewly-dim">
                    {REPORTS.find((report) => report.key === row.reportKey)?.label || row.reportKey}
                    {row.department ? ` · ${row.department}` : ''}
                  </span>
                </span>
              ) },
              { key: 'frequency', label: 'Frequency', render: (row) => `${FREQUENCIES.find((entry) => entry.key === row.frequency)?.label || row.frequency} · day ${row.dayOfMonth}` },
              { key: 'format', label: 'Format' },
              { key: 'nextRunAt', label: 'Next run', render: (row) => (row.active ? formatDateTime(row.nextRunAt) : 'Paused') },
              { key: 'lastRunAt', label: 'Last run', render: (row) => (
                <span>
                  {row.lastRunAt ? formatDateTime(row.lastRunAt) : 'Never'}
                  {row.lastRunStatus ? (
                    <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] ${RUN_STYLES[row.lastRunStatus] || RUN_STYLES.NEVER}`}>
                      {row.lastRunStatus}
                    </span>
                  ) : null}
                </span>
              ) },
              { key: 'runCount', label: 'Runs', align: 'right', render: (row) => count(row.runCount) },
              {
                key: 'actions',
                label: '',
                align: 'right',
                render: (row) => (
                  <div className="flex items-center justify-end gap-1">
                    {row.lastFileId ? (
                      <button
                        type="button"
                        disabled={downloading === row._id}
                        onClick={() => download(row)}
                        className="rounded-md border border-white/10 px-2 py-1 text-xs text-crewly-text hover:bg-white/5 disabled:opacity-40"
                        title="Download the last generated report"
                      >
                        {downloading === row._id ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={busy === row._id}
                      onClick={() => toggle(row)}
                      className="rounded-md border border-white/10 px-2 py-1 text-xs text-crewly-text hover:bg-white/5 disabled:opacity-40"
                      title={row.active ? 'Pause' : 'Resume'}
                    >
                      {row.active ? <Pause size={12} /> : <Play size={12} />}
                    </button>
                    <button
                      type="button"
                      disabled={busy === row._id}
                      onClick={() => remove(row)}
                      className="rounded-md border border-white/10 px-2 py-1 text-xs text-red-300 hover:bg-white/5 disabled:opacity-40"
                      title="Delete"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ),
              },
            ]}
            rows={schedules}
            empty="No scheduled reports yet"
          />
        ) : (
          <p className="text-sm text-crewly-dim">No scheduled reports yet — create one above.</p>
        )}
        {schedules.some((row) => row.lastRunStatus === 'FAILED') ? (
          <div className="mt-3">
            <Banner
              type="warn"
              text="A schedule failed on its last run. It is still armed for the next period, so it will try again — check the payroll data for that month if it keeps failing."
            />
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
};

export default ScheduledReportsPage;
