/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import {
  ClipboardList,
  RefreshCw,
  Search,
  Settings2,
  UserCheck,
} from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import PreOnboardingStatusBadge from '../../components/recruitment/PreOnboardingStatusBadge.jsx';
import usePermission from '../../hooks/usePermission.js';
import preOnboardingService from '../../services/preOnboardingService.js';

const dateLabel = (value) =>
  value
    ? new Intl.DateTimeFormat('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      }).format(new Date(value))
    : 'Not set';

const statuses = [
  '',
  'IN_PROGRESS',
  'ACTION_REQUIRED',
  'UNDER_REVIEW',
  'COMPLETED',
  'READY_TO_JOIN',
  'WITHDRAWN',
];

const PreOnboardingPage = () => {
  const navigate = useNavigate();
  const { hasPermission } = usePermission();
  const canManageSettings = hasPermission('PRE_ONBOARDING_SETTINGS_READ');
  const [cases, setCases] = useState([]);
  const [meta, setMeta] = useState({ kpis: {} });
  const [filters, setFilters] = useState({ status: '', search: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await preOnboardingService.list({
        ...filters,
        search: filters.search || undefined,
        status: filters.status || undefined,
      });
      setCases(result.cases);
      setMeta(result.meta || {});
    } catch (requestError) {
      setError(requestError.message || 'Pre-onboarding cases could not be loaded');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  const kpis = [
    {
      label: 'Offer accepted',
      value: meta.kpis?.offerAccepted || 0,
      tone: 'text-slate-200',
    },
    {
      label: 'In progress',
      value: meta.kpis?.inProgress || 0,
      tone: 'text-sky-300',
    },
    {
      label: 'Action required',
      value: meta.kpis?.actionRequired || 0,
      tone: 'text-amber-300',
    },
    {
      label: 'Under review',
      value: meta.kpis?.underReview || 0,
      tone: 'text-indigo-300',
    },
    {
      label: 'Ready to join',
      value: meta.kpis?.readyToJoin || 0,
      tone: 'text-emerald-300',
    },
  ];

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-indigo-300">
            <ClipboardList className="h-5 w-5" />
            <p className="text-xs font-semibold uppercase tracking-[0.2em]">
              Recruitment
            </p>
          </div>
          <h1 className="mt-2 text-2xl font-bold text-slate-100">Pre-Onboarding</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Collect and verify joining documents after offer acceptance. Candidates stay
            in recruitment until ready to join.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canManageSettings ? (
            <Link to="/app/recruitment/pre-onboarding/requirements" className="btn-ghost gap-2">
              <Settings2 className="h-4 w-4" />
              Requirements
            </Link>
          ) : null}
          <button type="button" className="btn-ghost gap-2" onClick={load}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {kpis.map((item) => (
          <div
            key={item.label}
            className="rounded-2xl border border-slate-800 bg-slate-900 p-4"
          >
            <p className="text-xs uppercase tracking-wide text-slate-500">{item.label}</p>
            <p className={`mt-2 text-2xl font-bold ${item.tone}`}>{item.value}</p>
          </div>
        ))}
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <div className="flex flex-col gap-3 lg:flex-row">
          <label className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              className="input pl-10"
              placeholder="Search candidate, code, or job"
              value={filters.search}
              onChange={(event) =>
                setFilters((current) => ({ ...current, search: event.target.value }))
              }
            />
          </label>
          <select
            className="input lg:w-56"
            value={filters.status}
            onChange={(event) =>
              setFilters((current) => ({ ...current, status: event.target.value }))
            }
          >
            <option value="">All statuses</option>
            {statuses.filter(Boolean).map((status) => (
              <option key={status} value={status}>
                {status.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </div>
      </section>

      {error ? (
        <p role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-sm text-rose-200">
          {error}
        </p>
      ) : null}

      <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-slate-800 bg-slate-950/60 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Candidate</th>
                <th className="px-4 py-3 font-medium">Job</th>
                <th className="px-4 py-3 font-medium">Joining</th>
                <th className="px-4 py-3 font-medium">Documents</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="6" className="px-4 py-10 text-center text-slate-500">
                    Loading pre-onboarding cases...
                  </td>
                </tr>
              ) : cases.length === 0 ? (
                <tr>
                  <td colSpan="6" className="px-4 py-10 text-center text-slate-500">
                    No pre-onboarding cases yet. Start from an offer-accepted candidate.
                  </td>
                </tr>
              ) : (
                cases.map((item) => (
                  <tr
                    key={item.id}
                    className="border-t border-slate-800/80 hover:bg-slate-950/40"
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-100">{item.candidate?.name}</p>
                      <p className="text-xs text-slate-500">
                        {item.candidate?.candidateCode || item.preOnboardingCode}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-slate-300">{item.job?.title}</td>
                    <td className="px-4 py-3 text-slate-300">
                      {dateLabel(item.offer?.joiningDate)}
                    </td>
                    <td className="px-4 py-3 text-slate-300">
                      {item.verifiedRequiredDocumentCount || 0}/
                      {item.requiredDocumentCount || 0} verified
                      {item.readiness?.resubmissionRequired ? (
                        <span className="mt-1 block text-xs text-amber-300">
                          {item.readiness.resubmissionRequired} resubmission
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <PreOnboardingStatusBadge status={item.status} />
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        className="btn-ghost gap-2"
                        onClick={() =>
                          navigate(`/app/recruitment/pre-onboarding/${item.id}`)
                        }
                      >
                        <UserCheck className="h-4 w-4" />
                        Open
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};

export default PreOnboardingPage;
