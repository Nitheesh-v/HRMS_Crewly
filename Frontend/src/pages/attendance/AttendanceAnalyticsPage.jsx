// Phase 31.15 — Attendance Reports & Analytics. READ-ONLY reporting
// surface over the resolved-daily layer (§31.10) and finalized
// snapshots (§31.11). Five tabs: Overview KPIs, monthly Trends,
// the Employee breakdown table, My summary (self-service) and the
// read-only Payroll reconciliation. Every number carries its
// provenance — FINALIZED snapshot version or LIVE/PROVISIONAL
// open-month facts — and the page never mutates attendance,
// leave, OT or payroll. No rankings, no scores, no predictions:
// the employee table default-orders by name and every column
// sort is an explicit, unranked sort.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  Building2,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  FileSpreadsheet,
  FileText,
  Filter,
  MapPin,
  RefreshCw,
  Timer,
  TriangleAlert,
  User,
  Users,
  X,
} from 'lucide-react';
import attendanceService from '../../services/attendanceService.js';
import attendanceLocationService from '../../services/attendanceLocationService.js';
import departmentService from '../../services/departmentService.js';
import scheduleService from '../../services/scheduleService.js';
import usePermission from '../../hooks/usePermission.js';

const TABS = [
  ['overview', 'Overview', BarChart3],
  ['trends', 'Trends', CalendarDays],
  ['employees', 'Employees', Users],
  ['mine', 'My summary', User],
  ['reconciliation', 'Payroll reconciliation', FileText],
];

const PAGE_SIZE = 25;

const SORT_COLUMNS = [
  ['name', 'Employee'],
  ['employeeCode', 'Code'],
  ['workedUnits', 'Worked'],
  ['absentUnits', 'Absent'],
  ['attendanceRate', 'Attendance %'],
  ['workedMinutes', 'Worked min'],
  ['lateOccurrences', 'Late'],
];

const RECON_STYLES = {
  MATCH: 'bg-emerald-400/15 text-emerald-300',
  MISMATCH: 'bg-crewly-red/15 text-crewly-red',
  NOT_SYNCED: 'bg-crewly-orange/15 text-crewly-orange',
  NOT_FINALIZED: 'bg-blue-400/15 text-blue-300',
};

const currentMonth = () => new Date().toISOString().slice(0, 7);

const fmtPct = (rate) => {
  if (!rate || rate.pct === null || rate.pct === undefined) return '—';
  return `${rate.pct}%`;
};

const fmtHours = (minutes) => {
  if (minutes === null || minutes === undefined) return '—';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
};

const fmtUnits = (value) => {
  if (value === null || value === undefined) return '—';
  return Number(value).toLocaleString('en-IN', { maximumFractionDigits: 1 });
};

const Kpi = ({ icon, label, value, sub }) => (
  <div className="card">
    <div className="flex items-center gap-2 text-xs text-crewly-dim">
      {icon}
      <span>{label}</span>
    </div>
    <div className="pt-1 text-2xl font-semibold">{value}</div>
    {sub && <div className="text-xs text-crewly-dim">{sub}</div>}
  </div>
);

