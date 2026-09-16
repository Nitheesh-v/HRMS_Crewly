import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import attendanceService from '../../services/attendanceService.js';
import TimesheetMonthView from '../../components/attendance/TimesheetMonthView.jsx';

// Phase 31.10 — My Timesheet: the employee's monthly attendance
// calendar. READ-ONLY: every figure comes from punch facts,
// schedules, leave and holidays — no edits, no money, no reasons.
// Corrections happen on the Regularizations page; this view links
// there from any day.

const currentMonth = () => new Date().toISOString().slice(0, 7);

const shiftMonth = (month, delta) => {
  const [year, mon] = month.split('-').map(Number);
  const next = new Date(Date.UTC(year, mon - 1 + delta, 1));
  return next.toISOString().slice(0, 7);
};

const AttendanceTimesheetPage = () => {
  const [month, setMonth] = useState(currentMonth());
  const [sheet, setSheet] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setSheet(await attendanceService.myTimesheet(month));
    } catch (err) {
      setSheet(null);
      setError(err?.response?.data?.message || err.message || 'Failed to load timesheet');
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">My Timesheet</h1>
          <p className="text-sm text-crewly-dim">
            Your monthly attendance calendar — recorded punches, schedules, leave and holidays in one place.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-ghost px-2 py-1"
            onClick={() => setMonth((value) => shiftMonth(value, -1))}
            aria-label="Previous month"
          >
            <ChevronLeft size={16} />
          </button>
          <input
            type="month"
            value={month}
            max={shiftMonth(currentMonth(), 12)}
            onChange={(event) => event.target.value && setMonth(event.target.value)}
            className="input"
            aria-label="Month"
          />
          <button
            type="button"
            className="btn-ghost px-2 py-1"
            onClick={() => setMonth((value) => shiftMonth(value, 1))}
            aria-label="Next month"
          >
            <ChevronRight size={16} />
          </button>
          <button type="button" className="btn-ghost px-2 py-1" onClick={load} aria-label="Reload">
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {loading && <div className="card text-sm text-crewly-dim">Loading timesheet…</div>}
      {error && (
        <div className="card text-sm text-crewly-red">
          {error}{' '}
          <button type="button" className="underline" onClick={load}>Retry</button>
        </div>
      )}
      {!loading && !error && sheet && <TimesheetMonthView sheet={sheet} />}
    </div>
  );
};

export default AttendanceTimesheetPage;
