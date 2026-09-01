/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Modal from '../../components/Modal.jsx';
import usePermission from '../../hooks/usePermission.js';
import employeePayrollService from '../../services/employeePayrollService.js';
import salaryStructureService from '../../services/salaryStructureService.js';

// ── display mirrors of the backend rules (the server always decides) ────────

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'bank', label: 'Bank' },
  { id: 'statutory', label: 'Statutory' },
  { id: 'tax', label: 'Tax' },
  { id: 'history', label: 'Salary History' },
];

const EMPLOYMENT_TYPES = [
  { value: 'FULL_TIME', label: 'Full Time' },
  { value: 'PART_TIME', label: 'Part Time' },
  { value: 'CONTRACT', label: 'Contract' },
  { value: 'INTERN', label: 'Intern' },
];

const PAY_GROUPS = [
  { value: 'MONTHLY', label: 'Monthly Payroll' },
  { value: 'WEEKLY', label: 'Weekly Payroll' },
  { value: 'EXECUTIVE', label: 'Executive Payroll' },
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

const emptyForm = {
  structureId: '',
  annualCtc: '',
  monthlyGross: '',
  employmentType: 'FULL_TIME',
  payGroup: 'MONTHLY',
  payrollStatus: 'DRAFT',
  designation: '',
  effectiveFrom: new Date().toISOString().slice(0, 10),
  bank: {
    bankName: '',
    accountHolderName: '',
    accountNumber: '',
    ifsc: '',
    branch: '',
    accountType: 'SAVINGS',
    paymentMethod: 'BANK_TRANSFER',
  },
  statutory: { pan: '', aadhaar: '', uan: '', esiNumber: '', pfMember: false, gratuityEligible: false },
  tax: {
    regime: 'NEW',
    tdsApplicable: true,
    panVerified: false,
    declarationStatus: 'PENDING',
    residentialStatus: 'RESIDENT',
  },
};

const toForm = (profile = {}) => ({
  ...emptyForm,
  ...(profile || {}),
  annualCtc: profile?.annualCtc ?? '',
  monthlyGross: profile?.monthlyGross ?? '',
  effectiveFrom: profile?.effectiveFrom
    ? new Date(profile.effectiveFrom).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10),
  bank: { ...emptyForm.bank, ...(profile?.bank || {}), accountNumber: '' },
  statutory: { ...emptyForm.statutory, ...(profile?.statutory || {}) },
  tax: { ...emptyForm.tax, ...(profile?.tax || {}) },
});