// Provenance banner: every covered month names its source — the
// FINALIZED snapshot version (payroll-grade truth) or the LIVE
// open-month projection. Shown above every tab's numbers.
const SourceBanner = ({ provenance, range }) => {
  if (!provenance || !provenance.length) return null;
  return (
    <div className="card flex flex-wrap items-center gap-2 text-sm">
      <span className="inline-flex items-center gap-1 text-crewly-dim">
        <FileText size={14} /> Source:
      </span>
      {provenance.map((row) => (
        <span
          key={row.month}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
            row.finalized ? 'bg-emerald-400/15 text-emerald-300' : 'bg-crewly-orange/15 text-crewly-orange'
          }`}
          title={row.finalized ? `Finalized snapshot v${row.version}` : 'Live open-month projection'}
        >
          {row.finalized ? <CheckCircle2 size={12} /> : <TriangleAlert size={12} />}
          {row.month} · {row.finalized ? `FINALIZED v${row.version}` : 'LIVE'}
        </span>
      ))}
      {range?.from && (
        <span className="ml-auto text-xs text-crewly-dim">
          {range.from} → {range.to}
        </span>
      )}
    </div>
  );
};

const ShareBar = ({ pct }) => (
  <div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
    <div className="h-full rounded-full bg-crewly-accent" style={{ width: `${Math.min(100, pct || 0)}%` }} />
  </div>
);

const AttendanceAnalyticsPage = () => {
  const { hasPermission, loading: permissionsLoading } = usePermission();
  const canAnalyze = hasPermission('ATTENDANCE_ANALYTICS_READ');
  const canSelf = hasPermission('ATTENDANCE_READ_SELF');

  const [tab, setTab] = useState('overview');
  const [month, setMonth] = useState(currentMonth());
  const [preset, setPreset] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [shiftId, setShiftId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [workMode, setWorkMode] = useState('');

  const [departments, setDepartments] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [locations, setLocations] = useState([]);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState('');

  // Employees tab state (server-paginated, allowlisted sort).
  const [sort, setSort] = useState('name');
  const [page, setPage] = useState(1);

  const filters = useMemo(
    () => ({
      ...(preset ? { preset, month } : { month }),
      ...(departmentId ? { departmentId } : {}),
      ...(shiftId ? { shiftId } : {}),
      ...(locationId ? { locationId } : {}),
      ...(workMode ? { workMode } : {}),
    }),
    [preset, month, departmentId, shiftId, locationId, workMode]
  );

  const load = useCallback(async () => {
    if (tab !== 'mine' && !canAnalyze) return;
    if (tab === 'mine' && !canAnalyze && !canSelf) return;
    setLoading(true);
    setError('');
    try {
      let result = null;
      if (tab === 'overview') result = await attendanceService.analyticsOverview(filters);
      else if (tab === 'trends') result = await attendanceService.analyticsTrends(filters);
      else if (tab === 'employees') {
        result = await attendanceService.analyticsEmployees({ ...filters, sort, page, pageSize: PAGE_SIZE });
      } else if (tab === 'mine') {
        result = await attendanceService.analyticsMine(preset ? { preset, month } : { month });
      } else if (tab === 'reconciliation') {
        result = await attendanceService.analyticsReconciliation(month);
      }
      setData(result?.data ?? result ?? null);
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Failed to load analytics');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [tab, filters, sort, page, month, preset, canAnalyze, canSelf]);

  useEffect(() => {
    departmentService.getAll().then(setDepartments).catch(() => {});
    scheduleService.listShifts().then(setShifts).catch(() => {});
    attendanceLocationService.list().then(setLocations).catch(() => {});
  }, []);

  useEffect(() => {
    setPage(1);
  }, [tab, month, preset, departmentId, shiftId, locationId, workMode, sort]);

  useEffect(() => {
    if (!permissionsLoading) load();
  }, [load, permissionsLoading]);

  const toggleSort = (field) => {
    setSort((prev) => {
      if (prev === field) return `-${field}`;
      if (prev === `-${field}`) return 'name';
      return field;
    });
  };

  const sortIcon = (field) => {
    if (sort === field) return <ArrowUp size={12} className="inline" />;
    if (sort === `-${field}`) return <ArrowDown size={12} className="inline" />;
    return <ArrowUpDown size={12} className="inline opacity-40" />;
  };

  const runExport = async (reportType, format) => {
    const key = `${reportType}:${format}`;
    setExporting(key);
    setError('');
    try {
      await attendanceService.downloadAnalytics({ reportType, format, ...filters });
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Export failed');
    } finally {
      setExporting('');
    }
  };

  const clearFilters = () => {
    setPreset('');
    setDepartmentId('');
    setShiftId('');
    setLocationId('');
    setWorkMode('');
  };

  const hasFilters = preset || departmentId || shiftId || locationId || workMode;
  const totals = data?.totals || null;
  const visibleTabs = TABS.filter(([key]) => {
    if (key === 'mine') return canAnalyze || canSelf;
    return canAnalyze;
  });

  // Self-service audience (no analytics permission) lands on — and
  // only ever sees — the My summary tab.
  useEffect(() => {
    if (!permissionsLoading && !canAnalyze && canSelf) setTab('mine');
  }, [permissionsLoading, canAnalyze, canSelf]);

  if (permissionsLoading) {
    return <div className="card text-sm text-crewly-dim">Loading attendance analytics…</div>;
  }

  if (!canAnalyze && !canSelf) {
    return (
      <div className="card text-sm">
        <h1 className="text-xl font-semibold">Attendance Analytics</h1>
        <p className="pt-2 text-crewly-dim">
          Your role doesn&apos;t include attendance analytics. Ask an administrator for access if you need it.
        </p>
      </div>
    );
  }

  const renderFilterBar = (showRange = true) => (
    <div className="card flex flex-wrap items-center gap-2 text-sm">
      <span className="inline-flex items-center gap-1 text-crewly-dim">
        <Filter size={14} /> Filters:
      </span>
      {showRange && (
        <>
          <input
            type="month"
            className="input max-w-[11rem]"
            value={month}
            max={currentMonth()}
            onChange={(event) => setMonth(event.target.value || currentMonth())}
            aria-label="Month"
          />
          <select className="input max-w-[10rem]" value={preset} onChange={(event) => setPreset(event.target.value)} aria-label="Range preset">
            <option value="">Single month</option>
            <option value="quarter">Quarter (anchored)</option>
            <option value="fy">Financial year (anchored)</option>
          </select>
        </>
      )}
      {tab !== 'mine' && tab !== 'reconciliation' && (
        <>
          <select className="input max-w-[12rem]" value={departmentId} onChange={(event) => setDepartmentId(event.target.value)} aria-label="Department">
            <option value="">All departments</option>
            {departments.map((dept) => (
              <option key={dept._id || dept.id} value={dept._id || dept.id}>{dept.name}</option>
            ))}
          </select>
          <select className="input max-w-[12rem]" value={shiftId} onChange={(event) => setShiftId(event.target.value)} aria-label="Shift">
            <option value="">All shifts</option>
            {shifts.map((shift) => (
              <option key={shift._id || shift.id} value={shift._id || shift.id}>{shift.name}</option>
            ))}
          </select>
          <select className="input max-w-[12rem]" value={locationId} onChange={(event) => setLocationId(event.target.value)} aria-label="Location">
            <option value="">All locations</option>
            {locations.map((loc) => (
              <option key={loc._id || loc.id} value={loc._id || loc.id}>{loc.name}</option>
            ))}
          </select>
          <select className="input max-w-[11rem]" value={workMode} onChange={(event) => setWorkMode(event.target.value)} aria-label="Work mode">
            <option value="">All modes</option>
            <option value="OFFICE">Office</option>
            <option value="WFH">WFH</option>
            <option value="FIELD">Field</option>
            <option value="CLIENT_SITE">Client site</option>
            <option value="BUSINESS_TRAVEL">Travel</option>
          </select>
        </>
      )}
      {hasFilters && (
        <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={clearFilters}>
          <X size={12} className="inline" /> Clear
        </button>
      )}
    </div>
  );

  const renderTotalsKpis = () => {
    if (!totals) return null;
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi icon={<Users size={14} />} label="Attendance rate" value={fmtPct(totals.attendanceRate)} sub={`${fmtUnits(totals.workedUnits)} / ${fmtUnits(totals.scheduledUnits)} scheduled units`} />
        <Kpi icon={<Clock size={14} />} label="Absence rate" value={fmtPct(totals.absenceRate)} sub={`${fmtUnits(totals.absentUnits)} absent units`} />
        <Kpi icon={<Timer size={14} />} label="Effective worked" value={fmtHours(totals.workedMinutes)} sub={totals.averageWorkedMinutes ? `avg ${fmtHours(totals.averageWorkedMinutes)} / session day` : `${totals.sessionDays || 0} session days`} />
        <Kpi icon={<TriangleAlert size={14} />} label="Late arrivals" value={totals.lateOccurrences ?? 0} sub={`${totals.lateMinutes || 0} min late · ${totals.earlyOccurrences || 0} early exits`} />
      </div>
    );
  };

  const renderOverview = () => {
    if (!data) return null;
    const dayCounts = totals?.dayCounts || {};
    const modes = totals?.modes || {};
    const sources = data.sources || { counts: {}, total: 0, pcts: {} };
    const ot = data.overtime || {};
    const regs = data.regularizations || {};
    const sourceEntries = Object.entries(sources.counts || {});
    return (
      <div className="space-y-4">
        <SourceBanner provenance={data.provenance} range={data.range} />
        {renderTotalsKpis()}
        <div className="grid gap-3 lg:grid-cols-3">
          <div className="card text-sm">
            <h2 className="font-semibold">Day outcomes</h2>
            <div className="grid grid-cols-2 gap-2 pt-2">
              {[
                ['Present', dayCounts.present],
                ['Half day', dayCounts.halfDay],
                ['Absent', dayCounts.absent],
                ['Leave', dayCounts.leave],
                ['Holiday', dayCounts.holiday],
                ['Weekly off', dayCounts.weeklyOff],
                ['Unresolved', dayCounts.unresolved],
                ['Missing punch days', totals?.missingPunchDays],
              ].map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-2 rounded bg-white/5 px-2 py-1">
                  <span className="text-crewly-dim">{label}</span>
                  <span className="font-semibold">{value ?? 0}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="card text-sm">
            <h2 className="font-semibold">Work modes</h2>
            <div className="space-y-2 pt-2">
              {Object.entries(modes).map(([mode, count]) => (
                <div key={mode} className="flex items-center justify-between gap-2">
                  <span className="text-crewly-dim">{mode.replace(/_/g, ' ')}</span>
                  <span className="font-semibold">{count ?? 0}</span>
                </div>
              ))}
              {!Object.keys(modes).length && <p className="text-crewly-dim">No session days in range.</p>}
            </div>
            <h2 className="pt-4 font-semibold">Capture source</h2>
            <div className="space-y-2 pt-2">
              {sourceEntries.map(([source, count]) => (
                <div key={source} className="flex items-center justify-between gap-2">
                  <span className="text-crewly-dim">{source}</span>
                  <span className="flex items-center gap-2">
                    <ShareBar pct={sources.pcts?.[source]} />
                    <span className="font-semibold">{count}</span>
                  </span>
                </div>
              ))}
              {!sourceEntries.length && <p className="text-crewly-dim">No punches in range.</p>}
            </div>
          </div>
          <div className="card space-y-4 text-sm">
            <div>
              <h2 className="font-semibold">Overtime (TIME only)</h2>
              <p className="pt-1 text-crewly-dim">
                Approved {fmtHours(ot.approvedMinutes)} · {ot.approved || 0} approved · {ot.pending || 0} pending
              </p>
              <p className="text-xs text-crewly-dim">Money never appears here — payroll owns payouts.</p>
            </div>
            <div>
              <h2 className="font-semibold">Regularizations</h2>
              <p className="pt-1 text-crewly-dim">
                {regs.submitted || 0} submitted · {regs.approved || 0} approved · {regs.rejected || 0} rejected · {regs.pending || 0} pending
              </p>
              <Link className="text-xs underline" to="/app/attendance/regularizations">Open exception center</Link>
            </div>
            <div>
              <h2 className="font-semibold">Locations</h2>
              <div className="space-y-1 pt-1">
                {(data.locations?.locations || []).slice(0, 6).map((row) => (
                  <div key={row.locationId || 'unassigned'} className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1 text-crewly-dim">
                      <MapPin size={12} /> {row.locationName}
                    </span>
                    <span className="font-semibold">{row.events}</span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-crewly-dim">{data.locations?.totalEvents || 0} punch events in range.</p>
            </div>
          </div>
        </div>
        <div className="card flex flex-wrap items-center gap-2 text-sm">
          <span className="inline-flex items-center gap-1 text-crewly-dim">
            <Download size={14} /> Export this report:
          </span>
          <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={!!exporting} onClick={() => runExport('employees', 'csv')}>
            <FileText size={12} className="inline" /> {exporting === 'employees:csv' ? 'Exporting…' : 'Employees CSV'}
          </button>
          <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={!!exporting} onClick={() => runExport('employees', 'xlsx')}>
            <FileSpreadsheet size={12} className="inline" /> {exporting === 'employees:xlsx' ? 'Exporting…' : 'Employees XLSX'}
          </button>
          <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={!!exporting} onClick={() => runExport('reconciliation', 'csv')}>
            <FileText size={12} className="inline" /> {exporting === 'reconciliation:csv' ? 'Exporting…' : 'Reconciliation CSV'}
          </button>
        </div>
      </div>
    );
  };

  const renderTrends = () => {
    if (!data) return null;
    const months = data.months || [];
    const maxPct = Math.max(100, ...months.map((row) => row.totals?.attendanceRate?.pct || 0));
    return (
      <div className="space-y-4">
        <SourceBanner provenance={data.provenance} range={data.range} />
        <div className="card text-sm">
          <h2 className="font-semibold">Monthly attendance %</h2>
          <p className="text-xs text-crewly-dim">Up to 12 months back. Each bar names its source — finalized bars are snapshot truth, live bars move until finalization.</p>
          {months.length > 0 && (
            <svg viewBox={`0 0 ${months.length * 64 + 16} 190`} className="mt-3 w-full" role="img" aria-label="Monthly attendance rate chart">
              <line x1="8" y1="150" x2={months.length * 64 + 8} y2="150" stroke="currentColor" strokeOpacity="0.2" />
              {[25, 50, 75, 100].map((tick) => (
                <g key={tick}>
                  <line x1="8" y1={150 - (tick / maxPct) * 130} x2={months.length * 64 + 8} y2={150 - (tick / maxPct) * 130} stroke="currentColor" strokeOpacity="0.08" />
                  <text x="4" y={153 - (tick / maxPct) * 130} fontSize="8" fill="currentColor" opacity="0.5" textAnchor="start">{tick}</text>
                </g>
              ))}
              {months.map((row, index) => {
                const pct = row.totals?.attendanceRate?.pct ?? null;
                const height = pct === null ? 2 : Math.max(2, (pct / maxPct) * 130);
                const x = 16 + index * 64;
                return (
                  <g key={row.month}>
                    <rect
                      x={x}
                      y={150 - height}
                      width="40"
                      height={height}
                      rx="3"
                      className={row.finalized ? 'fill-emerald-400/70' : 'fill-crewly-orange/70'}
                    >
                      <title>{`${row.month}: ${pct === null ? 'no scheduled days' : `${pct}%`} (${row.finalized ? 'finalized' : 'live'})`}</title>
                    </rect>
                    <text x={x + 20} y={146 - height} fontSize="9" fill="currentColor" textAnchor="middle">
                      {pct === null ? '—' : `${pct}%`}
                    </text>
                    <text x={x + 20} y="163" fontSize="8" fill="currentColor" opacity="0.7" textAnchor="middle">
                      {row.month.slice(2)}
                    </text>
                    <text x={x + 20} y="174" fontSize="7" fill="currentColor" opacity="0.5" textAnchor="middle">
                      {row.finalized ? 'FINAL' : 'LIVE'}
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
          {!months.length && <p className="pt-2 text-crewly-dim">No months in range.</p>}
        </div>
        <div className="card overflow-x-auto text-sm">
          <table className="w-full min-w-[42rem]">
            <thead>
              <tr className="text-left text-xs text-crewly-dim">
                <th className="px-2 py-1">Month</th>
                <th className="px-2 py-1">Source</th>
                <th className="px-2 py-1 text-right">Attendance %</th>
                <th className="px-2 py-1 text-right">Absence %</th>
                <th className="px-2 py-1 text-right">Worked units</th>
                <th className="px-2 py-1 text-right">Scheduled units</th>
                <th className="px-2 py-1 text-right">Effective worked</th>
              </tr>
            </thead>
            <tbody>
              {months.map((row) => (
                <tr key={row.month} className="border-t border-white/5">
                  <td className="px-2 py-1 font-medium">{row.month}</td>
                  <td className="px-2 py-1">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${row.finalized ? 'bg-emerald-400/15 text-emerald-300' : 'bg-crewly-orange/15 text-crewly-orange'}`}>
                      {row.finalized ? 'FINALIZED' : 'LIVE'}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-right">{fmtPct(row.totals?.attendanceRate)}</td>
                  <td className="px-2 py-1 text-right">{fmtPct(row.totals?.absenceRate)}</td>
                  <td className="px-2 py-1 text-right">{fmtUnits(row.totals?.workedUnits)}</td>
                  <td className="px-2 py-1 text-right">{fmtUnits(row.totals?.scheduledUnits)}</td>
                  <td className="px-2 py-1 text-right">{fmtHours(row.totals?.workedMinutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderEmployees = () => {
    if (!data) return null;
    const rows = data.rows || [];
    return (
      <div className="space-y-4">
        <SourceBanner provenance={data.provenance} range={data.range} />
        <div className="card overflow-x-auto text-sm">
          <table className="w-full min-w-[60rem]">
            <thead>
              <tr className="text-left text-xs text-crewly-dim">
                {SORT_COLUMNS.map(([field, label]) => (
                  <th key={field} className="px-2 py-1">
                    <button type="button" className="inline-flex items-center gap-1 hover:underline" onClick={() => toggleSort(field)}>
                      {label} {sortIcon(field)}
                    </button>
                  </th>
                ))}
                <th className="px-2 py-1 text-right">Avg / day</th>
                <th className="px-2 py-1 text-right">Late min</th>
                <th className="px-2 py-1 text-right">Missing punches</th>
                <th className="px-2 py-1 text-right">OT min</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.employeeId} className="border-t border-white/5">
                  <td className="px-2 py-1">
                    <div className="font-medium">{row.name}</div>
                    <div className="text-xs text-crewly-dim">{row.department?.name || row.designation || ''}</div>
                  </td>
                  <td className="px-2 py-1 text-crewly-dim">{row.employeeCode || '—'}</td>
                  <td className="px-2 py-1">{fmtUnits(row.workedUnits)}</td>
                  <td className="px-2 py-1">{fmtUnits(row.absentUnits)}</td>
                  <td className="px-2 py-1 font-semibold">{fmtPct(row.attendanceRate)}</td>
                  <td className="px-2 py-1">{fmtHours(row.workedMinutes)}</td>
                  <td className="px-2 py-1 text-right">{fmtHours(row.averageWorkedMinutes)}</td>
                  <td className="px-2 py-1 text-right">{row.lateMinutes ?? 0}</td>
                  <td className="px-2 py-1 text-right">{row.missingPunchDays ?? 0}</td>
                  <td className="px-2 py-1 text-right">{row.approvedOtMinutes ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <p className="p-3 text-crewly-dim">No employees in scope for this range.</p>}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-crewly-dim">
            Page {data.page || 1} of {data.totalPages || 1} · {data.total || 0} employees
          </span>
          <div className="flex items-center gap-2">
            <button type="button" className="btn-ghost px-2 py-1" disabled={(data.page || 1) <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Previous page">
              <ChevronLeft size={14} />
            </button>
            <button
              type="button"
              className="btn-ghost px-2 py-1"
              disabled={(data.page || 1) >= (data.totalPages || 1)}
              onClick={() => setPage((p) => p + 1)}
              aria-label="Next page"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderMine = () => {
    if (!data) return null;
    return (
      <div className="space-y-4">
        <SourceBanner provenance={data.provenance} range={data.range} />
        {renderTotalsKpis()}
        <div className="card text-sm">
          <h2 className="font-semibold">My day outcomes</h2>
          <div className="grid grid-cols-2 gap-2 pt-2 sm:grid-cols-4">
            {[
              ['Present', totals?.dayCounts?.present],
              ['Half day', totals?.dayCounts?.halfDay],
              ['Absent', totals?.dayCounts?.absent],
              ['Leave', totals?.dayCounts?.leave],
              ['Holiday', totals?.dayCounts?.holiday],
              ['Weekly off', totals?.dayCounts?.weeklyOff],
              ['Unresolved', totals?.dayCounts?.unresolved],
              ['Missing punch days', totals?.missingPunchDays],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-2 rounded bg-white/5 px-2 py-1">
                <span className="text-crewly-dim">{label}</span>
                <span className="font-semibold">{value ?? 0}</span>
              </div>
            ))}
          </div>
          <p className="pt-3 text-xs text-crewly-dim">
            Day-by-day detail lives on <Link className="underline" to="/app/attendance/timesheet">My Timesheet</Link>.
          </p>
        </div>
      </div>
    );
  };

  const renderReconciliation = () => {
    if (!data) return null;
    const summary = data.summary || {};
    const rows = data.rows || [];
    return (
      <div className="space-y-4">
        <div className="card flex flex-wrap items-center gap-2 text-sm">
          <span className="inline-flex items-center gap-1 text-crewly-dim">
            <Building2 size={14} /> {data.month} · period {data.periodStatus}
          </span>
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${data.finalized ? 'bg-emerald-400/15 text-emerald-300' : 'bg-crewly-orange/15 text-crewly-orange'}`}>
            {data.finalized ? `FINALIZED v${data.currentVersion}` : 'NOT FINALIZED'}
          </span>
          {Object.entries(summary).map(([status, count]) => (
            <span key={status} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${RECON_STYLES[status] || 'bg-white/10'}`}>
              {status}: {count}
            </span>
          ))}
          <span className="ml-auto text-xs text-crewly-dim">Read-only — HR-owned payroll entries are never compared.</span>
        </div>
        <div className="card overflow-x-auto text-sm">
          <table className="w-full min-w-[52rem]">
            <thead>
              <tr className="text-left text-xs text-crewly-dim">
                <th className="px-2 py-1">Employee</th>
                <th className="px-2 py-1">Status</th>
                <th className="px-2 py-1 text-right">Snapshot v</th>
                <th className="px-2 py-1 text-right">Current v</th>
                <th className="px-2 py-1">Synced at</th>
                <th className="px-2 py-1">Differences</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.employeeId} className="border-t border-white/5">
                  <td className="px-2 py-1">
                    <div className="font-medium">{row.name}</div>
                    <div className="text-xs text-crewly-dim">{row.department?.name || row.employeeCode || ''}</div>
                  </td>
                  <td className="px-2 py-1">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${RECON_STYLES[row.status] || 'bg-white/10'}`}>
                      {row.status}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-right">{row.snapshotVersion ?? '—'}</td>
                  <td className="px-2 py-1 text-right">{row.currentVersion ?? '—'}</td>
                  <td className="px-2 py-1 text-xs text-crewly-dim">
                    {row.syncedAt ? new Date(row.syncedAt).toLocaleString('en-IN') : '—'}
                  </td>
                  <td className="px-2 py-1 text-xs">
                    {(row.diffs || []).length === 0 ? (
                      <span className="text-crewly-dim">—</span>
                    ) : (
                      <ul className="list-disc pl-4">
                        {row.diffs.map((diff, index) => (
                          <li key={`${diff.field || index}`}>
                            {diff.field}: expected {String(diff.expected ?? '—')} · actual {String(diff.actual ?? '—')}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <p className="p-3 text-crewly-dim">No employees in scope for this month.</p>}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Attendance Analytics</h1>
          <p className="text-sm text-crewly-dim">
            Read-only reports over {tab === 'mine' ? 'your own' : 'scoped'} attendance facts — finalized snapshots where they exist, live projections otherwise.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-ghost px-2 py-1" onClick={() => load()} aria-label="Refresh now">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {visibleTabs.map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm ${
              tab === key ? 'bg-crewly-accent text-white' : 'bg-white/5 text-crewly-dim hover:bg-white/10'
            }`}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {renderFilterBar(tab !== 'reconciliation')}
      {tab === 'reconciliation' && (
        <div className="card flex flex-wrap items-center gap-2 text-sm">
          <span className="inline-flex items-center gap-1 text-crewly-dim">
            <Filter size={14} /> Month:
          </span>
          <input
            type="month"
            className="input max-w-[11rem]"
            value={month}
            max={currentMonth()}
            onChange={(event) => setMonth(event.target.value || currentMonth())}
            aria-label="Month"
          />
        </div>
      )}

      {error && (
        <div className="card text-sm text-crewly-red">
          {error} <button type="button" className="underline" onClick={() => load()}>Retry</button>
        </div>
      )}

      {loading && !data && <div className="card text-sm text-crewly-dim">Loading analytics…</div>}

      {!loading && !error && data && (
        <>
          {tab === 'overview' && renderOverview()}
          {tab === 'trends' && renderTrends()}
          {tab === 'employees' && renderEmployees()}
          {tab === 'mine' && renderMine()}
          {tab === 'reconciliation' && renderReconciliation()}
        </>
      )}
    </div>
  );
};

export default AttendanceAnalyticsPage;
