/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import usePermission from '../../hooks/usePermission.js';
import employeePayrollService from '../../services/employeePayrollService.js';

// ── display mirrors of the backend rules (the server always decides) ────────

const STATUSES = [
  { value: 'ALL', label: 'All statuses' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'ON_HOLD', label: 'On Hold' },
  { value: 'SUSPENDED', label: 'Suspended' },
];

const EMPLOYMENT_TYPES = [
  { value: 'ALL', label: 'All employment types' },
  { value: 'FULL_TIME', label: 'Full Time' },
  { value: 'PART_TIME', label: 'Part Time' },
  { value: 'CONTRACT', label: 'Contract' },
  { value: 'INTERN', label: 'Intern' },
];

const statusBadge = (status) => {
  const styles = {
    ACTIVE: 'bg-emerald-500/15 text-emerald-300',
    DRAFT: 'bg-indigo-500/15 text-indigo-300',
    ON_HOLD: 'bg-amber-500/15 text-amber-300',
    SUSPENDED: 'bg-red-500/15 text-red-300',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] ${styles[status] || styles.DRAFT}`}>
      {String(status || 'draft').replace('_', ' ').toLowerCase()}
    </span>
  );
};

const formatMoney = (value) => `Rs ${Number(value || 0).toLocaleString('en-IN')}`;

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : '—';

const EmployeePayrollPage = () => {
  const { loading: permsLoading, hasAnyPermission } = usePermission();

  const [loading, setLoading] = useState(true);
  const [profiles, setProfiles] = useState([]);
  const [structures, setStructures] = useState([]);
  const [withoutProfile, setWithoutProfile] = useState([]);
  const [banner, setBanner] = useState(null);
  const [accessDenied, setAccessDenied] = useState(false);

  const [filters, setFilters] = useState({
    search: '',
    payrollStatus: 'ALL',
    employmentType: 'ALL',
    structureId: 'ALL',
  });

  const canView = hasAnyPermission([
    'EMPLOYEE_SALARY_READ',
    'EMPLOYEE_SALARY_MANAGE',
    'EMPLOYEE_SALARY_READ_SELF',
  ]);
  const noAccess = !permsLoading && !canView;

  const flash = useCallback((type, text) => {
    setBanner({ type, text });
    setTimeout(() => setBanner(null), 5000);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await employeePayrollService.list({
        search: filters.search || undefined,
        payrollStatus: filters.payrollStatus === 'ALL' ? undefined : filters.payrollStatus,
        employmentType: filters.employmentType === 'ALL' ? undefined : filters.employmentType,
        structureId: filters.structureId === 'ALL' ? undefined : filters.structureId,
      });
      setProfiles(data?.data || []);
      setStructures(data?.meta?.structures || []);
      setWithoutProfile(data?.meta?.withoutProfile || []);
      setAccessDenied(false);
    } catch (error) {
      if (error?.status === 403 || error?.code === 'PERMISSION_DENIED') setAccessDenied(true);
      else flash('error', error?.message || 'Unable to load payroll profiles');
    } finally {
      setLoading(false);
    }
  }, [filters, flash]);

  useEffect(() => {
    if (!permsLoading && canView) load();
    if (!permsLoading && !canView) setLoading(false);
  }, [permsLoading, canView, load]);

  const rows = useMemo(() => {
    const needle = filters.search.trim().toLowerCase();
    if (!needle) return profiles;
    return profiles.filter((row) =>
      [row.employeeName, row.employeeCode, row.email, row.structureName]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [profiles, filters.search]);

  if (noAccess || accessDenied) {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-bold">Employee Payroll</h1>
        <div className="card space-y-2">
          <h2 className="text-lg font-semibold">Payroll access required</h2>
          <p className="text-sm text-crewly-dim">
            You don&apos;t have permission to view employee payroll profiles. Contact your Company
            Admin or Payroll Administrator.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Employee Payroll</h1>
          <p className="mt-1 text-sm text-crewly-dim">
            Payroll profiles sit between HR and payroll: salary, bank, statutory and tax details for
            each employee. No monthly payroll is calculated here.
          </p>
        </div>
      </div>

      {banner && (
        <div
          className={`card text-sm ${
            banner.type === 'error'
              ? 'border-red-500/40 text-red-300'
              : 'border-emerald-500/40 text-emerald-300'
          }`}
        >
          {banner.text}
        </div>
      )}

      {/* §17 — filters */}
      <div className="card grid gap-3 md:grid-cols-4">
        <input
          className="input"
          placeholder="Search name, code or email"
          value={filters.search}
          onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value }))}
        />
        <select
          className="input"
          value={filters.payrollStatus}
          onChange={(event) => setFilters((prev) => ({ ...prev, payrollStatus: event.target.value }))}
        >
          {STATUSES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={filters.employmentType}
          onChange={(event) =>
            setFilters((prev) => ({ ...prev, employmentType: event.target.value }))
          }
        >
          {EMPLOYMENT_TYPES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={filters.structureId}
          onChange={(event) => setFilters((prev) => ({ ...prev, structureId: event.target.value }))}
        >
          <option value="ALL">All structures</option>
          {structures.map((structure) => (
            <option key={structure._id} value={structure._id}>
              {structure.name}
            </option>
          ))}
        </select>
      </div>

      <div className="card">
        {loading ? (
          <p className="text-sm text-crewly-dim">Loading payroll profiles…</p>
        ) : rows.length === 0 ? (
          <div className="space-y-3 py-6 text-center">
            <h2 className="text-lg font-semibold">No Payroll Profiles Yet</h2>
            <p className="mx-auto max-w-xl text-sm text-crewly-dim">
              A payroll profile is created when a candidate is converted into an employee, or by
              opening one for an existing employee below.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-crewly-border text-xs uppercase tracking-wide text-crewly-dim">
                  <th className="py-2 pr-3">Employee</th>
                  <th className="py-2 pr-3">Department</th>
                  <th className="py-2 pr-3">Salary Structure</th>
                  <th className="py-2 pr-3">Gross / Month</th>
                  <th className="py-2 pr-3">Annual CTC</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Effective</th>
                  <th className="py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row._id} className="border-b border-crewly-border/60">
                    <td className="py-2 pr-3">
                      <Link
                        to={`/app/payroll/employees/${row.employeeId}`}
                        className="font-medium text-crewly-text hover:underline"
                      >
                        {row.employeeName}
                      </Link>
                      <div className="text-xs text-crewly-dim">{row.employeeCode || row.email}</div>
                    </td>
                    <td className="py-2 pr-3 text-crewly-dim">{row.departmentId ? '—' : '—'}</td>
                    <td className="py-2 pr-3">{row.structureName || '—'}</td>
                    <td className="py-2 pr-3">{formatMoney(row.monthlyGross)}</td>
                    <td className="py-2 pr-3">{formatMoney(row.annualCtc)}</td>
                    <td className="py-2 pr-3">{statusBadge(row.payrollStatus)}</td>
                    <td className="py-2 pr-3">{formatDate(row.effectiveFrom)}</td>
                    <td className="py-2">
                      <Link
                        to={`/app/payroll/employees/${row.employeeId}`}
                        className="text-xs text-indigo-300 hover:underline"
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {withoutProfile.length > 0 && (
        <div className="card space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Employees without a payroll profile</h2>
              <p className="text-sm text-crewly-dim">
                Start one to capture salary, bank, statutory and tax details (§5).
              </p>
            </div>
            <span className="text-xs text-crewly-dim">{withoutProfile.length} pending</span>
          </div>

          <div className="flex flex-wrap gap-2">
            {withoutProfile.slice(0, 30).map((employee) => (
              <Link
                key={employee._id}
                to={`/app/payroll/employees/${employee._id}`}
                className="flex items-center gap-1 rounded bg-slate-800 px-2 py-1 text-xs hover:bg-slate-700"
              >
                <Plus size={11} />
                {employee.name}
                {employee.employeeCode ? ` (${employee.employeeCode})` : ''}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default EmployeePayrollPage;
