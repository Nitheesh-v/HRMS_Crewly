import { useEffect, useState } from 'react';
import attendanceService from '../../services/attendanceService.js';
import departmentService from '../../services/departmentService.js';
import { ROLE_STYLES, roleLabel } from '../../utils/roles.js';

const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
const todayStr = () => new Date().toLocaleDateString('en-CA');
const currentMonth = () => new Date().toISOString().slice(0, 7);

const AttendanceReportPage = () => {
  const [tab, setTab] = useState('today');
  const [date, setDate] = useState(todayStr());
  const [month, setMonth] = useState(currentMonth());
  const [department, setDepartment] = useState('');
  const [departments, setDepartments] = useState([]);
  const [todayData, setTodayData] = useState(null);
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => { departmentService.getAll().then(setDepartments).catch(() => {}); }, []);
  useEffect(() => {
    if (tab === 'today') attendanceService.company(date).then(setTodayData).catch((e) => setError(e.message));
  }, [tab, date]);
  useEffect(() => {
    if (tab === 'monthly') attendanceService.report(month, department).then(setReport).catch((e) => setError(e.message));
  }, [tab, month, department]);

  const exportCSV = () => {
    if (!report) return;
    const header = 'Name,Role,Department,Present,Late,Half Day,Absent,Hours,Attendance %';
    const lines = report.rows.map((r) =>
      [r.user.name, r.user.role, r.user.department?.name || '', r.present, r.late, r.halfDay, r.absent, (r.totalMinutes / 60).toFixed(1), r.attendancePct].join(',')
    );
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `attendance-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const c = todayData?.counts;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">📈 Attendance Report</h1>
        {tab === 'monthly' && report && <button className="btn-ghost" onClick={exportCSV}>⬇ Export CSV</button>}
      </div>

      {error && <div className="rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">{error}</div>}

      {/* Tabs */}
      <div className="flex gap-2">
        {[['today', "Today's Status"], ['monthly', 'Monthly Report']].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`rounded-lg px-4 py-2 text-sm transition ${tab === key ? 'bg-crewly-green/15 text-crewly-green' : 'border border-crewly-border text-crewly-dim hover:text-crewly-text'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* ===== TODAY TAB ===== */}
      {tab === 'today' && (
        <>
          <div className="card flex flex-wrap items-end gap-3">
            <div>
              <label className="label">Date</label>
              <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            {c && (
              <div className="flex gap-2 pb-1 text-xs">
                <span className="badge bg-crewly-green/15 text-crewly-green">On duty: {c.punchedIn}</span>
                <span className="badge bg-blue-400/15 text-blue-300">Done: {c.punchedOut}</span>
                <span className="badge bg-crewly-orange/15 text-crewly-orange">Late: {c.late}</span>
                <span className="badge bg-crewly-red/15 text-crewly-red">Absent: {c.absent}</span>
                <span className="badge bg-white/10 text-crewly-dim">Total: {c.total}</span>
              </div>
            )}
          </div>

          <div className="card overflow-x-auto p-0">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-crewly-border text-crewly-dim">
                  <th className="px-5 py-3">Employee</th>
                  <th className="px-5 py-3">Department</th>
                  <th className="px-5 py-3">Punch In</th>
                  <th className="px-5 py-3">Punch Out</th>
                  <th className="px-5 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {todayData?.rows.map(({ user, record }) => (
                  <tr key={user._id} className="border-b border-crewly-border/50 last:border-0">
                    <td className="px-5 py-3">
                      <div className="font-medium">{user.name}</div>
                      <span className={`badge mt-1 ${ROLE_STYLES[user.role]}`}>{roleLabel(user.role)}</span>
                    </td>
                    <td className="px-5 py-3 text-crewly-dim">{user.department?.name || '—'}</td>
                    <td className="px-5 py-3">{fmtTime(record?.punchIn)}</td>
                    <td className="px-5 py-3">{fmtTime(record?.punchOut)}</td>
                    <td className="px-5 py-3">
                      {!record && <span className="badge bg-crewly-red/15 text-crewly-red">NOT PUNCHED</span>}
                      {record && !record.punchOut && <span className="badge bg-crewly-green/15 text-crewly-green">ON DUTY</span>}
                      {record?.punchOut && <span className="badge bg-blue-400/15 text-blue-300">DONE · {(record.workMinutes / 60).toFixed(1)}h</span>}
                      {record?.status === 'LATE' && <span className="badge ml-1 bg-crewly-orange/15 text-crewly-orange">LATE</span>}
                      {record?.status === 'HALF_DAY' && <span className="badge ml-1 bg-blue-400/15 text-blue-300">HALF</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ===== MONTHLY TAB ===== */}
      {tab === 'monthly' && (
        <>
          <div className="card flex flex-wrap items-end gap-3">
            <div>
              <label className="label">Month</label>
              <input type="month" className="input" value={month} onChange={(e) => setMonth(e.target.value)} />
            </div>
            <div>
              <label className="label">Department</label>
              <select className="input" value={department} onChange={(e) => setDepartment(e.target.value)}>
                <option value="">All departments</option>
                {departments.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
              </select>
            </div>
            {report && <span className="pb-2 text-sm text-crewly-dim">Working days: <span className="text-crewly-text">{report.workingDays}</span></span>}
          </div>

          <div className="card overflow-x-auto p-0">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-crewly-border text-crewly-dim">
                  <th className="px-5 py-3">Employee</th>
                  <th className="px-5 py-3">Present</th>
                  <th className="px-5 py-3">Late</th>
                  <th className="px-5 py-3">Half</th>
                  <th className="px-5 py-3">Absent</th>
                  <th className="px-5 py-3">Hours</th>
                  <th className="px-5 py-3 w-48">Attendance</th>
                </tr>
              </thead>
              <tbody>
                {report?.rows.map((r) => (
                  <tr key={r.user._id} className="border-b border-crewly-border/50 last:border-0">
                    <td className="px-5 py-3">
                      <div className="font-medium">{r.user.name}</div>
                      <div className="text-xs text-crewly-dim">{r.user.department?.name || roleLabel(r.user.role)}</div>
                    </td>
                    <td className="px-5 py-3 text-crewly-green">{r.present}</td>
                    <td className="px-5 py-3 text-crewly-orange">{r.late}</td>
                    <td className="px-5 py-3 text-blue-300">{r.halfDay}</td>
                    <td className="px-5 py-3 text-crewly-red">{r.absent}</td>
                    <td className="px-5 py-3">{(r.totalMinutes / 60).toFixed(1)}h</td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-full rounded bg-crewly-bg">
                          <div
                            className={`h-2 rounded ${r.attendancePct >= 80 ? 'bg-crewly-green' : r.attendancePct >= 60 ? 'bg-crewly-orange' : 'bg-crewly-red'}`}
                            style={{ width: `${r.attendancePct}%` }}
                          />
                        </div>
                        <span className="text-xs text-crewly-dim">{r.attendancePct}%</span>
                      </div>
                    </td>
                  </tr>
                ))}
                {report?.rows.length === 0 && (
                  <tr><td colSpan={7} className="px-5 py-8 text-center text-crewly-dim">No team members found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};

export default AttendanceReportPage;