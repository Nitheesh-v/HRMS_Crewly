import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Coffee,
  Filter,
  MapPin,
  RefreshCw,
  Search,
  Timer,
  UserX,
  Users,
  X,
} from 'lucide-react';
import attendanceService from '../../services/attendanceService.js';
import departmentService from '../../services/departmentService.js';
import usePermission from '../../hooks/usePermission.js';
import TimesheetMonthView from '../../components/attendance/TimesheetMonthView.jsx';

// Phase 31.12 — HR Attendance Operations dashboard. READ-ONLY
// command center over 31.9 presence facts: today's expected
// workforce, live attendance, work-mode / department / shift /
// location breakdowns, the needs-attention queue and the pending
// regularization / OT workload. Every issue links to its owner
// workflow — nothing here mutates attendance, leave, OT or
// payroll. Time facts only: no reasons, no money, no scores.

const REFRESH_MS = 45000;
const PAGE_SIZE = 25;

const WORKFLOWS = {
  attendance: { to: '/app/attendance/team', label: "Who's Working" },
  regularizations: { to: '/app/attendance/regularizations', label: 'Regularizations' },
  leaves: { to: '/app/leaves', label: 'Leaves' },
  overtime: { to: '/app/attendance/overtime', label: 'Overtime & Comp-Off' },
  schedules: { to: '/app/schedules', label: 'Schedules' },
};

const CATEGORIES = [
  ['LATE_NOT_IN', 'Late — not in'],
  ['LATE_ARRIVAL', 'Late arrival'],
  ['MISSING_PUNCH', 'Missing punch'],
  ['UNRESOLVED_SESSION', 'Unresolved session'],
  ['INCOMPLETE_BREAK', 'Break left open'],
  ['EARLY_EXIT', 'Early exit'],
  ['SHORT_HOURS', 'Short hours'],
  ['RECON_CONFLICT', 'Attendance/leave conflict'],
  ['REG_PENDING', 'Regularization pending'],
  ['OT_PENDING', 'OT review pending'],
  ['WORKED_DAY_OFF', 'Worked day off'],
];

const SEVERITY_STYLES = {
  BLOCKER: 'bg-crewly-red/15 text-crewly-red',
  WARNING: 'bg-crewly-orange/15 text-crewly-orange',
  INFO: 'bg-blue-400/15 text-blue-300',
};

const MODES = [
  ['OFFICE', 'Office'],
  ['WFH', 'WFH'],
  ['FIELD', 'Field'],
  ['CLIENT_SITE', 'Client site'],
  ['BUSINESS_TRAVEL', 'Travel'],
];

const PRESENCES = [
  'WORKING', 'ON_BREAK', 'COMPLETED', 'NOT_IN', 'LATE_NOT_IN',
  'ON_LEAVE', 'HOLIDAY', 'WEEKLY_OFF', 'UNRESOLVED',
];

const fmtTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const fmtDateTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
};

const prevDay = (day) => {
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return '';
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
};

const KpiCard = ({ icon: Icon, label, value, sub = '' }) => (
  <div className="card">
    <div className="flex items-center gap-2 text-xs text-crewly-dim">
      <Icon size={14} /> {label}
    </div>
    <div className="pt-1 text-2xl font-semibold">{value}</div>
    {sub && <div className="text-xs text-crewly-dim">{sub}</div>}
  </div>
);