const EmployeePayrollDetailPage = () => {
  const { employeeId } = useParams();
  const { loading: permsLoading, hasPermission, hasAnyPermission } = usePermission();

  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState(null);
  const [tab, setTab] = useState('overview');
  const [banner, setBanner] = useState(null);
  const [busy, setBusy] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [structures, setStructures] = useState([]);
  const [preview, setPreview] = useState(null);

  const canManage = hasPermission('EMPLOYEE_SALARY_MANAGE');
  const canView = hasAnyPermission([
    'EMPLOYEE_SALARY_READ',
    'EMPLOYEE_SALARY_MANAGE',
    'EMPLOYEE_SALARY_READ_SELF',
  ]);

  const flash = (type, text) => {
    setBanner({ type, text });
    setTimeout(() => setBanner(null), 5000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await employeePayrollService.get(employeeId);
      setProfile(data?.data || null);
      setForbidden(false);
    } catch (error) {
      if (error?.status === 403 || error?.code === 'PAYROLL_ACCESS_DENIED') setForbidden(true);
      else flash('error', error?.message || 'Unable to load this payroll profile');
    } finally {
      setLoading(false);
    }
  }, [employeeId]);

  useEffect(() => {
    if (!permsLoading && canView) load();
    if (!permsLoading && !canView) setLoading(false);
  }, [permsLoading, canView, load]);

  const openEdit = async () => {
    try {
      const list = await salaryStructureService.list({ status: 'ACTIVE', limit: 100 });
      setStructures(list?.data || []);
    } catch {
      setStructures([]);
    }
    setForm(profile ? toForm(profile) : emptyForm);
    setFormOpen(true);
  };

  // §9 — live breakup preview. Display only; nothing is stored.
  useEffect(() => {
    if (!formOpen || !form.structureId || !form.monthlyGross) {
      setPreview(null);
      return undefined;
    }

    const timer = setTimeout(async () => {
      try {
        const data = await employeePayrollService.preview({
          structureId: form.structureId,
          monthlyGross: Number(form.monthlyGross) || 0,
        });
        setPreview(data?.data || null);
      } catch {
        setPreview(null);
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [formOpen, form.structureId, form.monthlyGross]);

  const submit = async () => {
    setBusy(true);
    try {
      const data = await employeePayrollService.save(employeeId, {
        structureId: form.structureId || null,
        annualCtc: Number(form.annualCtc) || 0,
        monthlyGross: Number(form.monthlyGross) || 0,
        employmentType: form.employmentType,
        payGroup: form.payGroup,
        payrollStatus: form.payrollStatus,
        designation: form.designation,
        effectiveFrom: form.effectiveFrom,
        bank: form.bank.accountNumber
          ? form.bank
          : { ...form.bank, accountNumber: undefined },
        statutory: form.statutory,
        tax: form.tax,
      });
      flash('success', data?.message || 'Payroll profile saved successfully.');
      setFormOpen(false);
      await load();
    } catch (error) {
      const details = error?.data?.errors;
      flash('error', details?.length ? details[0].message : error?.message || 'Could not save this payroll profile');
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (status) => {
    setBusy(true);
    try {
      const data = await employeePayrollService.setStatus(employeeId, status);
      flash('success', data?.message || 'Payroll status updated.');
      await load();
    } catch (error) {
      const details = error?.data?.errors;
      flash('error', details?.length ? details[0].message : error?.message || 'Could not change the payroll status');
    } finally {
      setBusy(false);
    }
  };

  if (forbidden) {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-bold">Payroll Profile</h1>
        <div className="card space-y-2">
          <h2 className="text-lg font-semibold">You cannot access this payroll profile</h2>
          <p className="text-sm text-crewly-dim">
            Employee payroll data is visible only to the employee and to the people your company has
            given payroll access to.
          </p>
          <Link to="/app/payroll/employees" className="text-sm text-indigo-300 hover:underline">
            Back to Employee Payroll
          </Link>
        </div>
      </div>
    );
  }

  if (loading) {
    return <p className="text-sm text-crewly-dim">Loading payroll profile…</p>;
  }

  if (!profile) {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-bold">Payroll Profile</h1>
        <div className="card space-y-3">
          <h2 className="text-lg font-semibold">No payroll profile yet</h2>
          <p className="text-sm text-crewly-dim">
            Create one to capture salary, bank, statutory and tax details for this employee.
          </p>
          {canManage && (
            <button type="button" className="btn-primary" onClick={openEdit}>
              Create Payroll Profile
            </button>
          )}
        </div>
      </div>
    );
  }

  const statutoryConfig = profile.statutoryConfig || {};
  const pfApplies = Boolean(statutoryConfig.pf?.applicable);
  const esiApplies = Boolean(statutoryConfig.esi?.applicable);

  const previewTable = (rows = []) =>
    rows.map((row) => (
      <tr key={`${row.componentCode}-${row.order}`} className="border-b border-crewly-border/60">
        <td className="py-1.5 pr-3">{row.name}</td>
        <td className="py-1.5 pr-3 text-crewly-dim">{row.methodLabel}</td>
        <td className="py-1.5 text-right">{formatMoney(row.amount)}</td>
      </tr>
    ));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/app/payroll/employees" className="text-xs text-crewly-dim hover:underline">
            ← Employee Payroll
          </Link>
          <h1 className="text-2xl font-bold">{profile.employeeName || 'Payroll Profile'}</h1>
          <p className="mt-1 text-sm text-crewly-dim">
            {profile.designation || '—'} · {profile.employmentType?.replace('_', ' ')} · v
            {profile.version || 1}
          </p>
        </div>

        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-ghost" onClick={openEdit} disabled={busy}>
              Edit
            </button>
            {profile.payrollStatus === 'DRAFT' && (
              <button
                type="button"
                className="btn-primary"
                onClick={() => changeStatus('ACTIVE')}
                disabled={busy}
              >
                Activate Payroll
              </button>
            )}
            {profile.payrollStatus === 'ACTIVE' && (
              <button
                type="button"
                className="btn-ghost"
                onClick={() => changeStatus('ON_HOLD')}
                disabled={busy}
              >
                Put On Hold
              </button>
            )}
            {profile.payrollStatus === 'ON_HOLD' && (
              <button
                type="button"
                className="btn-primary"
                onClick={() => changeStatus('ACTIVE')}
                disabled={busy}
              >
                Reactivate
              </button>
            )}
            {profile.payrollStatus !== 'SUSPENDED' && (
              <button
                type="button"
                className="btn-ghost text-red-300"
                onClick={() => changeStatus('SUSPENDED')}
                disabled={busy}
              >
                Suspend
              </button>
            )}
          </div>
        )}
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

      <div className="flex flex-wrap gap-2">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              tab === entry.id
                ? 'bg-crewly-green/10 text-crewly-green'
                : 'text-crewly-dim hover:bg-crewly-bg hover:text-crewly-text'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="card">
        {tab === 'overview' && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <div className="text-xs uppercase tracking-wide text-crewly-dim">Annual CTC</div>
              <div className="text-lg font-semibold">{formatMoney(profile.annualCtc)}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-crewly-dim">Monthly Gross</div>
              <div className="text-lg font-semibold">{formatMoney(profile.monthlyGross)}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-crewly-dim">Salary Structure</div>
              <div className="text-lg font-semibold">{profile.structureName || '—'}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-crewly-dim">Payroll Status</div>
              <div className="mt-1">{statusBadge(profile.payrollStatus)}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-crewly-dim">Effective From</div>
              <div>{formatDate(profile.effectiveFrom)}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-crewly-dim">Employment Type</div>
              <div>{String(profile.employmentType || '').replace('_', ' ')}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-crewly-dim">Pay Group</div>
              <div>{String(profile.payGroup || '').replace('_', ' ')}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-crewly-dim">Version</div>
              <div>v{profile.version || 1}</div>
            </div>
          </div>
        )}

        {tab === 'bank' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <div className="text-xs uppercase tracking-wide text-crewly-dim">Bank Name</div>
              <div>{profile.bank?.bankName || '—'}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-crewly-dim">Account Holder</div>
              <div>{profile.bank?.accountHolderName || '—'}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-crewly-dim">Account Number</div>
              <div className="font-mono">
                {profile.bank?.accountNumberMasked || '—'}
                <span className="ml-2 text-[10px] text-crewly-dim">masked</span>
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-crewly-dim">IFSC</div>
              <div className="font-mono">{profile.bank?.ifsc || '—'}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-crewly-dim">Branch</div>
              <div>{profile.bank?.branch || '—'}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-crewly-dim">Payment Method</div>
              <div>{String(profile.bank?.paymentMethod || '').replace('_', ' ')}</div>
            </div>
          </div>
        )}

        {tab === 'statutory' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <div className="text-xs uppercase tracking-wide text-crewly-dim">PAN</div>
              <div className="font-mono">{profile.statutory?.pan || '—'}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-crewly-dim">
                UAN {pfApplies ? '' : '(PF off in Payroll Setup)'}
              </div>
              <div className="font-mono">{profile.statutory?.uan || '—'}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-crewly-dim">
                ESI Number {esiApplies ? '' : '(ESI off in Payroll Setup)'}
              </div>
              <div className="font-mono">{profile.statutory?.esiNumber || '—'}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-crewly-dim">Aadhaar</div>
              <div className="font-mono">
                {profile.statutory?.aadhaar ? `XXXX XXXX ${String(profile.statutory.aadhaar).slice(-4)}` : '—'}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-crewly-dim">PF Member</div>
              <div>{profile.statutory?.pfMember ? 'Yes' : 'No'}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-crewly-dim">Gratuity</div>
              <div>{profile.statutory?.gratuityEligible ? 'Eligible' : 'Not eligible'}</div>
            </div>
          </div>
        )}

        {tab === 'tax' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <div className="text-xs uppercase tracking-wide text-crewly-dim">Tax Regime</div>
              <div>{profile.tax?.regime === 'OLD' ? 'Old Regime' : 'New Regime'}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-crewly-dim">TDS Applicable</div>
              <div>{profile.tax?.tdsApplicable ? 'Yes' : 'No'}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-crewly-dim">PAN Verified</div>
              <div>{profile.tax?.panVerified ? 'Yes' : 'No'}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-crewly-dim">Residential Status</div>
              <div>{profile.tax?.residentialStatus || '—'}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-crewly-dim">Declaration Status</div>
              <div>{profile.tax?.declarationStatus || '—'}</div>
            </div>
            <p className="text-xs text-crewly-dim sm:col-span-2">
              Tax is only stored here — Crewly does not calculate tax in this phase (§12 / §25).
            </p>
          </div>
        )}

        {tab === 'history' && (
          <div className="space-y-2">
            <p className="text-xs text-crewly-dim">
              Every salary revision is kept. Payroll uses the revision effective for that month.
            </p>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-crewly-border text-xs uppercase tracking-wide text-crewly-dim">
                  <th className="py-1.5 pr-3">Version</th>
                  <th className="py-1.5 pr-3">Effective From</th>
                  <th className="py-1.5 pr-3">Effective To</th>
                  <th className="py-1.5 pr-3">Annual CTC</th>
                  <th className="py-1.5 pr-3">Monthly Gross</th>
                  <th className="py-1.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {(profile.history || []).map((row) => (
                  <tr key={row._id} className="border-b border-crewly-border/60">
                    <td className="py-1.5 pr-3">v{row.version}</td>
                    <td className="py-1.5 pr-3">{formatDate(row.effectiveFrom)}</td>
                    <td className="py-1.5 pr-3">{formatDate(row.effectiveTo)}</td>
                    <td className="py-1.5 pr-3">{formatMoney(row.annualCtc)}</td>
                    <td className="py-1.5 pr-3">{formatMoney(row.monthlyGross)}</td>
                    <td className="py-1.5">{statusBadge(row.payrollStatus)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* §9 — saved breakup, display only */}
      {tab === 'overview' && profile.preview?.earnings?.length > 0 && (
        <div className="card space-y-3">
          <h2 className="text-lg font-semibold">Salary Breakup (preview)</h2>
          <div className="grid gap-4 md:grid-cols-3">
            {[
              { title: 'Earnings', rows: profile.preview.earnings },
              { title: 'Deductions', rows: profile.preview.deductions },
              { title: 'Employer Contribution', rows: profile.preview.employerContributions },
            ].map((section) => (
              <div key={section.title}>
                <div className="text-xs uppercase tracking-wide text-crewly-dim">{section.title}</div>
                <table className="w-full text-left text-xs">
                  <tbody>{previewTable(section.rows || [])}</tbody>
                </table>
              </div>
            ))}
          </div>
          <div className="grid gap-2 text-sm sm:grid-cols-3">
            <div className="flex justify-between">
              <span className="text-crewly-dim">Gross / month</span>
              <span>{formatMoney(profile.preview.totals?.gross)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-crewly-dim">Net pay / month</span>
              <span>{formatMoney(profile.preview.totals?.netPay)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-crewly-dim">Employer cost / month</span>
              <span>{formatMoney(profile.preview.totals?.employerCost)}</span>
            </div>
          </div>
        </div>
      )}

      {/* §6 / §7 / §15 — edit + revise */}
      {formOpen && (
        <Modal title="Payroll Profile" onClose={() => setFormOpen(false)} wide>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Salary Information</h3>

              <label className="label block">
                Salary Structure (active only)
                <select
                  className="input mt-1 w-full"
                  value={form.structureId}
                  onChange={(event) => setForm((prev) => ({ ...prev, structureId: event.target.value }))}
                >
                  <option value="">Select a structure</option>
                  {structures.map((structure) => (
                    <option key={structure._id} value={structure._id}>
                      {structure.name}
                    </option>
                  ))}
                </select>
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="label block">
                  Annual CTC (Rs)
                  <input
                    className="input mt-1 w-full"
                    type="number"
                    value={form.annualCtc}
                    onChange={(event) => setForm((prev) => ({ ...prev, annualCtc: event.target.value }))}
                  />
                </label>
                <label className="label block">
                  Monthly Gross (Rs)
                  <input
                    className="input mt-1 w-full"
                    type="number"
                    value={form.monthlyGross}
                    onChange={(event) => setForm((prev) => ({ ...prev, monthlyGross: event.target.value }))}
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="label block">
                  Employment Type
                  <select
                    className="input mt-1 w-full"
                    value={form.employmentType}
                    onChange={(event) => setForm((prev) => ({ ...prev, employmentType: event.target.value }))}
                  >
                    {EMPLOYMENT_TYPES.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="label block">
                  Pay Group
                  <select
                    className="input mt-1 w-full"
                    value={form.payGroup}
                    onChange={(event) => setForm((prev) => ({ ...prev, payGroup: event.target.value }))}
                  >
                    {PAY_GROUPS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="label block">
                  Effective From
                  <input
                    type="date"
                    className="input mt-1 w-full"
                    value={form.effectiveFrom}
                    onChange={(event) => setForm((prev) => ({ ...prev, effectiveFrom: event.target.value }))}
                  />
                </label>
                <label className="label block">
                  Payroll Status
                  <select
                    className="input mt-1 w-full"
                    value={form.payrollStatus}
                    onChange={(event) => setForm((prev) => ({ ...prev, payrollStatus: event.target.value }))}
                  >
                    <option value="DRAFT">Draft</option>
                    <option value="ACTIVE">Active</option>
                    <option value="ON_HOLD">On Hold</option>
                    <option value="SUSPENDED">Suspended</option>
                  </select>
                </label>
              </div>

              <h3 className="pt-2 text-sm font-semibold">Bank Details</h3>
              <div className="grid grid-cols-2 gap-3">
                <label className="label block">
                  Bank Name
                  <input
                    className="input mt-1 w-full"
                    value={form.bank.bankName}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, bank: { ...prev.bank, bankName: event.target.value } }))
                    }
                  />
                </label>
                <label className="label block">
                  Account Holder
                  <input
                    className="input mt-1 w-full"
                    value={form.bank.accountHolderName}
                    onChange={(event) =>
                      setForm((prev) => ({
                        ...prev,
                        bank: { ...prev.bank, accountHolderName: event.target.value },
                      }))
                    }
                  />
                </label>
                <label className="label block">
                  Account Number {profile?.bank?.accountNumberMasked ? '(leave blank to keep)' : ''}
                  <input
                    className="input mt-1 w-full"
                    value={form.bank.accountNumber}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, bank: { ...prev.bank, accountNumber: event.target.value } }))
                    }
                  />
                </label>
                <label className="label block">
                  IFSC
                  <input
                    className="input mt-1 w-full"
                    value={form.bank.ifsc}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, bank: { ...prev.bank, ifsc: event.target.value } }))
                    }
                  />
                </label>
              </div>
              {profile?.bank?.accountNumberMasked && (
                <p className="text-xs text-crewly-dim">
                  Stored account: <span className="font-mono">{profile.bank.accountNumberMasked}</span>
                </p>
              )}

              <h3 className="pt-2 text-sm font-semibold">Statutory & Tax</h3>
              <div className="grid grid-cols-2 gap-3">
                <label className="label block">
                  PAN
                  <input
                    className="input mt-1 w-full"
                    value={form.statutory.pan}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, statutory: { ...prev.statutory, pan: event.target.value } }))
                    }
                  />
                </label>
                <label className="label block">
                  UAN {pfApplies ? '' : '(optional)'}
                  <input
                    className="input mt-1 w-full"
                    value={form.statutory.uan}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, statutory: { ...prev.statutory, uan: event.target.value } }))
                    }
                  />
                </label>
                <label className="label block">
                  ESI Number {esiApplies ? '' : '(optional)'}
                  <input
                    className="input mt-1 w-full"
                    value={form.statutory.esiNumber}
                    onChange={(event) =>
                      setForm((prev) => ({
                        ...prev,
                        statutory: { ...prev.statutory, esiNumber: event.target.value },
                      }))
                    }
                  />
                </label>
                <label className="label block">
                  Tax Regime
                  <select
                    className="input mt-1 w-full"
                    value={form.tax.regime}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, tax: { ...prev.tax, regime: event.target.value } }))
                    }
                  >
                    <option value="NEW">New Regime</option>
                    <option value="OLD">Old Regime</option>
                  </select>
                </label>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.statutory.pfMember}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      statutory: { ...prev.statutory, pfMember: event.target.checked },
                    }))
                  }
                />
                PF Member
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.tax.tdsApplicable}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, tax: { ...prev.tax, tdsApplicable: event.target.checked } }))
                  }
                />
                TDS Applicable
              </label>
            </div>

            {/* §9 — live breakup preview */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Live Salary Breakup</h3>
              {!preview ? (
                <p className="text-xs text-crewly-dim">
                  Select an active structure and enter the monthly gross to see the breakup.
                </p>
              ) : (
                <div className="space-y-3">
                  {[
                    { title: 'Earnings', rows: preview.earnings },
                    { title: 'Deductions', rows: preview.deductions },
                    { title: 'Employer Contribution', rows: preview.employerContributions },
                  ].map((section) => (
                    <div key={section.title}>
                      <div className="text-xs uppercase tracking-wide text-crewly-dim">
                        {section.title}
                      </div>
                      <table className="w-full text-left text-xs">
                        <tbody>{previewTable(section.rows || [])}</tbody>
                      </table>
                    </div>
                  ))}

                  <div className="rounded border border-crewly-border p-3 text-sm">
                    <div className="flex justify-between">
                      <span className="text-crewly-dim">Gross / month</span>
                      <span>{formatMoney(preview.totals?.gross)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-crewly-dim">Net pay / month</span>
                      <span>{formatMoney(preview.totals?.netPay)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-crewly-dim">Employer cost / month</span>
                      <span>{formatMoney(preview.totals?.employerCost)}</span>
                    </div>
                    <div className="flex justify-between font-semibold">
                      <span>CTC / year</span>
                      <span>{formatMoney(preview.annual?.ctc)}</span>
                    </div>
                  </div>

                  <p className="text-[11px] text-crewly-dim">
                    Use this figure as the Annual CTC so gross and CTC stay aligned. This preview is
                    for HR verification only — no payroll is generated.
                  </p>
                </div>
              )}
            </div>
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setFormOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn-primary" onClick={submit} disabled={busy}>
              {profile ? 'Save / Revise' : 'Create Profile'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default EmployeePayrollDetailPage;
