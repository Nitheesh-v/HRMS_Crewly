/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  BriefcaseBusiness,
  Building2,
  CalendarClock,
  Clock3,
  Download,
  ExternalLink,
  FileSearch,
  FileText,
  GitBranch,
  GraduationCap,
  Languages,
  Link2,
  Mail,
  MapPin,
  Phone,
  RefreshCw,
  ShieldCheck,
  UserRound,
  Wrench,
} from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import Modal from '../../components/Modal.jsx';
import ATSAnalysisPanel from '../../components/recruitment/ATSAnalysisPanel.jsx';
import CandidateFinalReview from '../../components/recruitment/CandidateFinalReview.jsx';
import CandidateOfferPanel from '../../components/recruitment/CandidateOfferPanel.jsx';
import CandidatePreOnboardingPanel from '../../components/recruitment/CandidatePreOnboardingPanel.jsx';
import CandidateConversionPanel from '../../components/recruitment/CandidateConversionPanel.jsx';
import CandidateBgvPanel from '../../components/recruitment/CandidateBgvPanel.jsx';
import InterviewDetailModal from '../../components/recruitment/InterviewDetailModal.jsx';
import InterviewScheduleModal from '../../components/recruitment/InterviewScheduleModal.jsx';
import usePermission from '../../hooks/usePermission.js';
import candidateService from '../../services/candidateService.js';
import interviewService from '../../services/interviewService.js';
import {
  DISPOSITION_PIPELINE_STAGES,
  PIPELINE_STAGES,
  PIPELINE_STAGE_LABELS,
  POSITIVE_PIPELINE_STAGES,
} from './pipelineStages.js';

const dateLabel = (value) =>
  value
    ? new Intl.DateTimeFormat('en-IN', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(value))
    : 'Not provided';

const moneyLabel = (value) =>
  value === null || value === undefined
    ? 'Not provided'
    : new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 0,
      }).format(value);

const enumLabel = (value = '') =>
  String(value)
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const safeHref = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
};

const Value = ({ label, value }) => (
  <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
    <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
    <p className="mt-1.5 break-words text-sm font-medium text-slate-200">{value || 'Not provided'}</p>
  </div>
);

const Section = ({ icon: Icon, title, children }) => (
  <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-6">
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-indigo-300" />
      <h2 className="font-semibold text-slate-100">{title}</h2>
    </div>
    <div className="mt-4">{children}</div>
  </section>
);

const parserStatus = {
  PENDING: {
    label: 'Pending',
    detail: 'Secure resume extraction is queued.',
    tone: 'border-amber-500/25 bg-amber-500/10 text-amber-200',
  },
  RETRY_PENDING: {
    label: 'Retry pending',
    detail: 'Authorized reprocessing is queued.',
    tone: 'border-amber-500/25 bg-amber-500/10 text-amber-200',
  },
  PROCESSING: {
    label: 'Processing',
    detail: 'Text is being extracted and normalized.',
    tone: 'border-sky-500/25 bg-sky-500/10 text-sky-200',
  },
  COMPLETED: {
    label: 'Completed',
    detail: 'Parser-derived fields are ready for HR review.',
    tone: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200',
  },
  FAILED: {
    label: 'Failed safely',
    detail: 'The original application and resume were preserved.',
    tone: 'border-rose-500/25 bg-rose-500/10 text-rose-200',
  },
  REVIEW_REQUIRED: {
    label: 'Review required',
    detail: 'Little or no machine-readable text was found.',
    tone: 'border-orange-500/25 bg-orange-500/10 text-orange-200',
  },
  UNSUPPORTED: {
    label: 'Unsupported',
    detail: 'This document could not be processed by the safe extractor.',
    tone: 'border-slate-600 bg-slate-800 text-slate-200',
  },
};

const parseDateLabel = (value) => value?.original || 'Date not identified';

const confidenceLabel = (value) =>
  `${Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100)}%`;

const timelineLabel = (action) =>
  ({
    CANDIDATE_APPLIED: 'Application received',
    APPLICATION_CONFIRMATION_SENT: 'Application confirmation sent',
    APPLICATION_CONFIRMATION_FAILED: 'Application confirmation delivery failed',
    RESUME_PARSE_STARTED: 'Resume parsing started',
    RESUME_PARSED: 'Resume parsing completed',
    RESUME_PARSE_FAILED: 'Resume parsing failed safely',
    RESUME_REPROCESS_REQUESTED: 'Resume reprocessing requested',
    ATS_PROCESSED: 'ATS analysis completed',
    ATS_REPROCESSED: 'ATS analysis recalculated',
    STAGE_CHANGED: 'Pipeline stage changed',
    CANDIDATE_ASSIGNMENT_UPDATED: 'Candidate assignment updated',
    CANDIDATE_EMAIL_SENT: 'Status notification sent',
    INTERVIEW_SCHEDULED: 'Interview scheduled',
    INTERVIEW_RESCHEDULED: 'Interview rescheduled',
    INTERVIEW_CANCELLED: 'Interview cancelled',
    INTERVIEW_STARTED: 'Interview started',
    INTERVIEW_COMPLETED: 'Interview completed',
    INTERVIEW_NO_SHOW: 'Interview marked no-show',
    INTERVIEW_FEEDBACK_SUBMITTED: 'Interview feedback submitted',
    FINAL_REVIEW_STARTED: 'Final Review started',
    CANDIDATE_SELECTED: 'Candidate selected by human decision',
    CANDIDATE_REJECTED: 'Candidate rejected by human decision',
    CANDIDATE_HOLD: 'Candidate placed on hold by human decision',
    OFFER_DRAFT_CREATED: 'Offer draft created',
    OFFER_UPDATED: 'Offer terms updated',
    OFFER_SUBMITTED: 'Offer submitted for approval',
    OFFER_APPROVED: 'Offer approved',
    OFFER_APPROVAL_INVALIDATED: 'Offer approval invalidated by material edit',
    OFFER_RETURNED: 'Offer returned for changes',
    OFFER_SEND_FAILED: 'Offer delivery failed safely',
    OFFER_SENT: 'Offer delivered securely',
    OFFER_VIEWED: 'Offer viewed by candidate',
    OFFER_ACCEPTED: 'Offer accepted by candidate',
    OFFER_REJECTED: 'Offer rejected by candidate',
    OFFER_EXPIRED: 'Offer expired',
    OFFER_WITHDRAWN: 'Offer withdrawn',
    PRE_ONBOARDING_STARTED: 'Pre-onboarding started',
    DOCUMENT_REQUESTED: 'Pre-onboarding documents requested',
    DOCUMENT_UPLOADED: 'Candidate document uploaded',
    DOCUMENT_RESUBMITTED: 'Candidate document resubmitted',
    DOCUMENT_UNDER_REVIEW: 'Document moved under review',
    DOCUMENT_VERIFIED: 'Document verified',
    DOCUMENT_REJECTED: 'Document rejected',
    DOCUMENT_RESUBMISSION_REQUIRED: 'Document resubmission required',
    PRE_ONBOARDING_COMPLETED: 'Pre-onboarding documents completed',
    READY_TO_JOIN: 'Candidate marked ready to join',
    CANDIDATE_CONVERSION_STARTED: 'Employee conversion started',
    CANDIDATE_CONVERTED: 'Candidate converted to employee',
    EMPLOYEE_CREATED: 'Employee account created',
    ACCOUNT_SETUP_SENT: 'Account setup invitation sent',
    ACCOUNT_SETUP_COMPLETED: 'Employee account setup completed',
    ONBOARDING_STARTED: 'Employee onboarding started',
    CANDIDATE_JOINED: 'Candidate marked joined',
    BGV_STARTED: 'Background verification started',
    BGV_INFORMATION_REQUESTED: 'BGV information requested',
    BGV_REVIEW_REQUIRED: 'BGV review required',
    BGV_COMPLETED: 'Background verification completed',
  })[action] || enumLabel(action);

