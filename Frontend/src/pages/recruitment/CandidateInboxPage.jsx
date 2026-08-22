/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import {
  BriefcaseBusiness,
  CheckSquare2,
  FileCheck2,
  Filter,
  Inbox,
  MapPin,
  Search,
  Send,
  UserRoundSearch,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import Modal from '../../components/Modal.jsx';
import usePermission from '../../hooks/usePermission.js';
import candidateService from '../../services/candidateService.js';
import recruitmentService from '../../services/recruitmentService.js';
import {
  DISPOSITION_PIPELINE_STAGES,
  PIPELINE_STAGES,
  PIPELINE_STAGE_LABELS,
  POSITIVE_PIPELINE_STAGES,
} from './pipelineStages.js';

const EMPTY_FILTERS = {
  search: '',
  job: '',
  source: '',
  stage: '',
  dateFrom: '',
  dateTo: '',
};

const dateLabel = (value) =>
  value
    ? new Intl.DateTimeFormat('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      }).format(new Date(value))
    : 'Not available';

const sourceLabel = (value) =>
  value === 'CAREER_PAGE' ? 'Career page' : 'Internal';

const BULK_ACTION_LABELS = {
  SHORTLIST: 'Shortlist',
  REJECT: 'Reject',
  HOLD: 'Put on hold',
  MOVE_STAGE: 'Move to stage',
  ASSIGN_RECRUITER: 'Assign recruiter',
  ASSIGN_HIRING_MANAGER: 'Assign hiring manager',
  SEND_EMAIL: 'Send status notification',
};

const EMPTY_BULK_FORM = {
  action: 'SHORTLIST',
  targetStage: '',
  userId: '',
  reason: '',
};

const CandidateInboxPage = () => {
  const { hasPermission } = usePermission();
  const canUpdateCandidates = hasPermission('CANDIDATE_UPDATE');
  const [draftFilters, setDraftFilters] = useState(EMPTY_FILTERS);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [candidates, setCandidates] = useState([]);
  const [meta, setMeta] = useState({ page: 1, pages: 1, total: 0 });
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);
  const [pipelineOptions, setPipelineOptions] = useState({
    stages: PIPELINE_STAGES,
    recruiters: [],
    hiringManagers: [],
  });
  const [bulkModal, setBulkModal] = useState(false);
  const [bulkForm, setBulkForm] = useState(EMPTY_BULK_FORM);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState(null);

  useEffect(() => {
    document.title = 'Candidate inbox — Crewly HRMS';
    recruitmentService
      .jobs()
      .then((result) => setJobs(Array.isArray(result) ? result : []))
      .catch(() => setJobs([]));

    if (canUpdateCandidates) {
      candidateService
        .pipelineOptions()
        .then((result) => setPipelineOptions({
          stages: Array.isArray(result.stages) ? result.stages : PIPELINE_STAGES,
          recruiters: Array.isArray(result.recruiters) ? result.recruiters : [],
          hiringManagers: Array.isArray(result.hiringManagers)
            ? result.hiringManagers
            : [],
        }))
        .catch(() => {});
    }
  }, [canUpdateCandidates]);

  const loadCandidates = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const params = {
        page,
        limit: 20,
        ...Object.fromEntries(
          Object.entries(filters).filter(([, value]) => value !== '')
        ),
      };
      const result = await candidateService.list(params);
      setCandidates(result.candidates);
      setSelectedIds([]);
      setMeta({
        page: result.meta.page || page,
        pages: result.meta.pages || 1,
        total: result.meta.total || 0,
      });
    } catch (requestError) {
      setCandidates([]);
      setError(requestError?.message || 'Candidates could not be loaded');
    } finally {
      setLoading(false);
    }
  }, [filters, page]);

  useEffect(() => {
    loadCandidates();
  }, [loadCandidates]);

  const updateFilter = (event) => {
    const { name, value } = event.target;
    setDraftFilters((current) => ({ ...current, [name]: value }));
  };

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

  const toggleCandidate = (candidateId) => {
    setSelectedIds((current) =>
      current.includes(candidateId)
        ? current.filter((id) => id !== candidateId)
        : [...current, candidateId]
    );
  };

  const toggleAllCandidates = () => {
    setSelectedIds((current) =>
      current.length === candidates.length
        ? []
        : candidates.map((candidate) => candidate.id)
    );
  };

  const openBulkActions = () => {
    setBulkForm(EMPTY_BULK_FORM);
    setBulkResult(null);
    setBulkModal(true);
  };

  const runBulkAction = async (event) => {
    event.preventDefault();
    setBulkBusy(true);
    setBulkResult(null);

    try {
      const result = await candidateService.bulkAction({
        candidateIds: selectedIds,
        action: bulkForm.action,
        ...(bulkForm.targetStage ? { targetStage: bulkForm.targetStage } : {}),
        ...(bulkForm.userId ? { userId: bulkForm.userId } : {}),
        ...(bulkForm.reason.trim() ? { reason: bulkForm.reason.trim() } : {}),
      });
      setBulkResult(result);
      if (!result.failed?.length) {
        setSelectedIds([]);
        await loadCandidates();
      } else {
        const failedIds = result.failed.map((item) => String(item.candidateId));
        await loadCandidates();
        setSelectedIds(
          selectedIds.filter((id) => failedIds.includes(String(id)))
        );
      }
    } catch (requestError) {
      setBulkResult({
        summary: { requested: selectedIds.length, succeeded: 0, failed: selectedIds.length },
        failed: [{ message: requestError?.message || 'Bulk action could not be completed' }],
      });
    } finally {
      setBulkBusy(false);
    }
  };

  const assignmentOptions = bulkForm.action === 'ASSIGN_RECRUITER'
    ? pipelineOptions.recruiters
    : pipelineOptions.hiringManagers;
  const selectedCandidates = candidates.filter((candidate) =>
    selectedIds.includes(candidate.id)
  );
  const bulkMoveNeedsReason = bulkForm.action === 'MOVE_STAGE' &&
    selectedCandidates.some((candidate) => {
      const currentIndex = POSITIVE_PIPELINE_STAGES.indexOf(
        candidate.currentStage || candidate.stage
      );
      const targetIndex = POSITIVE_PIPELINE_STAGES.indexOf(bulkForm.targetStage);
      return currentIndex >= 0 && targetIndex >= 0 && targetIndex < currentIndex;
    });
  const bulkReasonRequired = ['REJECT', 'HOLD'].includes(bulkForm.action) ||
    DISPOSITION_PIPELINE_STAGES.includes(bulkForm.targetStage) ||
    bulkMoveNeedsReason;

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="flex items-center gap-2 text-sm font-medium text-indigo-300">
            <Inbox className="h-4 w-4" /> Recruitment
          </p>
          <h1 className="mt-1 text-2xl font-bold text-slate-100">Candidate inbox</h1>
          <p className="mt-1 text-sm text-slate-400">
            Review structured applications and securely access original resumes.
          </p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 text-right">
          <p className="text-xs uppercase tracking-wide text-slate-500">Candidates</p>
          <p className="mt-1 text-xl font-bold text-slate-100">{meta.total}</p>
        </div>
      </header>

      <nav className="flex gap-6 overflow-x-auto border-b border-slate-800 text-sm">
        <Link to="/app/recruitment/requisitions" className="px-1 pb-3 text-slate-400 hover:text-slate-200">
          Requisitions
        </Link>
        <span className="border-b-2 border-indigo-400 px-1 pb-3 font-semibold text-indigo-300">
          Candidates
        </span>
        <Link to="/app/recruitment/legacy" className="px-1 pb-3 text-slate-400 hover:text-slate-200">
          Jobs &amp; pipeline
        </Link>
      </nav>

      <form onSubmit={applyFilters} className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <Filter className="h-4 w-4 text-indigo-300" /> Filters
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <label className="relative sm:col-span-2">
            <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-500" />
            <input
              className="input pl-9"
              name="search"
              value={draftFilters.search}
              onChange={updateFilter}
              maxLength={100}
              placeholder="Search name, email, reference or skill"
            />
          </label>
          <select className="input" name="job" value={draftFilters.job} onChange={updateFilter}>
            <option value="">All jobs</option>
            {jobs.map((job) => (
              <option key={job._id} value={job._id}>{job.title} ({job.jobCode})</option>
            ))}
          </select>
          <select className="input" name="source" value={draftFilters.source} onChange={updateFilter}>
            <option value="">All sources</option>
            <option value="CAREER_PAGE">Career page</option>
            <option value="INTERNAL">Internal</option>
          </select>
          <select className="input" name="stage" value={draftFilters.stage} onChange={updateFilter}>
            <option value="">All stages</option>
            {PIPELINE_STAGES.map((stage) => (
              <option key={stage} value={stage}>{PIPELINE_STAGE_LABELS[stage]}</option>
            ))}
          </select>
          <label>
            <span className="mb-1 block text-xs text-slate-500">Applied from</span>
            <input className="input" type="date" name="dateFrom" value={draftFilters.dateFrom} onChange={updateFilter} />
          </label>
          <label>
            <span className="mb-1 block text-xs text-slate-500">Applied through</span>
            <input className="input" type="date" name="dateTo" value={draftFilters.dateTo} onChange={updateFilter} />
          </label>
          <div className="flex items-end gap-2">
            <button className="btn-primary flex-1 justify-center" type="submit">Apply</button>
            <button className="btn-ghost" type="button" onClick={clearFilters}>Clear</button>
          </div>
        </div>
      </form>

      {error ? (
        <div role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {error}
        </div>
      ) : null}

      {canUpdateCandidates && candidates.length > 0 ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-indigo-500/20 bg-indigo-500/5 p-4 sm:flex-row sm:items-center sm:justify-between">
          <label className="flex items-center gap-3 text-sm text-slate-300">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-indigo-500"
              checked={selectedIds.length === candidates.length}
              onChange={toggleAllCandidates}
            />
            Select this page
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-indigo-200">
              {selectedIds.length} selected
            </span>
          </label>
          <button
            type="button"
            className="btn-primary gap-2"
            onClick={openBulkActions}
            disabled={!selectedIds.length}
          >
            <CheckSquare2 className="h-4 w-4" /> Bulk actions
          </button>
        </div>
      ) : null}

      {loading ? (
        <div className="grid gap-3">
          {[1, 2, 3].map((item) => <div key={item} className="h-28 animate-pulse rounded-2xl bg-slate-900" />)}
        </div>
      ) : candidates.length === 0 ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-10 text-center">
          <UserRoundSearch className="mx-auto h-9 w-9 text-slate-600" />
          <h2 className="mt-3 font-semibold text-slate-200">No candidates found</h2>
          <p className="mt-1 text-sm text-slate-500">Try clearing filters or wait for a new application.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {candidates.map((candidate) => (
            <div
              key={candidate.id}
              className={`flex items-start gap-4 rounded-2xl border bg-slate-900 p-5 transition ${
                selectedIds.includes(candidate.id)
                  ? 'border-indigo-500/50'
                  : 'border-slate-800'
              }`}
            >
              {canUpdateCandidates ? (
                <input
                  type="checkbox"
                  aria-label={`Select ${candidate.name}`}
                  className="mt-1 h-4 w-4 shrink-0 rounded border-slate-600 bg-slate-900 text-indigo-500"
                  checked={selectedIds.includes(candidate.id)}
                  onChange={() => toggleCandidate(candidate.id)}
                />
              ) : null}
              <Link
                to={`/app/recruitment/candidates/${candidate.candidateCode || candidate.id}`}
                className="min-w-0 flex-1 hover:opacity-90"
              >
              <div className="flex flex-col gap-4 xl:flex-row xl:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-semibold text-slate-100">{candidate.name}</h2>
                    <span className="rounded-full border border-indigo-500/25 bg-indigo-500/10 px-2 py-0.5 font-mono text-[10px] text-indigo-300">
                      {candidate.candidateCode}
                    </span>
                    <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                      {PIPELINE_STAGE_LABELS[candidate.currentStage || candidate.stage] || candidate.stage}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-sm text-slate-400">{candidate.email} · {candidate.phone || 'No phone'}</p>
                  <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-500">
                    <span className="inline-flex items-center gap-1.5"><BriefcaseBusiness className="h-3.5 w-3.5" /> {candidate.job?.title || 'Job unavailable'}</span>
                    <span className="inline-flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" /> {candidate.location || 'Location not provided'}</span>
                    <span>{candidate.experience.total} years total experience</span>
                  </div>
                  {candidate.skills.length ? (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {candidate.skills.slice(0, 6).map((skill) => (
                        <span key={skill} className="rounded-md bg-slate-800 px-2 py-1 text-[10px] text-slate-300">{skill}</span>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="grid shrink-0 grid-cols-2 gap-3 text-xs sm:grid-cols-3 xl:w-[380px]">
                  <div className="rounded-xl bg-slate-950/50 p-3">
                    <p className="text-slate-500">Source</p>
                    <p className="mt-1 font-medium text-slate-200">{sourceLabel(candidate.source)}</p>
                  </div>
                  <div className="rounded-xl bg-slate-950/50 p-3">
                    <p className="text-slate-500">Applied</p>
                    <p className="mt-1 font-medium text-slate-200">{dateLabel(candidate.applicationDate)}</p>
                  </div>
                  <div className="rounded-xl bg-slate-950/50 p-3">
                    <p className="text-slate-500">Resume</p>
                    <p className={`mt-1 inline-flex items-center gap-1 font-medium ${candidate.resumeAvailable ? 'text-emerald-300' : 'text-slate-500'}`}>
                      <FileCheck2 className="h-3.5 w-3.5" /> {candidate.resumeAvailable ? 'Available' : 'None'}
                    </p>
                  </div>
                </div>
              </div>
              </Link>
            </div>
          ))}
        </div>
      )}

      {meta.pages > 1 ? (
        <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm">
          <button className="btn-ghost" type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1}>Previous</button>
          <span className="text-slate-400">Page {meta.page} of {meta.pages}</span>
          <button className="btn-ghost" type="button" onClick={() => setPage((value) => Math.min(meta.pages, value + 1))} disabled={page >= meta.pages}>Next</button>
        </div>
      ) : null}

      {bulkModal ? (
        <Modal
          title={`Bulk candidate action · ${selectedIds.length} selected`}
          onClose={() => !bulkBusy && setBulkModal(false)}
        >
          <form className="space-y-4" onSubmit={runBulkAction}>
            <div>
              <label className="label">Action</label>
              <select
                className="input"
                value={bulkForm.action}
                onChange={(event) => {
                  setBulkForm({
                    ...EMPTY_BULK_FORM,
                    action: event.target.value,
                  });
                  setBulkResult(null);
                }}
              >
                {Object.entries(BULK_ACTION_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>

            {bulkForm.action === 'MOVE_STAGE' ? (
              <div>
                <label className="label">Target stage *</label>
                <select
                  className="input"
                  value={bulkForm.targetStage}
                  onChange={(event) => setBulkForm((current) => ({
                    ...current,
                    targetStage: event.target.value,
                  }))}
                  required
                >
                  <option value="">Choose a stage</option>
                  {pipelineOptions.stages.map((stage) => (
                    <option key={stage} value={stage}>{PIPELINE_STAGE_LABELS[stage]}</option>
                  ))}
                </select>
              </div>
            ) : null}

            {['ASSIGN_RECRUITER', 'ASSIGN_HIRING_MANAGER'].includes(bulkForm.action) ? (
              <div>
                <label className="label">
                  {bulkForm.action === 'ASSIGN_RECRUITER' ? 'Recruiter' : 'Hiring manager'} *
                </label>
                <select
                  className="input"
                  value={bulkForm.userId}
                  onChange={(event) => setBulkForm((current) => ({
                    ...current,
                    userId: event.target.value,
                  }))}
                  required
                >
                  <option value="">Choose an eligible user</option>
                  {assignmentOptions.map((user) => (
                    <option key={user.id} value={user.id}>{user.name} · {user.role}</option>
                  ))}
                </select>
              </div>
            ) : null}

            {['REJECT', 'HOLD', 'MOVE_STAGE'].includes(bulkForm.action) ? (
              <div>
                <label className="label">Common reason {bulkReasonRequired ? '*' : '(optional)'}</label>
                <textarea
                  className="input min-h-24"
                  value={bulkForm.reason}
                  onChange={(event) => setBulkForm((current) => ({
                    ...current,
                    reason: event.target.value,
                  }))}
                  required={bulkReasonRequired}
                  maxLength={1000}
                  placeholder="This reason is recorded separately for every selected candidate"
                />
                <p className="mt-1 text-right text-[10px] text-slate-500">{bulkForm.reason.length}/1000</p>
              </div>
            ) : null}

            {bulkForm.action === 'SEND_EMAIL' ? (
              <div className="flex items-start gap-3 rounded-xl border border-sky-500/20 bg-sky-500/10 p-4 text-sm text-sky-100">
                <Send className="mt-0.5 h-4 w-4 shrink-0" />
                Each candidate will receive Crewly's fixed application-status notification. No free-form HTML or body content is accepted.
              </div>
            ) : null}

            {bulkResult ? (
              <div className={`rounded-xl border p-4 text-sm ${
                bulkResult.summary?.failed
                  ? 'border-amber-500/25 bg-amber-500/10 text-amber-100'
                  : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-100'
              }`}>
                <p className="font-semibold">
                  {bulkResult.summary?.succeeded || 0} succeeded · {bulkResult.summary?.failed || 0} failed
                </p>
                {bulkResult.failed?.length ? (
                  <ul className="mt-2 space-y-1 text-xs">
                    {bulkResult.failed.map((item, index) => (
                      <li key={`${item.candidateId || 'request'}-${index}`}>
                        {item.candidateCode ? `${item.candidateCode}: ` : ''}{item.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            <div className="flex justify-end gap-2 border-t border-slate-800 pt-4">
              <button type="button" className="btn-ghost" onClick={() => setBulkModal(false)} disabled={bulkBusy}>Close</button>
              <button
                type="submit"
                className="btn-primary"
                disabled={
                  bulkBusy ||
                  !selectedIds.length ||
                  (bulkReasonRequired && !bulkForm.reason.trim())
                }
              >
                {bulkBusy ? 'Processing individually…' : 'Run bulk action'}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
};

export default CandidateInboxPage;