const AttendanceOperationsPage = () => {
  const { hasPermission, loading: permissionsLoading } = usePermission();
  const canView = hasPermission('ATTENDANCE_OPERATIONS_READ');

  const [dateOverride, setDateOverride] = useState('');
  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [shift, setShift] = useState('');
  const [location, setLocation] = useState('');
  const [presence, setPresence] = useState('');
  const [workMode, setWorkMode] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [groupTab, setGroupTab] = useState('departments');

  const [dash, setDash] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const load = useCallback(async ({ silent = false } = {}) => {
    if (silent) setRefreshing(true);
    else {
      setLoading(true);
      setError('');
    }
    try {
      setDash(await attendanceService.operations({
        date: dateOverride,
        search: search.trim(),
        departmentId,
        shift: shift.trim(),
        location,
        presence,
        workMode,
        category,
        page,
        pageSize: PAGE_SIZE,
      }));
    } catch (err) {
      if (!silent) {
        setDash(null);
        setError(err?.response?.data?.message || err.message || 'Failed to load operations');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [dateOverride, search, departmentId, shift, location, presence, workMode, category, page]);

  useEffect(() => {
    if (!canView) {
      setLoading(false);
      return;
    }
    load();
  }, [canView, load]);

  // Bounded live refresh: every 45s while the tab is visible, on
  // refocus, and on manual request. Hidden tabs never poll.
  useEffect(() => {
    if (!canView) return undefined;
    const poll = () => {
      if (!document.hidden) load({ silent: true });
    };
    const onVisibility = () => {
      if (!document.hidden) load({ silent: true });
    };
    const timer = setInterval(poll, REFRESH_MS);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
    };
  }, [canView, load]);

  useEffect(() => {
    departmentService.getAll().then(setDepartments).catch(() => {});
  }, []);

  useEffect(() => {
    setPage(1);
    setSelected(null);
    setDetail(null);
  }, [dateOverride, search, departmentId, shift, location, presence, workMode, category]);

  const openDetail = async (item) => {
    if (selected?.id === item.employee.id) {
      setSelected(null);
      setDetail(null);
      return;
    }
    setSelected({ id: item.employee.id, name: item.employee.name, item });
    setDetail(null);
    setDetailLoading(true);
    setDetailError('');
    try {
      setDetail(await attendanceService.employeeTimesheet(
        item.employee.id,
        (dash?.date || '').slice(0, 7),
      ));
    } catch (err) {
      setDetailError(err?.response?.data?.message || err.message || 'Failed to load employee month');
    } finally {
      setDetailLoading(false);
    }
  };

  if (permissionsLoading || (loading && !dash)) {
    return <div className="card text-sm text-crewly-dim">Loading attendance operations…</div>;
  }

  if (!canView) {
    return (
      <div className="card text-sm">
        <h1 className="text-xl font-semibold">Attendance Operations</h1>
        <p className="pt-2 text-crewly-dim">
          This command center is available to HR administrators only.
        </p>
      </div>
    );
  }

  const summary = dash?.summary || {};
  const modes = dash?.modes || {};
  const counts = dash?.attentionCounts || {};
  const attention = dash?.attention || { items: [], page: 1, totalPages: 1, total: 0 };
  const workflows = dash?.workflows || {};
  const notYetIn = (summary.notIn || 0) + (summary.lateNotIn || 0);
  const viewingYesterday = Boolean(dateOverride);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Attendance Operations</h1>
          <p className="text-sm text-crewly-dim">
            {dash?.date || '—'} · {dash?.scope?.type === 'COMPANY' ? 'whole company' : 'your team'}
            {' '}· scope {dash?.scope?.total ?? '—'}
            {' '}· refreshed {refreshing ? '…' : fmtDateTime(dash?.refreshedAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={viewingYesterday ? 'btn-ghost px-3 py-1 text-sm' : 'btn-primary px-3 py-1 text-sm'}
            onClick={() => setDateOverride('')}
          >
            Today
          </button>
          <button
            type="button"
            className={viewingYesterday ? 'btn-primary px-3 py-1 text-sm' : 'btn-ghost px-3 py-1 text-sm'}
            disabled={!dash?.date}
            onClick={() => dash?.date && setDateOverride(prevDay(dash.date))}
            title="Review yesterday at end of day"
          >
            Yesterday
          </button>
          <button type="button" className="btn-ghost px-2 py-1" onClick={() => load()} aria-label="Refresh now">
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {error && (
        <div className="card text-sm text-crewly-red">
          {error} <button type="button" className="underline" onClick={() => load()}>Retry</button>
        </div>
      )}

      {dash && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <KpiCard icon={Users} label="Expected today" value={summary.expected ?? '—'} sub={`${summary.applicable ?? '—'} applicable · ${summary.nonWorking ?? '—'} off`} />
            <KpiCard icon={Clock} label="Working now" value={summary.working ?? '—'} sub={`${summary.onBreak ?? '—'} on break · ${summary.completed ?? '—'} done`} />
            <KpiCard icon={UserX} label="On leave" value={summary.onLeave ?? '—'} sub={`${summary.holiday ?? '—'} holiday · ${summary.weeklyOff ?? '—'} weekly off`} />
            <KpiCard icon={Timer} label="Not yet in" value={notYetIn} sub={`${summary.lateNotIn ?? '—'} past grace`} />
            <KpiCard
              icon={AlertTriangle}
              label="Needs attention"
              value={counts.people ?? '—'}
              sub={`${counts.blockers ?? '—'} blockers · ${counts.warnings ?? '—'} warnings · ${counts.info ?? '—'} info`}
            />
          </div>

          <div className="card flex flex-wrap items-center gap-2 text-sm">
            <span className="inline-flex items-center gap-1 text-crewly-dim"><Coffee size={14} /> Modes:</span>
            {MODES.map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setWorkMode((current) => (current === value ? '' : value))}
                className={`rounded-full px-2 py-0.5 text-xs ${workMode === value ? 'bg-white/20' : 'bg-white/5'} hover:bg-white/10`}
                title={`Filter work mode: ${label}`}
              >
                {label} {modes[value] ?? 0}
              </button>
            ))}
            <span className="ml-auto flex items-center gap-2 text-xs text-crewly-dim">
              <Link className="underline" to="/app/attendance/regularizations">
                Regularizations pending: {workflows.regularizations?.total ?? '—'}
              </Link>
              <span>·</span>
              <Link className="underline" to="/app/attendance/overtime">
                OT pending: {workflows.overtime?.total ?? '—'}
              </Link>
            </span>
          </div>

          <div className="card flex flex-wrap items-center gap-2">
            <label className="relative">
              <Search size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-crewly-dim" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search name, code, role…"
                className="input pl-7"
                aria-label="Search employees"
              />
            </label>
            <select value={departmentId} onChange={(event) => setDepartmentId(event.target.value)} className="input" aria-label="Department">
              <option value="">All departments</option>
              {(departments || []).map((dept) => (
                <option key={dept._id || dept.id} value={dept._id || dept.id}>{dept.name}</option>
              ))}
            </select>
            <select value={location} onChange={(event) => setLocation(event.target.value)} className="input" aria-label="Office location">
              <option value="">All locations</option>
              {(dash.locations || []).map((loc) => (
                <option key={loc.name} value={loc.name}>{loc.name}</option>
              ))}
            </select>
            <select value={presence} onChange={(event) => setPresence(event.target.value)} className="input" aria-label="Presence">
              <option value="">All presence states</option>
              {PRESENCES.map((value) => (
                <option key={value} value={value}>{value.replace(/_/g, ' ')}</option>
              ))}
            </select>
            <select value={category} onChange={(event) => setCategory(event.target.value)} className="input" aria-label="Issue category">
              <option value="">All issue categories</option>
              {CATEGORIES.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            <input
              value={shift}
              onChange={(event) => setShift(event.target.value)}
              placeholder="Shift name…"
              className="input"
              aria-label="Shift name"
            />
            {(search || departmentId || shift || location || presence || workMode || category) && (
              <button
                type="button"
                className="btn-ghost px-3 py-1 text-sm"
                onClick={() => {
                  setSearch('');
                  setDepartmentId('');
                  setShift('');
                  setLocation('');
                  setPresence('');
                  setWorkMode('');
                  setCategory('');
                }}
              >
                <span className="inline-flex items-center gap-1"><Filter size={14} /> Clear</span>
              </button>
            )}
          </div>

          <div className="card overflow-x-auto">
            <div className="flex items-center gap-2 pb-2">
              {[
                ['departments', 'Departments', Building2],
                ['shifts', 'Shifts', Clock],
                ['locations', 'Locations', MapPin],
              ].map(([value, label, Icon]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setGroupTab(value)}
                  className={groupTab === value ? 'btn-primary px-3 py-1 text-sm' : 'btn-ghost px-3 py-1 text-sm'}
                >
                  <span className="inline-flex items-center gap-1"><Icon size={14} /> {label}</span>
                </button>
              ))}
            </div>
            {groupTab !== 'locations' ? (
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-left text-xs text-crewly-dim">
                    <th className="py-2 pr-3 font-medium">{groupTab === 'departments' ? 'Department' : 'Shift'}</th>
                    <th className="py-2 pr-3 font-medium">Expected</th>
                    <th className="py-2 pr-3 font-medium">Working</th>
                    <th className="py-2 pr-3 font-medium">Break</th>
                    <th className="py-2 pr-3 font-medium">Done</th>
                    <th className="py-2 pr-3 font-medium">Not in</th>
                    <th className="py-2 pr-3 font-medium">Late</th>
                    <th className="py-2 pr-3 font-medium">Leave</th>
                    <th className="py-2 font-medium">Attention</th>
                  </tr>
                </thead>
                <tbody>
                  {(dash[groupTab] || []).map((group) => (
                    <tr key={group.id || group.name} className="border-b border-white/5">
                      <td className="py-2 pr-3 font-medium">{group.name}</td>
                      <td className="py-2 pr-3">{group.expected}</td>
                      <td className="py-2 pr-3 text-crewly-green">{group.working}</td>
                      <td className="py-2 pr-3">{group.onBreak}</td>
                      <td className="py-2 pr-3">{group.completed}</td>
                      <td className="py-2 pr-3">{group.notIn}</td>
                      <td className="py-2 pr-3 text-crewly-orange">{group.lateNotIn}</td>
                      <td className="py-2 pr-3">{group.onLeave}</td>
                      <td className="py-2">
                        {group.attention > 0 ? (
                          <span className="rounded-full bg-crewly-red/15 px-2 py-0.5 text-xs text-crewly-red">
                            {group.attention}
                          </span>
                        ) : (
                          <span className="text-crewly-dim">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {(dash[groupTab] || []).length === 0 && (
                    <tr><td colSpan={9} className="py-6 text-center text-crewly-dim">No groups in this view.</td></tr>
                  )}
                </tbody>
              </table>
            ) : (
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-left text-xs text-crewly-dim">
                    <th className="py-2 pr-3 font-medium">Office location</th>
                    <th className="py-2 pr-3 font-medium">Checked in</th>
                    <th className="py-2 pr-3 font-medium">Working</th>
                    <th className="py-2 font-medium">Late arrivals</th>
                  </tr>
                </thead>
                <tbody>
                  {(dash.locations || []).map((loc) => (
                    <tr key={loc.name} className="border-b border-white/5">
                      <td className="py-2 pr-3 font-medium">{loc.name}</td>
                      <td className="py-2 pr-3">{loc.checkedIn}</td>
                      <td className="py-2 pr-3 text-crewly-green">{loc.working}</td>
                      <td className="py-2 text-crewly-orange">{loc.lateArrivals}</td>
                    </tr>
                  ))}
                  {(dash.locations || []).length === 0 && (
                    <tr><td colSpan={4} className="py-6 text-center text-crewly-dim">No office check-ins in this view.</td></tr>
                  )}
                </tbody>
              </table>
            )}
          </div>

          <div className="card overflow-x-auto">
            <h2 className="flex items-center gap-2 pb-2 text-sm font-semibold">
              <AlertTriangle size={16} /> Needs attention
              <span className="font-normal text-crewly-dim">
                · {attention.total} issue{attention.total === 1 ? '' : 's'}
              </span>
            </h2>
            <table className="w-full min-w-[880px] text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs text-crewly-dim">
                  <th className="py-2 pr-3 font-medium">Employee</th>
                  <th className="py-2 pr-3 font-medium">Department</th>
                  <th className="py-2 pr-3 font-medium">Shift</th>
                  <th className="py-2 pr-3 font-medium">Issue</th>
                  <th className="py-2 pr-3 font-medium">Since</th>
                  <th className="py-2 pr-3 font-medium">Mode</th>
                  <th className="py-2 pr-3 font-medium">Severity</th>
                  <th className="py-2 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {attention.items.map((item, index) => (
                  <tr
                    key={`${item.category}-${item.employee.id}-${item.since || index}`}
                    onClick={() => openDetail(item)}
                    className={`cursor-pointer border-b border-white/5 hover:bg-white/5 ${selected?.id === item.employee.id ? 'bg-white/5' : ''}`}
                  >
                    <td className="py-2 pr-3">
                      <div className="font-medium">{item.employee.name}</div>
                      <div className="text-xs text-crewly-dim">{item.employee.employeeCode}</div>
                    </td>
                    <td className="py-2 pr-3 text-crewly-dim">{item.employee.department?.name || '—'}</td>
                    <td className="py-2 pr-3 text-crewly-dim">{item.shiftName || '—'}</td>
                    <td className="py-2 pr-3">
                      {item.label}
                      {Number.isFinite(item.minutes) && item.minutes > 0 && (
                        <span className="text-crewly-dim"> · {item.minutes}m</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-crewly-dim">{fmtTime(item.since)}</td>
                    <td className="py-2 pr-3 text-crewly-dim">{item.workMode ? item.workMode.replace(/_/g, ' ') : '—'}</td>
                    <td className="py-2 pr-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${SEVERITY_STYLES[item.severity] || SEVERITY_STYLES.INFO}`}>
                        {item.severity}
                      </span>
                    </td>
                    <td className="py-2" onClick={(event) => event.stopPropagation()}>
                      {WORKFLOWS[item.workflow] ? (
                        <Link className="underline" to={WORKFLOWS[item.workflow].to}>
                          {WORKFLOWS[item.workflow].label}
                        </Link>
                      ) : (
                        <span className="text-crewly-dim">—</span>
                      )}
                    </td>
                  </tr>
                ))}
                {attention.items.length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-6 text-center text-crewly-dim">
                      <span className="inline-flex items-center gap-2">
                        <CheckCircle2 size={16} className="text-crewly-green" />
                        Nothing needs attention in this view.
                      </span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <div className="flex items-center justify-between pt-3 text-sm text-crewly-dim">
              <span>Page {attention.page} of {attention.totalPages} · {attention.total} issues</span>
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn-ghost px-2 py-1"
                  disabled={attention.page <= 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                  aria-label="Previous page"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  type="button"
                  className="btn-ghost px-2 py-1"
                  disabled={attention.page >= attention.totalPages}
                  onClick={() => setPage((value) => value + 1)}
                  aria-label="Next page"
                >
                  <ChevronRight size={16} />
                </button>
              </span>
            </div>
          </div>

          {selected && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">{selected.name || 'Employee'}</h2>
                <button
                  type="button"
                  className="btn-ghost px-2 py-1"
                  onClick={() => { setSelected(null); setDetail(null); }}
                  aria-label="Close detail"
                >
                  <X size={16} />
                </button>
              </div>
              {selected.item && (
                <div className="card flex flex-wrap gap-x-6 gap-y-1 text-sm text-crewly-dim">
                  <span>Issue: <span className="text-crewly-text">{selected.item.label}</span></span>
                  <span>Presence: <span className="text-crewly-text">{(selected.item.presence || '').replace(/_/g, ' ')}</span></span>
                  <span>In: <span className="text-crewly-text">{fmtTime(selected.item.clockInAt)}</span></span>
                  <span>Out: <span className="text-crewly-text">{fmtTime(selected.item.clockOutAt)}</span></span>
                  {selected.item.locationName && <span>At: <span className="text-crewly-text">{selected.item.locationName}</span></span>}
                </div>
              )}
              {detailLoading && <div className="card text-sm text-crewly-dim">Loading month…</div>}
              {detailError && <div className="card text-sm text-crewly-red">{detailError}</div>}
              {!detailLoading && !detailError && detail && (
                <TimesheetMonthView sheet={detail} employeeName={detail?.employee?.name || ''} />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default AttendanceOperationsPage;