const INTERVIEW_ROUNDS = [
  { key: 'TECHNICAL_1', name: 'Technical Round 1', sequence: 1 },
  { key: 'TECHNICAL_2', name: 'Technical Round 2', sequence: 2 },
  { key: 'MANAGER', name: 'Manager Round', sequence: 3 },
  { key: 'HR_FINAL', name: 'HR Final Round', sequence: 4 },
];

const INTERVIEW_STATUS_TONE = {
  SCHEDULED: 'border-sky-500/30 bg-sky-500/10 text-sky-200',
  RESCHEDULED: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-200',
  IN_PROGRESS: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
  COMPLETED: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  CANCELLED: 'border-slate-600 bg-slate-800 text-slate-300',
  NO_SHOW: 'border-rose-500/30 bg-rose-500/10 text-rose-200',
};

const interviewDateLabel = (value, timezone) =>
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

const ParserCollection = ({ title, items, renderItem }) => {
  if (!items?.length) return null;

  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      <div className="mt-2 space-y-2">
        {items.map((item, index) => (
          <div key={`${title}-${index}`} className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
            {renderItem(item)}
          </div>
        ))}
      </div>
    </div>
  );
};

const ParsedResumePanel = ({
  parsed,
  loading,
  error,
  canReprocess,
  reprocessBusy,
  reprocessMessage,
  onReprocess,
}) => {
  if (loading) {
    return <div className="h-44 animate-pulse rounded-2xl bg-slate-900" />;
  }

  if (!parsed) {
    return (
      <Section icon={FileSearch} title="Parser-derived resume information">
        <p className="text-sm text-slate-500">{error || 'Parser information is not available for this resume.'}</p>
      </Section>
    );
  }

  const status = parserStatus[parsed.status] || parserStatus.PENDING;
  const data = parsed.structuredData || {};
  const namedGroups = [
    ['Awards', data.awards],
    ['Achievements', data.achievements],
    ['Publications', data.publications],
    ['Volunteering', data.volunteering],
  ];
  const hasParsedData = parsed.status === 'COMPLETED';

  return (
    <Section icon={FileSearch} title="Parser-derived resume information">
      <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${status.tone}`}>
              {status.label}
            </span>
            <p className="mt-2 text-sm text-slate-300">{status.detail}</p>
            <p className="mt-1 text-xs text-slate-500">
              Source: Resume parser · Version {parsed.parserVersion || 'Awaiting parser'} · Attempt {parsed.attemptCount || 0}
            </p>
            {parsed.completedAt ? (
              <p className="mt-1 text-xs text-slate-500">Processed {dateLabel(parsed.completedAt)}</p>
            ) : null}
          </div>
          {canReprocess && parsed.reprocessAvailable ? (
            <button
              type="button"
              className="btn-ghost shrink-0 gap-2"
              onClick={onReprocess}
              disabled={reprocessBusy}
            >
              <RefreshCw className={`h-4 w-4 ${reprocessBusy ? 'animate-spin' : ''}`} />
              {reprocessBusy ? 'Scheduling…' : 'Reprocess resume'}
            </button>
          ) : null}
        </div>
        {reprocessMessage ? <p className="mt-3 text-xs text-emerald-300">{reprocessMessage}</p> : null}
      </div>

      {error ? (
        <div role="alert" className="mt-3 rounded-xl border border-rose-500/25 bg-rose-500/10 p-4 text-sm text-rose-200">
          {error}
        </div>
      ) : null}

      {parsed.failure ? (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-rose-500/25 bg-rose-500/10 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
          <div>
            <p className="text-sm font-medium text-rose-200">{parsed.failure.message}</p>
            <p className="mt-1 text-xs text-rose-300/70">Category: {enumLabel(parsed.failure.category)}</p>
          </div>
        </div>
      ) : null}

      {parsed.warnings?.length ? (
        <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-300">Safe extraction warnings</p>
          <ul className="mt-2 space-y-1 text-sm text-amber-100/80">
            {parsed.warnings.map((warning, index) => <li key={`${warning}-${index}`}>• {warning}</li>)}
          </ul>
        </div>
      ) : null}

      {hasParsedData ? (
        <div className="mt-5 space-y-5">
          <div>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Extraction confidence</h3>
              <span className="text-sm font-semibold text-indigo-200">
                {confidenceLabel(parsed.extractionConfidence?.overall)}
              </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full rounded-full bg-indigo-400"
                style={{ width: confidenceLabel(parsed.extractionConfidence?.overall) }}
              />
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Confidence measures extraction reliability only. It is not a candidate score or hiring assessment.
            </p>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Extracted identity</h3>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <Value label="Name" value={data.identity?.name} />
              <Value label="Email" value={data.identity?.email} />
              <Value label="Phone" value={data.identity?.phone} />
              <Value label="Location" value={data.identity?.location} />
            </div>
          </div>

          {data.summary ? (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Summary</h3>
              <p className="mt-2 whitespace-pre-line rounded-xl border border-slate-800 bg-slate-950/40 p-4 text-sm leading-6 text-slate-300">
                {data.summary}
              </p>
            </div>
          ) : null}

          {data.skills?.length ? (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Normalized skills</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                {data.skills.map((skill, index) => (
                  <span key={`${skill.normalized}-${index}`} className="rounded-lg border border-indigo-500/20 bg-indigo-500/10 px-2.5 py-1.5 text-xs text-indigo-200">
                    {skill.display}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <ParserCollection
            title="Work experience"
            items={data.workExperience}
            renderItem={(item) => (
              <div>
                <p className="font-medium text-slate-200">{item.title || 'Role not identified'}</p>
                <p className="mt-1 text-sm text-slate-400">{item.employer || 'Employer not identified'}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {parseDateLabel(item.startDate)} — {item.isCurrent ? 'Present' : parseDateLabel(item.endDate)}
                </p>
                {item.description ? <p className="mt-2 whitespace-pre-line text-sm leading-6 text-slate-400">{item.description}</p> : null}
              </div>
            )}
          />

          {data.derivedExperienceMonths ? (
            <p className="text-xs text-slate-500">
              Derived non-overlapping employment duration: {Math.floor(data.derivedExperienceMonths / 12)} years {data.derivedExperienceMonths % 12} months.
            </p>
          ) : null}

          <ParserCollection
            title="Education"
            items={data.education}
            renderItem={(item) => (
              <div>
                <p className="font-medium text-slate-200">{item.qualification || 'Qualification not identified'}</p>
                <p className="mt-1 text-sm text-slate-400">{item.institution || 'Institution not identified'}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {parseDateLabel(item.startDate)} — {parseDateLabel(item.endDate)}
                </p>
                {item.grade ? <p className="mt-1 text-xs text-slate-400">Grade: {item.grade}</p> : null}
              </div>
            )}
          />

          <ParserCollection
            title="Certifications"
            items={data.certifications}
            renderItem={(item) => (
              <div>
                <p className="font-medium text-slate-200">{item.name || 'Certification'}</p>
                {item.issuer ? <p className="mt-1 text-sm text-slate-400">{item.issuer}</p> : null}
                {item.issuedDate?.original ? <p className="mt-1 text-xs text-slate-500">Issued {item.issuedDate.original}</p> : null}
              </div>
            )}
          />

          <ParserCollection
            title="Projects"
            items={data.projects}
            renderItem={(item) => (
              <div>
                <p className="font-medium text-slate-200">{item.name || 'Project'}</p>
                {item.description ? <p className="mt-2 whitespace-pre-line text-sm leading-6 text-slate-400">{item.description}</p> : null}
                {safeHref(item.url) ? (
                  <a className="mt-2 inline-flex items-center gap-1 text-xs text-indigo-300" href={safeHref(item.url)} target="_blank" rel="noreferrer">
                    Project link <ExternalLink className="h-3 w-3" />
                  </a>
                ) : null}
              </div>
            )}
          />

          <div className="grid gap-4 lg:grid-cols-2">
            {data.languages?.length ? (
              <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <Languages className="h-3.5 w-3.5" /> Languages
                </h3>
                <div className="mt-2 space-y-1 text-sm text-slate-300">
                  {data.languages.map((item, index) => (
                    <p key={`${item.name}-${index}`}>{item.name}{item.proficiency ? ` · ${item.proficiency}` : ''}</p>
                  ))}
                </div>
              </div>
            ) : null}
            {data.links?.length ? (
              <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <Link2 className="h-3.5 w-3.5" /> Extracted links
                </h3>
                <div className="mt-2 space-y-2">
                  {data.links.filter((item) => safeHref(item.url)).map((item, index) => (
                    <a key={`${item.url}-${index}`} className="flex items-center gap-1 break-all text-sm text-indigo-300" href={safeHref(item.url)} target="_blank" rel="noreferrer">
                      {item.label || 'Professional link'} <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {namedGroups.map(([title, items]) => (
            <ParserCollection
              key={title}
              title={title}
              items={items}
              renderItem={(item) => (
                <div>
                  <p className="font-medium text-slate-200">{item.title || title.slice(0, -1)}</p>
                  {item.issuer ? <p className="mt-1 text-sm text-slate-400">{item.issuer}</p> : null}
                  {item.description ? <p className="mt-2 whitespace-pre-line text-sm leading-6 text-slate-400">{item.description}</p> : null}
                </div>
              )}
            />
          ))}
        </div>
      ) : null}
    </Section>
  );
};

const CandidateDetailPage = () => {
  const { candidateRef } = useParams();
  const { hasPermission } = usePermission();
  const canUpdateCandidates = hasPermission('CANDIDATE_UPDATE');
  const canReadInterviews = hasPermission('INTERVIEW_READ');
  const canScheduleInterviews = hasPermission('INTERVIEW_CREATE');
  const canReadOffers = hasPermission('OFFER_READ');
  const [candidate, setCandidate] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeError, setResumeError] = useState('');
  const [parsedResume, setParsedResume] = useState(null);
  const [parsedLoading, setParsedLoading] = useState(true);
  const [parsedError, setParsedError] = useState('');
  const [reprocessBusy, setReprocessBusy] = useState(false);
  const [reprocessMessage, setReprocessMessage] = useState('');
  const [ats, setAts] = useState(null);
  const [atsLoading, setAtsLoading] = useState(true);
  const [atsError, setAtsError] = useState('');
  const [atsReprocessBusy, setAtsReprocessBusy] = useState(false);
  const [previousATSEvaluation, setPreviousATSEvaluation] = useState('');
  const [pipelineOptions, setPipelineOptions] = useState({ stages: PIPELINE_STAGES });
  const [stageModal, setStageModal] = useState(false);
  const [stageTarget, setStageTarget] = useState('');
  const [stageReason, setStageReason] = useState('');
  const [stageBusy, setStageBusy] = useState(false);
  const [stageError, setStageError] = useState('');
  const [interviews, setInterviews] = useState([]);
  const [interviewsLoading, setInterviewsLoading] = useState(false);
  const [interviewError, setInterviewError] = useState('');
  const [scheduleRoundKey, setScheduleRoundKey] = useState('');
  const [selectedInterviewId, setSelectedInterviewId] = useState('');
  const [interviewMessage, setInterviewMessage] = useState('');

  useEffect(() => {
    if (!canUpdateCandidates) return;
    candidateService
      .pipelineOptions()
      .then((result) => setPipelineOptions({
        stages: Array.isArray(result.stages) ? result.stages : PIPELINE_STAGES,
      }))
      .catch(() => {});
  }, [canUpdateCandidates]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setParsedLoading(true);
    setAtsLoading(true);
    setError('');
    setParsedError('');
    setAtsError('');
    setInterviewError('');
    setInterviewsLoading(canReadInterviews);

    const load = async () => {
      try {
        const detail = await candidateService.detail(candidateRef);

        if (!active) return;
        setCandidate(detail);
        document.title = `${detail.overview.name} — Candidate — Crewly HRMS`;

        if (canReadInterviews) {
          try {
            const interviewRows = await interviewService.candidateInterviews(candidateRef);
            if (active) setInterviews(Array.isArray(interviewRows) ? interviewRows : []);
          } catch (requestError) {
            if (active) {
              setInterviewError(requestError?.message || 'Candidate interviews could not be loaded');
            }
          } finally {
            if (active) setInterviewsLoading(false);
          }
        } else {
          setInterviews([]);
        }

        try {
          const atsResult = await candidateService.atsResult(candidateRef);
          if (active) setAts(atsResult);
        } catch (requestError) {
          if (active) {
            setAtsError(requestError?.message || 'ATS analysis could not be loaded');
          }
        }

        if (detail.resume?.available) {
          try {
            const parsed = await candidateService.parsedResume(candidateRef);
            if (active) setParsedResume(parsed);
          } catch (requestError) {
            if (active) {
              setParsedError(requestError?.message || 'Parser information could not be loaded');
            }
          }
        } else {
          setParsedResume(null);
        }
      } catch (requestError) {
        if (active) setError(requestError?.message || 'Candidate could not be loaded');
      } finally {
        if (active) {
          setLoading(false);
          setParsedLoading(false);
          setAtsLoading(false);
        }
      }
    };

    load();

    return () => {
      active = false;
    };
  }, [canReadInterviews, candidateRef]);

  useEffect(() => {
    if (!['PENDING', 'RETRY_PENDING', 'PROCESSING'].includes(parsedResume?.status)) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      candidateService
        .parsedResume(candidateRef)
        .then((result) => {
          setParsedResume(result);
          setParsedError('');

          if (!['PENDING', 'RETRY_PENDING', 'PROCESSING'].includes(result.status)) {
            candidateService
              .detail(candidateRef)
              .then(setCandidate)
              .catch(() => {});
            candidateService
              .atsResult(candidateRef)
              .then((atsResult) => {
                setAts(atsResult);
                setAtsError('');
              })
              .catch(() => {});
          }
        })
        .catch(() => {});
    }, 2500);

    return () => window.clearInterval(timer);
  }, [candidateRef, parsedResume?.status]);

  useEffect(() => {
    if (ats?.status !== 'MATCHING_PENDING' && !atsReprocessBusy) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      candidateService
        .atsResult(candidateRef)
        .then((result) => {
          setAts(result);
          setAtsError('');

          const evaluatedAt = result?.result?.evaluatedAt || '';
          if (
            result?.status === 'COMPLETED' &&
            (!previousATSEvaluation || evaluatedAt !== previousATSEvaluation)
          ) {
            setAtsReprocessBusy(false);
            setPreviousATSEvaluation('');
            candidateService.detail(candidateRef).then(setCandidate).catch(() => {});
          }
        })
        .catch(() => {});
    }, 2500);

    return () => window.clearInterval(timer);
  }, [
    ats?.status,
    atsReprocessBusy,
    candidateRef,
    previousATSEvaluation,
  ]);

  const downloadResume = async () => {
    setResumeBusy(true);
    setResumeError('');

    try {
      const blob = await candidateService.resume(candidateRef);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = candidate.resume.originalFileName || 'candidate-resume';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (requestError) {
      setResumeError(requestError?.message || 'Resume could not be downloaded');
    } finally {
      setResumeBusy(false);
    }
  };

  const reprocessResume = async () => {
    setReprocessBusy(true);
    setParsedError('');
    setReprocessMessage('');

    try {
      const scheduled = await candidateService.reprocessResume(candidateRef);
      setParsedResume((current) => ({
        ...(current || {}),
        status: scheduled.status || 'RETRY_PENDING',
        parserVersion: scheduled.parserVersion || current?.parserVersion || '',
        requestedAt: scheduled.requestedAt || new Date().toISOString(),
        reprocessAvailable: false,
        failure: null,
      }));
      setAts({
        status: 'PARSING_PENDING',
        parserStatus: scheduled.status || 'RETRY_PENDING',
        message: 'ATS matching will run again after resume reprocessing completes.',
      });
      setReprocessMessage('Resume reprocessing was scheduled. This page will refresh the parser state automatically.');
      candidateService.detail(candidateRef).then(setCandidate).catch(() => {});
    } catch (requestError) {
      setParsedError(requestError?.message || 'Resume reprocessing could not be scheduled');
    } finally {
      setReprocessBusy(false);
    }
  };

  const reprocessATS = async () => {
    setAtsReprocessBusy(true);
    setAtsError('');
    setPreviousATSEvaluation(ats?.result?.evaluatedAt || '');

    try {
      const scheduled = await candidateService.reprocessATS(candidateRef);
      setAts((current) => ({
        ...(current || {}),
        status: scheduled.status || 'MATCHING_PENDING',
        message: 'ATS recalculation is running against the current job requirements.',
      }));
    } catch (requestError) {
      setAtsError(requestError?.message || 'ATS recalculation could not be scheduled');
      setAtsReprocessBusy(false);
      setPreviousATSEvaluation('');
    }
  };

  const openStageModal = () => {
    const currentStage = candidate?.overview?.currentStage || candidate?.overview?.stage;
    setStageTarget(currentStage || 'APPLIED');
    setStageReason('');
    setStageError('');
    setStageModal(true);
  };

  const stageReasonRequired = (() => {
    const currentStage = candidate?.overview?.currentStage || candidate?.overview?.stage;
    if (DISPOSITION_PIPELINE_STAGES.includes(stageTarget)) return true;
    const currentIndex = POSITIVE_PIPELINE_STAGES.indexOf(currentStage);
    const targetIndex = POSITIVE_PIPELINE_STAGES.indexOf(stageTarget);
    return currentIndex >= 0 && targetIndex >= 0 && targetIndex < currentIndex;
  })();

  const updateCandidateStage = async (event) => {
    event.preventDefault();
    setStageBusy(true);
    setStageError('');

    try {
      await candidateService.updateStage(candidate.id, {
        stage: stageTarget,
        reason: stageReason.trim(),
      });
      const refreshed = await candidateService.detail(candidateRef);
      setCandidate(refreshed);
      setStageModal(false);
    } catch (requestError) {
      setStageError(requestError?.message || 'Candidate stage could not be updated');
    } finally {
      setStageBusy(false);
    }
  };

  const refreshInterviewData = async () => {
    const [detail, interviewRows] = await Promise.all([
      candidateService.detail(candidateRef),
      interviewService.candidateInterviews(candidateRef),
    ]);
    setCandidate(detail);
    setInterviews(Array.isArray(interviewRows) ? interviewRows : []);
  };

  const interviewSaved = async (_result, warning = '') => {
    try {
      await refreshInterviewData();
      setInterviewError('');
    } catch (requestError) {
      setInterviewError(requestError?.message || 'Interview saved; refresh to reload the timeline');
    }
    setScheduleRoundKey('');
    setInterviewMessage(
      warning || 'Interview schedule saved and the candidate timeline was updated.'
    );
  };

  if (loading) {
    return <div className="h-96 animate-pulse rounded-2xl bg-slate-900" />;
  }

  if (error || !candidate) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8">
        <UserRound className="h-9 w-9 text-slate-600" />
        <h1 className="mt-3 text-xl font-semibold text-slate-100">Candidate unavailable</h1>
        <p className="mt-2 text-sm text-slate-400">{error}</p>
        <Link className="btn-primary mt-5 inline-flex" to="/app/recruitment/candidates">Back to candidates</Link>
      </div>
    );
  }

  const links = [
    ['LinkedIn', candidate.links?.linkedIn],
    ['GitHub', candidate.links?.github],
    ['Portfolio', candidate.links?.portfolio],
  ].filter(([, value]) => safeHref(value));

  return (
    <div className="space-y-5">
      <Link to="/app/recruitment/candidates" className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-slate-100">
        <ArrowLeft className="h-4 w-4" /> Back to candidate inbox
      </Link>

      <header className="rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-7">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-mono text-xs font-semibold text-indigo-300">{candidate.candidateCode}</p>
              <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                {PIPELINE_STAGE_LABELS[candidate.overview.currentStage || candidate.overview.stage] || enumLabel(candidate.overview.stage)}
              </span>
              <span className="rounded-full border border-slate-700 bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300">
                {candidate.overview.source === 'CAREER_PAGE' ? 'Career page' : 'Internal'}
              </span>
            </div>
            <h1 className="mt-2 text-2xl font-bold text-slate-100 sm:text-3xl">{candidate.overview.name}</h1>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-slate-400">
              <a className="inline-flex items-center gap-1.5 hover:text-indigo-300" href={`mailto:${candidate.overview.email}`}>
                <Mail className="h-4 w-4" /> {candidate.overview.email}
              </a>
              {candidate.overview.phone ? (
                <span className="inline-flex items-center gap-1.5"><Phone className="h-4 w-4" /> {candidate.overview.phone}</span>
              ) : null}
              <span className="inline-flex items-center gap-1.5"><MapPin className="h-4 w-4" /> {candidate.overview.location || 'Location not provided'}</span>
            </div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-4 py-3 lg:text-right">
            <p className="text-xs uppercase tracking-wide text-slate-500">Applied</p>
            <p className="mt-1 text-sm font-medium text-slate-200">{dateLabel(candidate.overview.applicationDate)}</p>
          </div>
        </div>
      </header>

      {canReadOffers ? <CandidateOfferPanel candidate={candidate} /> : null}
      <CandidatePreOnboardingPanel
        candidate={candidate}
        onStarted={() => {
          // Keep the detail view in sync after the pipeline moves to PRE_ONBOARDING.
          window.setTimeout(() => window.location.reload(), 400);
        }}
      />
      <CandidateBgvPanel candidate={candidate} />
      <CandidateConversionPanel candidate={candidate} />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start">
        <div className="space-y-5">
          <div className="rounded-2xl border border-indigo-500/20 bg-indigo-500/5 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-indigo-300">Candidate-entered application details</p>
            <p className="mt-1 text-sm text-slate-400">
              The sections below preserve information submitted by the candidate and remain separate from parser-derived data.
            </p>
          </div>

          <ATSAnalysisPanel
            ats={ats}
            loading={atsLoading}
            error={atsError}
            canReprocess={hasPermission('CANDIDATE_UPDATE')}
            reprocessBusy={atsReprocessBusy}
            onReprocess={reprocessATS}
          />

          <Section icon={BriefcaseBusiness} title="Professional profile">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Value label="Current company" value={candidate.professional.currentCompany} />
              <Value label="Current title" value={candidate.professional.currentTitle} />
              <Value label="Total experience" value={`${candidate.professional.totalExperience} years`} />
              <Value label="Relevant experience" value={`${candidate.professional.relevantExperience} years`} />
              <Value label="Expected salary" value={moneyLabel(candidate.professional.expectedSalary)} />
              <Value label="Notice period" value={candidate.professional.noticePeriod === null ? 'Not provided' : `${candidate.professional.noticePeriod} days`} />
            </div>
          </Section>

          <Section icon={GraduationCap} title="Education">
            <div className="grid gap-3 sm:grid-cols-3">
              <Value label="Degree" value={candidate.education?.degree} />
              <Value label="Institution" value={candidate.education?.institution} />
              <Value label="Graduation year" value={candidate.education?.graduationYear ? String(candidate.education.graduationYear) : ''} />
            </div>
          </Section>

          <Section icon={Wrench} title="Skills">
            {candidate.skills.length ? (
              <div className="flex flex-wrap gap-2">
                {candidate.skills.map((skill) => (
                  <span key={skill} className="rounded-lg border border-indigo-500/20 bg-indigo-500/10 px-2.5 py-1.5 text-xs text-indigo-200">{skill}</span>
                ))}
              </div>
            ) : <p className="text-sm text-slate-500">No skills were provided.</p>}
          </Section>

          <Section icon={Link2} title="Professional links">
            {links.length ? (
              <div className="flex flex-wrap gap-3">
                {links.map(([label, value]) => (
                  <a key={label} className="btn-ghost gap-2" href={safeHref(value)} target="_blank" rel="noreferrer">
                    {label} <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                ))}
              </div>
            ) : <p className="text-sm text-slate-500">No professional links were provided.</p>}
          </Section>

          <Section icon={Building2} title="Applied job">
            {candidate.job ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Value label="Job title" value={candidate.job.title} />
                <Value label="Job code" value={candidate.job.jobCode} />
                <Value label="Department" value={candidate.job.department} />
                <Value label="Location" value={candidate.job.location} />
                <Value label="Employment" value={enumLabel(candidate.job.employmentType)} />
                <Value label="Work mode" value={enumLabel(candidate.job.workMode)} />
              </div>
            ) : <p className="text-sm text-slate-500">The linked job is unavailable.</p>}
          </Section>

          {canReadInterviews ? (
            <Section icon={CalendarClock} title="Interviews">
              <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-sm font-medium text-slate-200">Interview plan</p>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      Default round slots are configurable-ready snapshots. Scheduling can move the candidate through the audited pipeline only when explicitly selected.
                    </p>
                  </div>
                  <Link to="/app/recruitment/interviews" className="text-xs font-medium text-indigo-300 hover:text-indigo-200">
                    Open interview workspace
                  </Link>
                </div>
              </div>

              {interviewMessage ? (
                <p className="mt-3 rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-3 text-sm text-emerald-200">
                  {interviewMessage}
                </p>
              ) : null}
              {interviewError ? (
                <p role="alert" className="mt-3 rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-sm text-rose-200">
                  {interviewError}
                </p>
              ) : null}

              {interviewsLoading ? (
                <div className="mt-4 h-40 animate-pulse rounded-xl bg-slate-950/50" />
              ) : (
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {INTERVIEW_ROUNDS.map((round) => {
                    const roundInterviews = interviews.filter(
                      (interview) => interview.round?.key === round.key
                    );
                    const activeInterview = roundInterviews.find((interview) =>
                      ['SCHEDULED', 'RESCHEDULED', 'IN_PROGRESS'].includes(interview.status)
                    );
                    const latestInterview = activeInterview || roundInterviews.at(-1);
                    const stage = candidate.overview.currentStage || candidate.overview.stage;
                    const schedulingAllowed = [
                      'SHORTLISTED',
                      'INTERVIEW_1',
                      'INTERVIEW_2',
                      'INTERVIEW_3',
                      'MANAGER_ROUND',
                      'HR_FINAL',
                    ].includes(stage);

                    return (
                      <article key={round.key} className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-[10px] uppercase tracking-wide text-slate-500">Round {round.sequence}</p>
                            <h3 className="mt-1 text-sm font-semibold text-slate-200">{round.name}</h3>
                          </div>
                          {latestInterview ? (
                            <span className={`rounded-full border px-2 py-1 text-[10px] font-semibold ${
                              INTERVIEW_STATUS_TONE[latestInterview.status] || INTERVIEW_STATUS_TONE.CANCELLED
                            }`}>
                              {enumLabel(latestInterview.status)}
                            </span>
                          ) : (
                            <span className="rounded-full border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] text-slate-400">Not scheduled</span>
                          )}
                        </div>

                        {latestInterview ? (
                          <div className="mt-3">
                            <p className="text-xs text-slate-300">
                              {interviewDateLabel(latestInterview.scheduledStartAt, latestInterview.timezone)}
                            </p>
                            <p className="mt-1 text-[11px] text-slate-500">
                              {latestInterview.interviewCode} · {latestInterview.interviewers?.map((person) => person.name).join(', ')}
                            </p>
                            {latestInterview.status === 'COMPLETED' ? (
                              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                                <span className={latestInterview.feedback?.pendingCount ? 'font-medium text-amber-300' : 'font-medium text-emerald-300'}>
                                  {latestInterview.feedback?.pendingCount ? 'Feedback pending · ' : ''}{latestInterview.feedback?.submittedCount || 0}/{latestInterview.feedback?.assignedCount || 0} scorecards submitted
                                </span>
                                {latestInterview.feedback?.roundAverage !== null && latestInterview.feedback?.roundAverage !== undefined ? (
                                  <span className="font-mono text-indigo-300">Average {Number(latestInterview.feedback.roundAverage).toFixed(2)}/10</span>
                                ) : null}
                              </div>
                            ) : null}
                            <button
                              type="button"
                              className="btn-ghost mt-3 w-full justify-center"
                              onClick={() => setSelectedInterviewId(latestInterview.id)}
                            >
                              View interview
                            </button>
                          </div>
                        ) : null}

                        {canScheduleInterviews ? (
                          <button
                            type="button"
                            className="btn-primary mt-3 w-full justify-center"
                            onClick={() => setScheduleRoundKey(round.key)}
                            disabled={Boolean(activeInterview) || !schedulingAllowed}
                            title={
                              activeInterview
                                ? 'An active interview already exists for this round'
                                : !schedulingAllowed
                                  ? 'Shortlist the candidate before scheduling'
                                  : ''
                            }
                          >
                            {latestInterview ? 'Schedule another' : 'Schedule'}
                          </button>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              )}

              {interviews.some(
                (interview) => !INTERVIEW_ROUNDS.some((round) => round.key === interview.round?.key)
              ) ? (
                <div className="mt-4 border-t border-slate-800 pt-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Custom rounds</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {interviews
                      .filter((interview) => !INTERVIEW_ROUNDS.some((round) => round.key === interview.round?.key))
                      .map((interview) => (
                        <button
                          key={interview.id}
                          type="button"
                          className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-200"
                          onClick={() => setSelectedInterviewId(interview.id)}
                        >
                          {interview.round?.name} · {enumLabel(interview.status)}
                        </button>
                      ))}
                  </div>
                </div>
              ) : null}
            </Section>
          ) : null}

          {canReadInterviews && hasPermission('INTERVIEW_FEEDBACK_READ') ? (
            <CandidateFinalReview
              candidate={candidate}
              ats={ats}
              interviews={interviews}
              onChanged={async () => {
                try {
                  await refreshInterviewData();
                  setInterviewError('');
                } catch (requestError) {
                  setInterviewError(requestError?.message || 'Refresh to reload Final Review changes');
                }
              }}
            />
          ) : null}

          <ParsedResumePanel
            parsed={parsedResume}
            loading={parsedLoading}
            error={parsedError}
            canReprocess={hasPermission('CANDIDATE_UPDATE')}
            reprocessBusy={reprocessBusy}
            reprocessMessage={reprocessMessage}
            onReprocess={reprocessResume}
          />

          <Section icon={Clock3} title="Candidate timeline">
            {candidate.timeline?.length ? (
              <ol className="relative space-y-0 before:absolute before:bottom-2 before:left-[5px] before:top-2 before:w-px before:bg-slate-800">
                {candidate.timeline.map((event, index) => (
                  <li key={`${event.action}-${event.eventAt}-${index}`} className="relative flex gap-4 pb-6 last:pb-0">
                    <span className={`relative z-10 mt-1.5 h-3 w-3 shrink-0 rounded-full ring-4 ring-slate-900 ${
                      event.type === 'STAGE_TRANSITION' ? 'bg-indigo-400' : 'bg-slate-500'
                    }`} />
                    <div className="min-w-0 flex-1 rounded-xl border border-slate-800 bg-slate-950/30 p-4">
                      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                        <p className="text-sm font-medium text-slate-200">{timelineLabel(event.action)}</p>
                        <p className="shrink-0 text-xs text-slate-500">{dateLabel(event.eventAt)}</p>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {event.actor?.name || (event.actorType === 'TENANT_USER' ? 'Tenant user' : enumLabel(event.actorType))}
                      </p>
                      {event.type === 'STAGE_TRANSITION' ? (
                        <div className="mt-3 rounded-lg border border-indigo-500/20 bg-indigo-500/5 p-3">
                          <p className="text-xs font-medium text-indigo-200">
                            {PIPELINE_STAGE_LABELS[event.fromStage] || enumLabel(event.fromStage)}
                            {' → '}
                            {PIPELINE_STAGE_LABELS[event.toStage] || enumLabel(event.toStage)}
                          </p>
                          {event.reason ? (
                            <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-slate-300">{event.reason}</p>
                          ) : null}
                        </div>
                      ) : null}
                      {event.metadata?.offerCode ? (
                        <p className="mt-2 font-mono text-xs text-indigo-300">
                          Offer {event.metadata.offerCode}
                        </p>
                      ) : null}
                      {event.metadata?.assignmentType ? (
                        <p className="mt-2 text-xs text-slate-400">
                          {event.metadata.assignmentType === 'assignedRecruiter'
                            ? 'Recruiter'
                            : 'Hiring manager'}: {event.metadata.assigneeName || 'Assigned user'}
                        </p>
                      ) : null}
                      {event.metadata?.template ? (
                        <p className="mt-2 text-xs text-slate-400">
                          Standard status notification · {event.metadata.delivered ? 'Delivered' : 'Delivery failed'}
                        </p>
                      ) : null}
                      {event.metadata?.parserVersion ? (
                        <p className="mt-2 text-xs text-slate-400">
                          Parser {event.metadata.parserVersion}
                          {event.metadata.status ? ` · ${enumLabel(event.metadata.status)}` : ''}
                          {event.metadata.attempt ? ` · Attempt ${event.metadata.attempt}` : ''}
                        </p>
                      ) : null}
                      {event.metadata?.engineVersion ? (
                        <p className="mt-2 text-xs text-slate-400">
                          ATS engine {event.metadata.engineVersion}
                          {event.metadata.score !== undefined ? ` · Score ${event.metadata.score}` : ''}
                          {event.metadata.category ? ` · ${enumLabel(event.metadata.category)} match` : ''}
                        </p>
                      ) : null}
                      {event.metadata?.interviewCode ? (
                        <div className="mt-2 rounded-lg border border-slate-800 bg-slate-900 p-3 text-xs text-slate-300">
                          <p>{event.metadata.roundName || enumLabel(event.metadata.roundKey)} · {event.metadata.interviewCode}</p>
                          {event.metadata.scheduledStartAt ? (
                            <p className="mt-1 text-slate-500">
                              {interviewDateLabel(event.metadata.scheduledStartAt, event.metadata.timezone)}
                              {event.metadata.status ? ` · ${enumLabel(event.metadata.status)}` : ''}
                            </p>
                          ) : null}
                          {event.metadata.recommendation ? (
                            <p className="mt-1 text-slate-400">
                              {enumLabel(event.metadata.recommendation)}
                              {event.metadata.overallScore !== undefined
                                ? ` · ${Number(event.metadata.overallScore).toFixed(2)}/${event.metadata.maxOverallScore || 10}`
                                : ''}
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                      {event.metadata?.decision ? (
                        <p className="mt-2 rounded-lg border border-slate-800 bg-slate-900 p-3 text-xs text-slate-300">
                          {enumLabel(event.metadata.decision)} · {enumLabel(event.metadata.reasonCategory)}
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
            ) : <p className="text-sm text-slate-500">No timeline events are available.</p>}
          </Section>
        </div>

        <aside className="space-y-5 xl:sticky xl:top-24">
          <Section icon={FileText} title="Original resume">
            {candidate.resume.available ? (
              <div>
                <p className="break-all text-sm font-medium text-slate-200">{candidate.resume.originalFileName}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {(candidate.resume.fileSize / 1024 / 1024).toFixed(2)} MB · {candidate.resume.mimeType.includes('pdf') ? 'PDF' : 'DOCX'}
                </p>
                <div className="mt-3 flex items-start gap-2 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
                  <p className="text-xs leading-5 text-slate-400">
                    Scan status: {enumLabel(candidate.resume.scanStatus)}. Access is authenticated and recorded.
                  </p>
                </div>
                <button type="button" className="btn-primary mt-4 w-full justify-center gap-2" onClick={downloadResume} disabled={resumeBusy}>
                  <Download className="h-4 w-4" /> {resumeBusy ? 'Preparing secure download…' : 'Download resume'}
                </button>
                {resumeError ? <p role="alert" className="mt-2 text-xs text-rose-300">{resumeError}</p> : null}
              </div>
            ) : <p className="text-sm text-slate-500">No secure resume is available.</p>}
          </Section>

          <Section icon={GitBranch} title="Pipeline controls">
            <Value
              label="Current stage"
              value={PIPELINE_STAGE_LABELS[
                candidate.overview.currentStage || candidate.overview.stage
              ] || enumLabel(candidate.overview.stage)}
            />
            {canUpdateCandidates &&
            !['JOINED', 'FINAL_REVIEW', 'SELECTED'].includes(
              candidate.overview.currentStage || candidate.overview.stage
            ) ? (
              <button type="button" className="btn-primary mt-3 w-full justify-center" onClick={openStageModal}>
                Change stage
              </button>
            ) : null}
            <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">ATS policy</p>
              <p className="mt-1.5 text-xs leading-5 text-slate-400">
                ATS analysis is assistive. Crewly does not automatically shortlist, reject, or make hiring decisions.
              </p>
            </div>
          </Section>

          <Section icon={UserRound} title="Pipeline owners">
            <div className="space-y-3">
              <Value label="Assigned recruiter" value={candidate.assignments?.recruiter?.name} />
              <Value label="Hiring manager" value={candidate.assignments?.hiringManager?.name} />
            </div>
          </Section>
        </aside>
      </div>

      {stageModal ? (
        <Modal title={`Change stage · ${candidate.overview.name}`} onClose={() => !stageBusy && setStageModal(false)}>
          <form className="space-y-4" onSubmit={updateCandidateStage}>
            <div>
              <label className="label">Target stage</label>
              <select
                className="input"
                value={stageTarget}
                onChange={(event) => {
                  setStageTarget(event.target.value);
                  setStageError('');
                }}
              >
                {pipelineOptions.stages
                  .filter(
                    (stage) =>
                      !['FINAL_REVIEW', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED'].includes(stage) &&
                      !(
                        (candidate.overview.currentStage || candidate.overview.stage) === 'HR_FINAL' &&
                        ['REJECTED', 'HOLD'].includes(stage)
                      )
                  )
                  .map((stage) => (
                    <option key={stage} value={stage}>{PIPELINE_STAGE_LABELS[stage]}</option>
                  ))}
              </select>
            </div>
            <div>
              <label className="label">Reason {stageReasonRequired ? '*' : '(optional)'}</label>
              <textarea
                className="input min-h-24"
                value={stageReason}
                onChange={(event) => setStageReason(event.target.value)}
                required={stageReasonRequired}
                maxLength={1000}
                placeholder={
                  stageReasonRequired
                    ? 'Explain the disposition or why this candidate is being sent back'
                    : 'Add context to the immutable candidate timeline'
                }
              />
              <p className="mt-1 text-right text-[10px] text-slate-500">{stageReason.length}/1000</p>
            </div>
            {stageError ? (
              <p role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-sm text-rose-200">{stageError}</p>
            ) : null}
            <div className="flex justify-end gap-2 border-t border-slate-800 pt-4">
              <button type="button" className="btn-ghost" onClick={() => setStageModal(false)} disabled={stageBusy}>Cancel</button>
              <button
                type="submit"
                className="btn-primary"
                disabled={
                  stageBusy ||
                  stageTarget === (candidate.overview.currentStage || candidate.overview.stage) ||
                  (stageReasonRequired && !stageReason.trim())
                }
              >
                {stageBusy ? 'Saving…' : 'Confirm stage change'}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {scheduleRoundKey ? (
        <InterviewScheduleModal
          candidate={candidate}
          initialRoundKey={scheduleRoundKey}
          onClose={() => setScheduleRoundKey('')}
          onSaved={interviewSaved}
        />
      ) : null}

      {selectedInterviewId ? (
        <InterviewDetailModal
          interviewId={selectedInterviewId}
          onClose={() => setSelectedInterviewId('')}
          onChanged={async () => {
            try {
              await refreshInterviewData();
              setInterviewError('');
            } catch (requestError) {
              setInterviewError(requestError?.message || 'Refresh to reload interview changes');
            }
          }}
        />
      ) : null}
    </div>
  );
};

export default CandidateDetailPage;
