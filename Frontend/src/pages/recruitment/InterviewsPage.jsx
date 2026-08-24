/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import {
  CalendarClock,
  CheckCircle2,
  Clock3,
  Eye,
  Filter,
  List,
  Search,
  UserRoundCheck,
  Users,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import InterviewDetailModal from '../../components/recruitment/InterviewDetailModal.jsx';
import usePermission from '../../hooks/usePermission.js';
import interviewService from '../../services/interviewService.js';

const DEFAULT_ROUNDS = [
  { key: 'TECHNICAL_1', name: 'Technical Round 1' },
  { key: 'TECHNICAL_2', name: 'Technical Round 2' },
  { key: 'MANAGER', name: 'Manager Round' },
  { key: 'HR_FINAL', name: 'HR Final Round' },
];
const STATUSES = [
  'SCHEDULED',
  'RESCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
];
const EMPTY_FILTERS = {
  search: '',
  status: '',
  roundKey: '',
  interviewer: '',
  dateFrom: '',
  dateTo: '',
};
const statusTone = {
  SCHEDULED: 'border-sky-500/30 bg-sky-500/10 text-sky-200',
  RESCHEDULED: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-200',
  IN_PROGRESS: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
  COMPLETED: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  CANCELLED: 'border-slate-600 bg-slate-800 text-slate-300',
  NO_SHOW: 'border-rose-500/30 bg-rose-500/10 text-rose-200',
};

const enumLabel = (value = '') =>
  String(value)
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const dateTimeLabel = (value, timezone) =>
  value
    ? new Intl.DateTimeFormat('en-IN', {
        timeZone: timezone || undefined,
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(value))
    : 'Not scheduled';

const agendaDateKey = (value, timezone) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));

