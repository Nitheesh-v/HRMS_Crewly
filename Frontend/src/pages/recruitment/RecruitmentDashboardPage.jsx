/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BadgeCheck,
  BriefcaseBusiness,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  FileCheck2,
  Filter,
  RefreshCw,
  TimerReset,
  UserCheck,
  Users,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import usePermission from '../../hooks/usePermission.js';
import recruitmentAnalyticsService from '../../services/recruitmentAnalyticsService.js';

const formatNumber = (value) =>
  Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-IN') : '0';

const formatRate = (value) =>
  value === null || value === undefined ? '—' : `${value}%`;

const formatDays = (value) =>
  value === null || value === undefined ? '—' : `${value}d`;

const dateLabel = (value) =>
  value
    ? new Intl.DateTimeFormat('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      }).format(new Date(value))
    : '—';

const BarRow = ({ label, value, max, tone = 'bg-indigo-400' }) => {
  const width = max > 0 ? Math.max(4, Math.round((value / max) * 100)) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-slate-300">{label}</span>
        <span className="font-medium text-slate-100">{formatNumber(value)}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
};

const Sparkline = ({ points = [] }) => {
  if (!points.length) {
    return <p className="text-sm text-slate-500">No trend data in this period.</p>;
  }
  const max = Math.max(...points.map((point) => point.count), 1);
  return (
    <div className="flex h-24 items-end gap-1">
      {points.slice(-30).map((point) => (
        <div
          key={point.date}
          title={`${point.date}: ${point.count}`}
          className="flex-1 rounded-t bg-indigo-400/80"
          style={{ height: `${Math.max(8, Math.round((point.count / max) * 100))}%` }}
        />
      ))}
    </div>
  );
};

const emptyFilters = {
  range: 'LAST_30_DAYS',
  departmentId: '',
  jobId: '',
  source: '',
  recruiterId: '',
  hiringManagerId: '',
};

const RecruitmentDashboardPage = () => {
  const { hasPermission } = usePermission();
  const canRead = hasPermission('RECRUITMENT_ANALYTICS_READ');
  const [filters, setFilters] = useState(emptyFilters);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!canRead) return;
    setLoading(true);
    setError('');
    try {
      const params = Object.fromEntries(
        Object.entries(filters).filter(([, value]) => Boolean(value))
      );
      const result = await recruitmentAnalyticsService.overview(params);
      setData(result);
    } catch (requestError) {
      setError(requestError.message || 'Recruitment analytics could not be loaded');
    } finally {
      setLoading(false);
    }
  }, [canRead, filters]);

  useEffect(() => {
    load();
  }, [load]);

  const kpis = data?.kpis || {};
  const funnel = data?.funnel || [];
  const funnelMax = Math.max(...funnel.map((item) => item.count || 0), 1);

  const kpiCards = useMemo(
    () => [
      {
        label: 'Pending requisitions',
        value: kpis.pendingRequisitions,
        icon: ClipboardList,
        tone: 'text-amber-300',
      },
      {
        label: 'Open jobs',
        value: kpis.openJobs,
        icon: BriefcaseBusiness,
        tone: 'text-sky-300',
      },
      {
        label: 'Applications',
        value: kpis.applications,
        icon: Users,
        tone: 'text-indigo-300',
      },
      {
        label: 'ATS screened',
        value: kpis.atsScreened,
        icon: Activity,
        tone: 'text-violet-300',
      },
      {
        label: 'Currently shortlisted',
        value: kpis.currentlyShortlisted,
        icon: BadgeCheck,
        tone: 'text-emerald-300',
      },
      {
        label: 'Interviews (period)',
        value: kpis.interviewsInPeriod,
        icon: CalendarClock,
        tone: 'text-cyan-300',
      },
      {
        label: 'Offers sent',
        value: kpis.offersSent,
        icon: FileCheck2,
        tone: 'text-blue-300',
      },
      {
        label: 'Offers accepted',
        value: kpis.offersAccepted,
        icon: CheckCircle2,
        tone: 'text-emerald-300',
      },
      {
        label: 'Ready to join',
        value: kpis.readyToJoin,
        icon: UserCheck,
        tone: 'text-lime-300',
      },
      {
        label: 'Joined (period)',
        value: kpis.joinedInPeriod,
        icon: UserCheck,
        tone: 'text-emerald-200',
      },
    ],
    [kpis]
  );

  if (!canRead) {
    return (
      <div className="rounded-2xl border border-amber-500/25 bg-amber-500/10 p-6 text-amber-100">
        You need RECRUITMENT_ANALYTICS_READ. Pull Phase 27.14, restart the backend, then log out
        and log back in.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">
            Recruitment workspace
          </p>
          <h1 className="mt-2 text-2xl font-bold text-slate-100">Command center</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Funnel, hiring metrics, and operational queues derived from live Phase 27 recruitment
            records. JOINED is conversion-complete only — READY_TO_JOIN is separate.
          </p>
          {data?.range ? (
            <p className="mt-2 text-xs text-slate-500">
              Range {dateLabel(data.range.from)} – {dateLabel(data.range.to)} · preset{' '}
              {data.range.preset}
            </p>
          ) : null}
        </div>
        <button type="button" className="btn-ghost gap-2" onClick={load}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </header>

      <nav className="flex gap-6 overflow-x-auto border-b border-slate-800 text-sm">
        <span className="border-b-2 border-indigo-400 px-1 pb-3 font-semibold text-indigo-300">
          Dashboard
        </span>
        <Link
          to="/app/recruitment/requisitions"
          className="px-1 pb-3 text-slate-400 transition hover:text-slate-200"
        >
          Requisitions
        </Link>
        <Link
          to="/app/recruitment/candidates"
          className="px-1 pb-3 text-slate-400 transition hover:text-slate-200"
        >
          Candidates
        </Link>
        <Link
          to="/app/recruitment/offers"
          className="px-1 pb-3 text-slate-400 transition hover:text-slate-200"
        >
          Offers
        </Link>
        <Link
          to="/app/recruitment/pre-onboarding"
          className="px-1 pb-3 text-slate-400 transition hover:text-slate-200"
        >
          Pre-Onboarding
        </Link>
        <Link
          to="/app/recruitment/interviews"
          className="px-1 pb-3 text-slate-400 transition hover:text-slate-200"
        >
          Interviews
        </Link>
      </nav>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <div className="mb-3 flex items-center gap-2 text-sm text-slate-300">
          <Filter className="h-4 w-4 text-indigo-300" />
          Filters
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <label className="block">
            <span className="label">Range</span>
            <select
              className="input"
              value={filters.range}
              onChange={(event) =>
                setFilters((current) => ({ ...current, range: event.target.value }))
              }
            >
              {(data?.options?.ranges || Object.keys(emptyFilters)).length
                ? (data?.options?.ranges || [
                    'LAST_7_DAYS',
                    'LAST_30_DAYS',
                    'LAST_90_DAYS',
                    'THIS_MONTH',
                    'THIS_QUARTER',
                    'THIS_YEAR',
                  ]).map((range) => (
                    <option key={range} value={range}>
                      {range.replaceAll('_', ' ')}
                    </option>
                  ))
                : null}
            </select>
          </label>
          <label className="block">
            <span className="label">Department</span>
            <select
              className="input"
              value={filters.departmentId}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  departmentId: event.target.value,
                }))
              }
            >
              <option value="">All departments</option>
              {(data?.options?.departments || []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Job</span>
            <select
              className="input"
              value={filters.jobId}
              onChange={(event) =>
                setFilters((current) => ({ ...current, jobId: event.target.value }))
              }
            >
              <option value="">All open jobs</option>
              {(data?.options?.jobs || []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.jobCode ? `${item.jobCode} · ` : ''}
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Source</span>
            <select
              className="input"
              value={filters.source}
              onChange={(event) =>
                setFilters((current) => ({ ...current, source: event.target.value }))
              }
            >
              <option value="">All sources</option>
              {(data?.options?.sources || []).map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Recruiter</span>
            <select
              className="input"
              value={filters.recruiterId}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  recruiterId: event.target.value,
                }))
              }
            >
              <option value="">All recruiters</option>
              {(data?.options?.people || []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end">
            <button
              type="button"
              className="btn-ghost w-full"
              onClick={() => setFilters(emptyFilters)}
            >
              Reset filters
            </button>
          </div>
        </div>
      </section>

      {error ? (
        <p
          role="alert"
          className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-sm text-rose-200"
        >
          {error}
        </p>
      ) : null}

      {loading ? (
        <div className="h-64 animate-pulse rounded-2xl bg-slate-900" />
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            {kpiCards.map((card) => {
              const Icon = card.icon;
              return (
                <div
                  key={card.label}
                  className="rounded-2xl border border-slate-800 bg-slate-900 p-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">
                      {card.label}
                    </p>
                    <Icon className={`h-4 w-4 ${card.tone}`} />
                  </div>
                  <p className={`mt-3 text-2xl font-bold ${card.tone}`}>
                    {formatNumber(card.value)}
                  </p>
                </div>
              );
            })}
          </section>

          <section className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="font-semibold text-slate-100">Recruitment funnel</h2>
              <p className="mt-1 text-xs text-slate-500">
                Distinct candidates reaching each milestone in range. Conversion % is from the
                previous stage.
              </p>
              <div className="mt-5 space-y-4">
                {funnel.map((step) => (
                  <div key={step.key} className="space-y-1">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-slate-200">{step.label}</span>
                      <span className="text-slate-100">
                        {formatNumber(step.count)}
                        <span className="ml-2 text-xs text-slate-500">
                          {formatRate(step.conversionFromPrevious)} prev
                        </span>
                      </span>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-slate-800">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-emerald-400"
                        style={{
                          width: `${Math.max(4, Math.round((step.count / funnelMax) * 100))}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-5">
              <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
                <div className="flex items-center gap-2">
                  <TimerReset className="h-4 w-4 text-indigo-300" />
                  <h2 className="font-semibold">Hiring speed</h2>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-xl bg-slate-950/50 p-3">
                    <dt className="text-xs text-slate-500">Time to hire (avg)</dt>
                    <dd className="mt-1 text-lg font-semibold text-slate-100">
                      {formatDays(data?.timeToHire?.averageDays)}
                    </dd>
                    <p className="mt-1 text-[11px] text-slate-500">
                      median {formatDays(data?.timeToHire?.medianDays)} · n=
                      {data?.timeToHire?.sampleSize || 0}
                    </p>
                  </div>
                  <div className="rounded-xl bg-slate-950/50 p-3">
                    <dt className="text-xs text-slate-500">Time to fill (proxy)</dt>
                    <dd className="mt-1 text-lg font-semibold text-slate-100">
                      {formatDays(data?.timeToFill?.averageDays)}
                    </dd>
                    <p className="mt-1 text-[11px] text-slate-500">
                      n={data?.timeToFill?.sampleSize || 0}
                    </p>
                  </div>
                  <div className="rounded-xl bg-slate-950/50 p-3">
                    <dt className="text-xs text-slate-500">Offer acceptance</dt>
                    <dd className="mt-1 text-lg font-semibold text-emerald-300">
                      {formatRate(data?.conversionRates?.offerAcceptanceRate)}
                    </dd>
                  </div>
                  <div className="rounded-xl bg-slate-950/50 p-3">
                    <dt className="text-xs text-slate-500">Accepted → joined</dt>
                    <dd className="mt-1 text-lg font-semibold text-emerald-300">
                      {formatRate(data?.conversionRates?.acceptedToJoined)}
                    </dd>
                  </div>
                </dl>
                <p className="mt-3 text-[11px] leading-5 text-slate-500">
                  {data?.definitions?.timeToHire}
                </p>
              </div>

              <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
                <h2 className="font-semibold">Applications trend</h2>
                <div className="mt-4">
                  <Sparkline points={data?.trends?.applications || []} />
                </div>
              </div>
            </div>
          </section>

          <section className="grid gap-5 lg:grid-cols-3">
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="font-semibold">Sources</h2>
              <div className="mt-4 space-y-3">
                {(data?.sourceAnalytics || []).map((row) => (
                  <div
                    key={row.source}
                    className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-sm"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-medium text-slate-100">{row.label}</p>
                      <p className="text-emerald-300">{formatRate(row.conversionRate)}</p>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {formatNumber(row.applications)} applications · {formatNumber(row.joined)}{' '}
                      joined
                    </p>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="font-semibold">ATS distribution</h2>
              <p className="mt-1 text-xs text-slate-500">
                Assistive only — not an automatic hiring decision.
              </p>
              <div className="mt-4 space-y-3">
                {(data?.atsDistribution || []).map((row) => (
                  <BarRow
                    key={row.category}
                    label={`${row.category} (${formatRate(row.percentage)})`}
                    value={row.count}
                    max={Math.max(
                      ...(data?.atsDistribution || []).map((item) => item.count || 0),
                      1
                    )}
                    tone={
                      row.category === 'STRONG'
                        ? 'bg-emerald-400'
                        : row.category === 'GOOD'
                          ? 'bg-sky-400'
                          : row.category === 'MODERATE'
                            ? 'bg-amber-400'
                            : 'bg-slate-500'
                    }
                  />
                ))}
                {!data?.atsDistribution?.length ? (
                  <p className="text-sm text-slate-500">No ATS results in this period.</p>
                ) : null}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="font-semibold">Offer outcomes</h2>
              <div className="mt-4 space-y-3 text-sm">
                {[
                  ['Sent', data?.offerMetrics?.sent],
                  ['Accepted', data?.offerMetrics?.accepted],
                  ['Rejected', data?.offerMetrics?.rejected],
                  ['Expired', data?.offerMetrics?.expired],
                  ['Withdrawn', data?.offerMetrics?.withdrawn],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-3">
                    <span className="text-slate-400">{label}</span>
                    <span className="font-medium text-slate-100">{formatNumber(value)}</span>
                  </div>
                ))}
                <div className="rounded-xl bg-emerald-500/10 p-3 text-emerald-200">
                  Acceptance rate {formatRate(data?.offerMetrics?.acceptanceRate)}
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="font-semibold text-slate-100">Operational work queue</h2>
            <div className="mt-4 grid gap-4 xl:grid-cols-2">
              {[
                {
                  title: 'Requisitions awaiting approval',
                  items: data?.workQueue?.requisitionsAwaitingApproval || [],
                  render: (item) => `${item.code || item.id} · ${item.title || 'Requisition'}`,
                },
                {
                  title: 'Interviews today',
                  items: data?.workQueue?.interviewsToday || [],
                  render: (item) =>
                    `${item.candidateName || 'Candidate'} · ${item.jobTitle || 'Interview'}`,
                },
                {
                  title: 'Feedback pending',
                  items: data?.workQueue?.feedbackPending || [],
                  render: (item) =>
                    `${item.candidateName || 'Candidate'} · ${item.candidateCode || ''}`.trim(),
                },
                {
                  title: 'Offers pending approval',
                  items: data?.workQueue?.offersPendingApproval || [],
                  render: (item) =>
                    `${item.offerCode} · ${item.candidateName || 'Candidate'}`,
                },
                {
                  title: 'Offers awaiting candidate',
                  items: data?.workQueue?.offersAwaitingCandidate || [],
                  render: (item) =>
                    `${item.offerCode} · ${item.status} · ${item.candidateName || ''}`.trim(),
                },
                {
                  title: 'Documents awaiting verification',
                  items: data?.workQueue?.documentsAwaitingVerification || [],
                  render: (item) =>
                    `${item.code || ''} · ${item.candidateName || 'Candidate'} · ${item.status}`,
                },
                {
                  title: 'Ready to join',
                  items: data?.workQueue?.readyToJoin || [],
                  render: (item) =>
                    `${item.candidateName || 'Candidate'} · ${item.code || 'READY'}`,
                },
              ].map((queue) => (
                <div
                  key={queue.title}
                  className="rounded-xl border border-slate-800 bg-slate-950/40 p-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold text-slate-100">{queue.title}</h3>
                    <span className="text-xs text-slate-500">{queue.items.length}</span>
                  </div>
                  <div className="mt-3 space-y-2">
                    {queue.items.length ? (
                      queue.items.slice(0, 5).map((item) => (
                        <Link
                          key={item.id}
                          to={item.href || '/app/recruitment'}
                          className="block rounded-lg border border-slate-800 px-3 py-2 text-sm text-slate-300 hover:border-indigo-500/30 hover:text-slate-100"
                        >
                          {queue.render(item)}
                        </Link>
                      ))
                    ) : (
                      <p className="text-sm text-slate-500">Queue is clear.</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
            <div className="border-b border-slate-800 px-5 py-4">
              <h2 className="font-semibold">Jobs</h2>
              <p className="mt-1 text-xs text-slate-500">
                Open/recent jobs with period applications and current joined counts.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-slate-950/50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Job</th>
                    <th className="px-4 py-3">Department</th>
                    <th className="px-4 py-3">Apps</th>
                    <th className="px-4 py-3">Joined</th>
                    <th className="px-4 py-3">Avg ATS</th>
                    <th className="px-4 py-3">Age</th>
                    <th className="px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.jobs || []).length ? (
                    data.jobs.map((job) => (
                      <tr key={job.id} className="border-t border-slate-800/80">
                        <td className="px-4 py-3">
                          <Link
                            to={`/app/recruitment/candidates?jobId=${job.id}`}
                            className="font-medium text-slate-100 hover:text-indigo-300"
                          >
                            {job.jobCode ? `${job.jobCode} · ` : ''}
                            {job.title}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-slate-300">{job.departmentName}</td>
                        <td className="px-4 py-3 text-slate-300">
                          {formatNumber(job.applications)}
                        </td>
                        <td className="px-4 py-3 text-slate-300">{formatNumber(job.joined)}</td>
                        <td className="px-4 py-3 text-slate-300">
                          {job.averageAtsScore ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-slate-300">
                          {job.ageDays == null ? '—' : `${job.ageDays}d (${job.ageBucket})`}
                        </td>
                        <td className="px-4 py-3 text-slate-300">{job.status}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan="7" className="px-4 py-10 text-center text-slate-500">
                        No jobs match the current filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
};

export default RecruitmentDashboardPage;
