import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, RefreshCw, Search } from 'lucide-react';
import attendanceService from '../../services/attendanceService.js';
import departmentService from '../../services/departmentService.js';
import TimesheetMonthView from '../../components/attendance/TimesheetMonthView.jsx';

// Phase 31.10 — Team Timesheets: the scoped monthly summary table
// for managers, team leads and HR, with per-employee drill-down and
// the scoped CSV export. READ-ONLY: org scope derives backend-side;
// rows show counts and time facts only — no reasons, no money.

const currentMonth = () => new Date().toISOString().slice(0, 7);

const fmtSpan = (totalMinutes) => {
  const minutes = Math.max(0, Math.floor(Number(totalMinutes) || 0));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours <= 0) return `${rest}m`;
  return `${hours}h ${String(rest).padStart(2, '0')}m`;
};

const AttendanceTeamTimesheetsPage = () => {
  const [month, setMonth] = useState(currentMonth());
  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [hasExceptions, setHasExceptions] = useState(false);
  const [page, setPage] = useState(1);
  const [table, setTable] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setTable(await attendanceService.teamTimesheets({
        month,
        search: search.trim(),
        departmentId,
        hasExceptions,
        page,
        pageSize: 10,
      }));
    } catch (err) {
      setTable(null);
      setError(err?.response?.data?.message || err.message || 'Failed to load team timesheets');
    } finally {
      setLoading(false);
    }
  }, [month, search, departmentId, hasExceptions, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { departmentService.getAll().then(setDepartments).catch(() => {}); }, []);
  useEffect(() => { setPage(1); setSelectedId(null); setDetail(null); }, [month, search, departmentId, hasExceptions]);

  const openDetail = async (userId) => {
    if (selectedId === userId && detail) {
      setSelectedId(null);
      setDetail(null);
      return;
    }
    setSelectedId(userId);
    setDetail(null);
    setDetailLoading(true);
    setDetailError('');
    try {
      setDetail(await attendanceService.employeeTimesheet(userId, month));
    } catch (err) {
      setDetailError(err?.response?.data?.message || err.message || 'Failed to load employee month');
    } finally {
      setDetailLoading(false);
    }
  };

  const runExport = async () => {
    setExporting(true);
    try {
      await attendanceService.downloadTeamTimesheets({
        month,
        search: search.trim(),
        departmentId,
        hasExceptions,
      });
    } catch (err) {
      setError(err?.response?.data?.message || err.message || 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const rows = table?.rows || [];
  const selectedName = rows.find((row) => row.user.id === selectedId)?.user?.name || '';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Team Timesheets</h1>
          <p className="text-sm text-crewly-dim">
            Monthly attendance summaries for your scope
            {table?.scope ? ` (${table.scope === 'COMPANY' ? 'whole company' : 'your team'})` : ''}.
            Select anyone for their full month.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="month"
            value={month}
            onChange={(event) => event.target.value && setMonth(event.target.value)}
            className="input"
            aria-label="Month"
          />
          <button type="button" className="btn-ghost px-2 py-1" onClick={load} aria-label="Reload">
            <RefreshCw size={16} />
          </button>
          <button
            type="button"
            className="btn-primary px-3 py-1 text-sm"
            onClick={runExport}
            disabled={exporting}
            title="Download the filtered scope as CSV"
          >
            <span className="inline-flex items-center gap-1">
              <Download size={14} /> {exporting ? 'Exporting…' : 'Export CSV'}
            </span>
          </button>
        </div>
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
        <select
          value={departmentId}
          onChange={(event) => setDepartmentId(event.target.value)}
          className="input"
          aria-label="Department"
        >
          <option value="">All departments</option>
          {(departments || []).map((dept) => (
            <option key={dept._id || dept.id} value={dept._id || dept.id}>{dept.name}</option>
          ))}
        </select>
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={hasExceptions}
            onChange={(event) => setHasExceptions(event.target.checked)}
          />
          Only days needing attention
        </label>
      </div>

      {loading && <div className="card text-sm text-crewly-dim">Loading team timesheets…</div>}
      {error && (
        <div className="card text-sm text-crewly-red">
          {error}{' '}
          <button type="button" className="underline" onClick={load}>Retry</button>
        </div>
      )}

      {!loading && !error && table && (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[880px] text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs text-crewly-dim">
                <th className="py-2 pr-3 font-medium">Employee</th>
                <th className="py-2 pr-3 font-medium">Scheduled</th>
                <th className="py-2 pr-3 font-medium">Present</th>
                <th className="py-2 pr-3 font-medium">Half</th>
                <th className="py-2 pr-3 font-medium">Leave</th>
                <th className="py-2 pr-3 font-medium">Absent</th>
                <th className="py-2 pr-3 font-medium">Late</th>
                <th className="py-2 pr-3 font-medium">Worked</th>
                <th className="py-2 pr-3 font-medium">OT</th>
                <th className="py-2 font-medium">Attention</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.user.id}
                  onClick={() => openDetail(row.user.id)}
                  className={`cursor-pointer border-b border-white/5 hover:bg-white/5 ${selectedId === row.user.id ? 'bg-white/5' : ''}`}
                >
                  <td className="py-2 pr-3">
                    <div className="font-medium">{row.user.name}</div>
                    <div className="text-xs text-crewly-dim">
                      {row.user.employeeCode}
                      {row.user.department?.name ? ` · ${row.user.department.name}` : ''}
                    </div>
                  </td>
                  <td className="py-2 pr-3">{row.summary.scheduledWorkingDays}</td>
                  <td className="py-2 pr-3 text-crewly-green">{row.summary.present}</td>
                  <td className="py-2 pr-3 text-blue-300">{row.summary.halfDay}</td>
                  <td className="py-2 pr-3 text-violet-300">{row.summary.leave}</td>
                  <td className="py-2 pr-3 text-crewly-red">{row.summary.absent}</td>
                  <td className="py-2 pr-3">{row.summary.lateDays}</td>
                  <td className="py-2 pr-3">{fmtSpan(row.summary.workedMinutes)}</td>
                  <td className="py-2 pr-3">{fmtSpan(row.summary.approvedOtMinutes)}</td>
                  <td className="py-2">
                    {row.summary.exceptionDays > 0 ? (
                      <span className="rounded-full bg-crewly-orange/15 px-2 py-0.5 text-xs text-crewly-orange">
                        {row.summary.exceptionDays} day{row.summary.exceptionDays > 1 ? 's' : ''}
                      </span>
                    ) : (
                      <span className="text-crewly-dim">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="py-6 text-center text-crewly-dim">
                    Nobody in scope matches these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="flex items-center justify-between pt-3 text-sm text-crewly-dim">
            <span>
              Page {table.page} of {table.totalPages} · {table.total} employee{table.total === 1 ? '' : 's'}
            </span>
            <span className="flex items-center gap-2">
              <button
                type="button"
                className="btn-ghost px-2 py-1"
                disabled={table.page <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                aria-label="Previous page"
              >
                <ChevronLeft size={16} />
              </button>
              <button
                type="button"
                className="btn-ghost px-2 py-1"
                disabled={table.page >= table.totalPages}
                onClick={() => setPage((value) => value + 1)}
                aria-label="Next page"
              >
                <ChevronRight size={16} />
              </button>
            </span>
          </div>
        </div>
      )}

      {selectedId && (
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">
            {detail?.employee?.name || selectedName || 'Employee month'}
          </h2>
          {detailLoading && <div className="card text-sm text-crewly-dim">Loading month…</div>}
          {detailError && <div className="card text-sm text-crewly-red">{detailError}</div>}
          {!detailLoading && !detailError && detail && (
            <TimesheetMonthView sheet={detail} employeeName={detail?.employee?.name || ''} />
          )}
        </div>
      )}
    </div>
  );
};

export default AttendanceTeamTimesheetsPage;