const agendaDayLabel = (value, timezone) =>
  new Intl.DateTimeFormat('en-IN', {
    timeZone: timezone || undefined,
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(new Date(value));

const StatusBadge = ({ status }) => (
  <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${statusTone[status] || statusTone.CANCELLED}`}>
    {enumLabel(status)}
  </span>
);

const KpiCard = ({ icon: Icon, label, value, detail }) => (
  <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
        <p className="mt-2 text-2xl font-bold text-slate-100">{value}</p>
      </div>
      <span className="rounded-xl bg-indigo-500/10 p-2 text-indigo-300">
        <Icon className="h-5 w-5" />
      </span>
    </div>
    <p className="mt-2 text-[11px] text-slate-500">{detail}</p>
  </div>
);

export const InterviewWorkspace = ({ assignmentOnly = false }) => {
  const { hasPermission } = usePermission();
  const canReadAll = hasPermission('INTERVIEW_READ');
  const [view, setView] = useState('upcoming');
  const [draftFilters, setDraftFilters] = useState(EMPTY_FILTERS);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [interviews, setInterviews] = useState([]);
  const [meta, setMeta] = useState({ page: 1, pages: 1, total: 0, kpis: {} });
  const [options, setOptions] = useState({ rounds: DEFAULT_ROUNDS, interviewers: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedInterviewId, setSelectedInterviewId] = useState('');

  useEffect(() => {
    document.title = assignmentOnly
      ? 'My interviews — Crewly HRMS'
      : 'Interview management — Crewly HRMS';
    if (!assignmentOnly) {
      interviewService
        .options()
        .then((result) => setOptions({
          rounds: Array.isArray(result.rounds) ? result.rounds : DEFAULT_ROUNDS,
          interviewers: Array.isArray(result.interviewers) ? result.interviewers : [],
        }))
        .catch(() => {});
    }
  }, [assignmentOnly]);

  const loadInterviews = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = {
        page,
        limit: 20,
        view,
        ...Object.fromEntries(
          Object.entries(filters).filter(([, value]) => value !== '')
        ),
      };
      const result = assignmentOnly
        ? await interviewService.myInterviews(params)
        : await interviewService.list(params);
      setInterviews(result.interviews);
      setMeta({
        page: result.meta.page || page,
        pages: result.meta.pages || 1,
        total: result.meta.total || 0,
        kpis: result.meta.kpis || {},
      });
    } catch (requestError) {
      setInterviews([]);
      setError(requestError?.message || 'Interviews could not be loaded');
    } finally {
      setLoading(false);
    }
  }, [assignmentOnly, filters, page, view]);

  useEffect(() => {
    loadInterviews();
  }, [loadInterviews]);

  const applyFilters = (event) => {
    event.preventDefault();
    setPage(1);
    setFilters(draftFilters);
  };
  const clearFilters = () => {
    setDraftFilters(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
    setPage(1);
  };
  const updateFilter = (event) => {
    const { name, value } = event.target;
    setDraftFilters((current) => ({ ...current, [name]: value }));
  };
  const changeView = (nextView) => {
    setView(nextView);
    setPage(1);
  };

  const kpis = meta.kpis || {};
  const agendaGroups = interviews.reduce((groups, interview) => {
    const key = agendaDateKey(interview.scheduledStartAt, interview.timezone);
    const current = groups.get(key) || {
      key,
      label: agendaDayLabel(interview.scheduledStartAt, interview.timezone),
      interviews: [],
    };
    current.interviews.push(interview);
    groups.set(key, current);
    return groups;
  }, new Map());

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="flex items-center gap-2 text-sm font-medium text-indigo-300">
            <CalendarClock className="h-4 w-4" /> Recruitment
          </p>
          <h1 className="mt-1 text-2xl font-bold text-slate-100">
            {assignmentOnly ? 'My interviews' : 'Interview management'}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            {assignmentOnly
              ? 'Your assignment-only agenda. Candidate access is limited to interviews assigned to you.'
              : 'Manage interview schedules, participants, operational status, and the auditable interview timeline.'}
          </p>
        </div>
        {!assignmentOnly ? (
          <Link to="/app/recruitment/candidates" className="btn-primary inline-flex items-center justify-center gap-2">
            <Users className="h-4 w-4" /> Choose candidate to schedule
          </Link>
        ) : null}
      </header>

      <nav className="flex gap-6 overflow-x-auto border-b border-slate-800 text-sm">
        {!assignmentOnly ? (
          <>
            <Link to="/app/recruitment/requisitions" className="px-1 pb-3 text-slate-400 hover:text-slate-200">Requisitions</Link>
            <Link to="/app/recruitment/candidates" className="px-1 pb-3 text-slate-400 hover:text-slate-200">Candidates</Link>
            <span className="border-b-2 border-indigo-400 px-1 pb-3 font-semibold text-indigo-300">Interviews</span>
            <Link to="/app/recruitment/my-interviews" className="px-1 pb-3 text-slate-400 hover:text-slate-200">My interviews</Link>
          </>
        ) : (
          <>
            {canReadAll ? (
              <Link to="/app/recruitment/interviews" className="px-1 pb-3 text-slate-400 hover:text-slate-200">Interview management</Link>
            ) : null}
            <span className="border-b-2 border-indigo-400 px-1 pb-3 font-semibold text-indigo-300">My interviews</span>
          </>
        )}
      </nav>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <KpiCard icon={CalendarClock} label="Today" value={kpis.today || 0} detail="Company-local calendar day" />
        <KpiCard icon={Clock3} label="Upcoming" value={kpis.upcoming || 0} detail="Active future assignments" />
        <KpiCard icon={UserRoundCheck} label="In progress" value={kpis.inProgress || 0} detail="Operational status" />
        <KpiCard icon={CheckCircle2} label="Completed" value={kpis.completed || 0} detail="Operational completion only" />
        <KpiCard icon={List} label="Feedback pending" value={kpis.feedbackPending || 0} detail="Not enabled in Phase 27.9" />
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="inline-flex w-fit rounded-xl border border-slate-800 bg-slate-950 p-1">
            <button
              type="button"
              className={`rounded-lg px-4 py-2 text-sm ${view === 'upcoming' ? 'bg-indigo-500/15 text-indigo-200' : 'text-slate-400'}`}
              onClick={() => changeView('upcoming')}
            >
              Upcoming agenda
            </button>
            <button
              type="button"
              className={`rounded-lg px-4 py-2 text-sm ${view === 'all' ? 'bg-indigo-500/15 text-indigo-200' : 'text-slate-400'}`}
              onClick={() => changeView('all')}
            >
              All interviews
            </button>
          </div>
          <p className="text-xs text-slate-500">{meta.total} matching interview{meta.total === 1 ? '' : 's'}</p>
        </div>

        <form className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-7" onSubmit={applyFilters}>
          <label className="relative sm:col-span-2 xl:col-span-2">
            <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-500" />
            <input
              name="search"
              className="input pl-9"
              maxLength={120}
              value={draftFilters.search}
              onChange={updateFilter}
              placeholder="Candidate, job, or INT code"
            />
          </label>
          <select name="status" className="input" value={draftFilters.status} onChange={updateFilter}>
            <option value="">All statuses</option>
            {STATUSES.map((status) => <option key={status} value={status}>{enumLabel(status)}</option>)}
          </select>
          <select name="roundKey" className="input" value={draftFilters.roundKey} onChange={updateFilter}>
            <option value="">All rounds</option>
            {options.rounds.map((round) => <option key={round.key} value={round.key}>{round.name}</option>)}
          </select>
          {!assignmentOnly ? (
            <select name="interviewer" className="input" value={draftFilters.interviewer} onChange={updateFilter}>
              <option value="">All interviewers</option>
              {options.interviewers.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>
          ) : null}
          <input type="date" name="dateFrom" className="input" value={draftFilters.dateFrom} onChange={updateFilter} aria-label="From date" />
          <input type="date" name="dateTo" className="input" value={draftFilters.dateTo} onChange={updateFilter} aria-label="To date" />
          <div className={`flex gap-2 ${assignmentOnly ? 'xl:col-span-2' : ''}`}>
            <button type="submit" className="btn-primary flex-1 justify-center gap-2"><Filter className="h-4 w-4" /> Apply</button>
            <button type="button" className="btn-ghost" onClick={clearFilters}>Clear</button>
          </div>
        </form>
      </section>

      {error ? (
        <div className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-4 text-sm text-rose-200">{error}</div>
      ) : null}

      <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
        {loading ? (
          <div className="h-72 animate-pulse bg-slate-950/30" />
        ) : interviews.length ? (
          <>
            {view === 'upcoming' ? (
              <div className="space-y-6 p-4 sm:p-5">
                {[...agendaGroups.values()].map((group) => (
                  <section key={group.key}>
                    <div className="mb-3 flex items-center gap-3">
                      <span className="h-2 w-2 rounded-full bg-indigo-400" />
                      <h2 className="text-sm font-semibold text-slate-200">{group.label}</h2>
                      <span className="text-xs text-slate-600">{group.interviews.length}</span>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {group.interviews.map((interview) => (
                        <article key={interview.id} className="rounded-xl border border-slate-800 bg-slate-950/35 p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="font-medium text-slate-100">{interview.candidate?.name}</p>
                              <p className="mt-1 text-xs text-indigo-300">{interview.round?.name}</p>
                            </div>
                            <StatusBadge status={interview.status} />
                          </div>
                          <p className="mt-3 text-sm text-slate-300">
                            {dateTimeLabel(interview.scheduledStartAt, interview.timezone)}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            {interview.job?.title} · {interview.durationMinutes} min
                          </p>
                          <p className="mt-3 line-clamp-2 text-xs text-slate-400">
                            {interview.interviewers?.map((person) => person.name).join(', ')}
                          </p>
                          <button
                            type="button"
                            className="btn-ghost mt-4 w-full justify-center gap-2"
                            onClick={() => setSelectedInterviewId(interview.id)}
                          >
                            <Eye className="h-4 w-4" /> Open detail
                          </button>
                        </article>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            ) : (
              <>
                <div className="hidden overflow-x-auto lg:block">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead className="border-b border-slate-800 bg-slate-950/30 text-[11px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-5 py-3">Schedule</th>
                    <th className="px-5 py-3">Candidate</th>
                    <th className="px-5 py-3">Position and round</th>
                    <th className="px-5 py-3">Interviewers</th>
                    <th className="px-5 py-3">Status</th>
                    <th className="px-5 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {interviews.map((interview) => (
                    <tr key={interview.id} className="hover:bg-slate-950/25">
                      <td className="px-5 py-4">
                        <p className="font-medium text-slate-200">{dateTimeLabel(interview.scheduledStartAt, interview.timezone)}</p>
                        <p className="mt-1 text-xs text-slate-500">{interview.durationMinutes} min · {enumLabel(interview.interviewType)}</p>
                      </td>
                      <td className="px-5 py-4">
                        <p className="font-medium text-slate-200">{interview.candidate?.name}</p>
                        <p className="mt-1 font-mono text-xs text-indigo-300">{interview.candidate?.candidateCode}</p>
                      </td>
                      <td className="px-5 py-4">
                        <p className="text-slate-200">{interview.job?.title}</p>
                        <p className="mt-1 text-xs text-slate-500">{interview.round?.name} · {interview.interviewCode}</p>
                      </td>
                      <td className="px-5 py-4">
                        <p className="max-w-56 text-xs leading-5 text-slate-300">
                          {interview.interviewers?.map((person) => person.name).join(', ')}
                        </p>
                      </td>
                      <td className="px-5 py-4"><StatusBadge status={interview.status} /></td>
                      <td className="px-5 py-4 text-right">
                        <button type="button" className="btn-ghost inline-flex items-center gap-2" onClick={() => setSelectedInterviewId(interview.id)}>
                          <Eye className="h-4 w-4" /> Detail
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="divide-y divide-slate-800 lg:hidden">
              {interviews.map((interview) => (
                <article key={interview.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-slate-100">{interview.candidate?.name}</p>
                      <p className="mt-1 text-xs text-indigo-300">{interview.round?.name}</p>
                    </div>
                    <StatusBadge status={interview.status} />
                  </div>
                  <p className="mt-3 text-sm text-slate-300">{dateTimeLabel(interview.scheduledStartAt, interview.timezone)}</p>
                  <p className="mt-1 text-xs text-slate-500">{interview.job?.title} · {interview.interviewCode}</p>
                  <button type="button" className="btn-ghost mt-4 w-full justify-center gap-2" onClick={() => setSelectedInterviewId(interview.id)}>
                    <Eye className="h-4 w-4" /> Open detail
                  </button>
                </article>
              ))}
            </div>
              </>
            )}
          </>
        ) : (
          <div className="p-10 text-center">
            <CalendarClock className="mx-auto h-9 w-9 text-slate-700" />
            <h2 className="mt-3 font-semibold text-slate-200">No interviews found</h2>
            <p className="mt-1 text-sm text-slate-500">Adjust filters or schedule from an eligible candidate record.</p>
          </div>
        )}
      </section>

      {meta.pages > 1 ? (
        <div className="flex items-center justify-between">
          <button type="button" className="btn-ghost" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>Previous</button>
          <p className="text-xs text-slate-500">Page {meta.page} of {meta.pages}</p>
          <button type="button" className="btn-ghost" disabled={page >= meta.pages} onClick={() => setPage((current) => current + 1)}>Next</button>
        </div>
      ) : null}

      {selectedInterviewId ? (
        <InterviewDetailModal
          interviewId={selectedInterviewId}
          onClose={() => setSelectedInterviewId('')}
          onChanged={loadInterviews}
        />
      ) : null}
    </div>
  );
};

const InterviewsPage = () => <InterviewWorkspace />;

export default InterviewsPage;
