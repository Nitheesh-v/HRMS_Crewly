/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  UserPlus2,
} from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import usePermission from '../../hooks/usePermission.js';
import conversionService from '../../services/conversionService.js';

const toDateInput = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
};

const ConvertToEmployeePage = () => {
  const { candidateRef } = useParams();
  const navigate = useNavigate();
  const { hasPermission } = usePermission();
  const canConvert = hasPermission('CANDIDATE_CONVERT');

  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [form, setForm] = useState({
    employeeCode: '',
    departmentId: '',
    managerId: '',
    shiftId: '',
    role: 'EMPLOYEE',
    designation: '',
    location: '',
    employmentType: 'FULL_TIME',
    joiningDate: '',
    phone: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await conversionService.preview(candidateRef);
      setPreview(data);
      if (data?.prefill) {
        setForm((current) => ({
          ...current,
          employeeCode: data.prefill.employeeCode || '',
          departmentId: data.prefill.departmentId || '',
          managerId: data.prefill.managerId || '',
          role: data.prefill.role || 'EMPLOYEE',
          designation: data.prefill.designation || '',
          location: data.prefill.location || '',
          employmentType: data.prefill.employmentType || 'FULL_TIME',
          joiningDate: toDateInput(data.prefill.joiningDate),
          phone: data.prefill.phone || '',
        }));
      }
      if (data?.alreadyConverted && data?.employee) {
        setResult({
          employee: data.employee,
          conversion: data.conversion,
          idempotent: true,
        });
      }
    } catch (requestError) {
      setError(requestError.message || 'Conversion preview failed');
    } finally {
      setLoading(false);
    }
  }, [candidateRef]);

  useEffect(() => {
    load();
  }, [load]);

  const submit = async (event) => {
    event.preventDefault();
    if (!canConvert) return;
    setBusy(true);
    setError('');
    try {
      const payload = {
        ...form,
        employeeCode: form.employeeCode || undefined,
        departmentId: form.departmentId || undefined,
        managerId: form.managerId || undefined,
        shiftId: form.shiftId || undefined,
        joiningDate: form.joiningDate
          ? `${form.joiningDate}T00:00:00.000Z`
          : undefined,
      };
      const data = await conversionService.convert(candidateRef, payload);
      setResult(data);
    } catch (requestError) {
      setError(requestError.message || 'Conversion failed');
    } finally {
      setBusy(false);
    }
  };

  if (!canConvert) {
    return (
      <div className="rounded-2xl border border-amber-500/25 bg-amber-500/10 p-6 text-amber-100">
        You need CANDIDATE_CONVERT permission. Log out/in after pulling Phase 27.13.
      </div>
    );
  }

  if (loading) {
    return <div className="h-64 animate-pulse rounded-2xl bg-slate-900" />;
  }

  if (result?.employee) {
    const employee = result.employee;
    return (
      <div className="mx-auto max-w-3xl space-y-5">
        <Link
          to={`/app/recruitment/candidates/${candidateRef}`}
          className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-slate-100"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to candidate
        </Link>
        <section className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-6">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="h-6 w-6 text-emerald-300" />
            <div>
              <h1 className="text-xl font-bold text-slate-100">Candidate converted</h1>
              <p className="mt-1 text-sm text-slate-300">
                {result.idempotent
                  ? 'This candidate was already converted. Showing the existing employee.'
                  : 'Employee account created with secure password setup (no temp password emailed).'}
              </p>
            </div>
          </div>
          <dl className="mt-5 grid gap-3 sm:grid-cols-2">
            {[
              ['Employee ID', employee.employeeCode],
              ['Name', employee.name],
              ['Email', employee.email],
              ['Designation', employee.designation],
              ['Account setup', result.conversion?.accountSetupStatus || result.meta?.accountSetup || 'PENDING'],
              ['Onboarding', result.conversion?.onboardingStarted || result.meta?.onboardingStarted ? 'Started' : 'Pending'],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                <dt className="text-[10px] uppercase tracking-wide text-slate-500">{label}</dt>
                <dd className="mt-1 text-sm text-slate-100">{value || '—'}</dd>
              </div>
            ))}
          </dl>
          {/* Phase 29.4 §19 / §26 — the offer already seeded a DRAFT payroll
              profile (name, email, department, designation, joining date and
              offered CTC). HR only completes structure, bank, statutory IDs
              and tax regime. */}
          {employee?.id || employee?._id ? (
            <p className="mt-4 rounded-xl border border-slate-800 bg-slate-950/40 p-4 text-sm text-slate-300">
              A draft payroll profile was created from the offer. Complete the salary structure, bank
              details, statutory IDs and tax regime to make this employee payroll-ready.{' '}
              <button
                type="button"
                className="text-indigo-300 hover:underline"
                onClick={() => navigate(`/app/payroll/employees/${employee.id || employee._id}`)}
              >
                Open payroll profile
              </button>
            </p>
          ) : null}
          <div className="mt-6 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary"
              onClick={() => navigate(`/app/users`)}
            >
              Open employees
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => navigate('/app/lifecycle')}
            >
              Open onboarding / lifecycle
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => navigate(`/app/recruitment/candidates/${candidateRef}`)}
            >
              View candidate history
            </button>
          </div>
        </section>
      </div>
    );
  }

  const eligible = Boolean(preview?.eligible);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <Link
        to={`/app/recruitment/candidates/${candidateRef}`}
        className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-slate-100"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to candidate
      </Link>

      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-indigo-300">
            <UserPlus2 className="h-5 w-5" />
            <p className="text-xs font-semibold uppercase tracking-[0.2em]">Conversion</p>
          </div>
          <h1 className="mt-2 text-2xl font-bold text-slate-100">Convert to employee</h1>
          <p className="mt-1 text-sm text-slate-400">
            Creates one User/employee, links recruitment history, starts lifecycle onboarding,
            and sends a secure password setup link.
          </p>
        </div>
      </header>

      {error ? (
        <p role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-sm text-rose-200">
          {error}
        </p>
      ) : null}

      {!eligible ? (
        <section className="rounded-2xl border border-amber-500/25 bg-amber-500/10 p-5 text-sm text-amber-100">
          <p className="font-semibold">Not eligible yet</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {(preview?.blockingReasons || ['Candidate is not ready']).map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <form onSubmit={submit} className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="font-semibold text-slate-100">Employment details</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block sm:col-span-2">
              <span className="label">Full name</span>
              <input className="input" value={preview?.candidate?.name || ''} disabled />
            </label>
            <label className="block sm:col-span-2">
              <span className="label">Work email</span>
              <input className="input" value={preview?.candidate?.email || ''} disabled />
            </label>
            <label className="block">
              <span className="label">Employee code (optional)</span>
              <input
                className="input"
                value={form.employeeCode}
                onChange={(event) =>
                  setForm((current) => ({ ...current, employeeCode: event.target.value }))
                }
                placeholder="Auto EMP-0001 if empty"
              />
            </label>
            <label className="block">
              <span className="label">Role</span>
              <select
                className="input"
                value={form.role}
                onChange={(event) =>
                  setForm((current) => ({ ...current, role: event.target.value }))
                }
              >
                {(preview?.options?.roles || [{ value: 'EMPLOYEE', label: 'EMPLOYEE' }]).map(
                  (role) => (
                    <option key={role.value} value={role.value}>
                      {role.label}
                    </option>
                  )
                )}
              </select>
            </label>
            <label className="block">
              <span className="label">Department *</span>
              <select
                className="input"
                required
                value={form.departmentId}
                onChange={(event) =>
                  setForm((current) => ({ ...current, departmentId: event.target.value }))
                }
              >
                <option value="">Select department</option>
                {(preview?.options?.departments || []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label">Reporting manager</span>
              <select
                className="input"
                value={form.managerId}
                onChange={(event) =>
                  setForm((current) => ({ ...current, managerId: event.target.value }))
                }
              >
                <option value="">Not assigned</option>
                {(preview?.options?.managers || []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.role})
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label">Designation *</span>
              <input
                className="input"
                required
                value={form.designation}
                onChange={(event) =>
                  setForm((current) => ({ ...current, designation: event.target.value }))
                }
              />
            </label>
            <label className="block">
              <span className="label">Joining date *</span>
              <input
                className="input"
                type="date"
                required
                value={form.joiningDate}
                onChange={(event) =>
                  setForm((current) => ({ ...current, joiningDate: event.target.value }))
                }
              />
            </label>
            <label className="block">
              <span className="label">Location</span>
              <input
                className="input"
                value={form.location}
                onChange={(event) =>
                  setForm((current) => ({ ...current, location: event.target.value }))
                }
              />
            </label>
            <label className="block">
              <span className="label">Employment type</span>
              <select
                className="input"
                value={form.employmentType}
                onChange={(event) =>
                  setForm((current) => ({ ...current, employmentType: event.target.value }))
                }
              >
                {['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'TEMPORARY'].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label">Shift (optional)</span>
              <select
                className="input"
                value={form.shiftId}
                onChange={(event) =>
                  setForm((current) => ({ ...current, shiftId: event.target.value }))
                }
              >
                <option value="">Not assigned</option>
                {(preview?.options?.shifts || []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label">Phone</span>
              <input
                className="input"
                value={form.phone}
                onChange={(event) =>
                  setForm((current) => ({ ...current, phone: event.target.value }))
                }
              />
            </label>
          </div>

          <button
            type="submit"
            className="btn-primary gap-2"
            disabled={!eligible || busy}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus2 className="h-4 w-4" />}
            Confirm and create employee
          </button>
        </form>

        <aside className="space-y-4">
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="font-semibold">Accepted offer</h2>
            <dl className="mt-3 space-y-3 text-sm">
              {[
                ['Offer', preview?.offer?.offerCode],
                ['Designation', preview?.offer?.designation],
                ['Department', preview?.offer?.departmentName],
                ['Joining', toDateInput(preview?.offer?.joiningDate) || '—'],
                [
                  'CTC',
                  preview?.offer?.compensation
                    ? `${preview.offer.compensation.currency} ${preview.offer.compensation.annualCTC}`
                    : '—',
                ],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-[10px] uppercase tracking-wide text-slate-500">{label}</dt>
                  <dd className="mt-1 text-slate-200">{value || '—'}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="font-semibold">Pre-onboarding</h2>
            <p className="mt-2 text-sm text-slate-300">
              {preview?.preOnboarding
                ? `${preview.preOnboarding.verifiedRequired || 0}/${preview.preOnboarding.totalRequired || 0} mandatory verified · ${preview.preOnboarding.status}`
                : 'Not ready'}
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
};

export default ConvertToEmployeePage;
