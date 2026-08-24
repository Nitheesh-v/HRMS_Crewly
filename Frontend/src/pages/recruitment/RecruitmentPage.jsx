/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  BadgeCheck,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  Check,
  Copy,
  ExternalLink,
  FilePlus2,
  Globe2,
  Users,
} from 'lucide-react';
import Modal from '../../components/Modal.jsx';
import useAuth from '../../hooks/useAuth.jsx';
import usePermission from '../../hooks/usePermission.js';
import api from '../../services/api.js';
import companyService from '../../services/companyService.js';
import recruitmentService from '../../services/recruitmentService.js';
import requisitionService from '../../services/requisitionService.js';
import { ROLES } from '../../utils/roles.js';
import {
  DISPOSITION_PIPELINE_STAGES,
  PIPELINE_STAGES,
  PIPELINE_STAGE_LABELS,
  POSITIVE_PIPELINE_STAGES,
} from './pipelineStages.js';

const STAGE_DOTS = [
  'bg-slate-400',
  'bg-sky-400',
  'bg-indigo-400',
  'bg-violet-400',
  'bg-purple-400',
  'bg-fuchsia-400',
  'bg-pink-400',
  'bg-orange-400',
  'bg-amber-400',
  'bg-yellow-400',
  'bg-lime-400',
  'bg-cyan-400',
  'bg-teal-400',
  'bg-emerald-400',
  'bg-green-400',
  'bg-rose-400',
  'bg-yellow-500',
  'bg-slate-500',
];
const STAGES = PIPELINE_STAGES.map((key, index) => ({
  key,
  label: PIPELINE_STAGE_LABELS[key],
  dot: STAGE_DOTS[index],
}));
const STAGE_LABEL = PIPELINE_STAGE_LABELS;
const OFFER_STYLE = {
  SENT: 'bg-sky-400/10 text-sky-400 border border-sky-400/40',
  ACCEPTED: 'bg-crewly-green/10 text-crewly-green border border-crewly-green/40',
  DECLINED: 'bg-crewly-red/10 text-crewly-red border border-crewly-red/40',
};
const TYPE_LABEL = {
  FULL_TIME: 'Full Time',
  PART_TIME: 'Part Time',
  CONTRACT: 'Contract',
  INTERN: 'Internship',
  TEMPORARY: 'Temporary',
};

const emptyJobForm = {
  title: '',
  department: '',
  location: 'On-site',
  employmentType: 'FULL_TIME',
  openings: 1,
  description: '',
  workMode: 'ONSITE',
  experienceLevel: 'EXPERIENCED',
  minExperience: 0,
  maxExperience: 0,
  requiredSkills: '',
  preferredSkills: '',
  educationRequirements: '',
  maxNoticePeriod: 30,
  publicationStatus: 'DRAFT',
  applicationDeadline: '',
  publicSalaryVisible: false,
};
const emptyCandForm = { name: '', email: '', phone: '', resumeLink: '', notes: '' };
const splitList = (value) =>
  [...new Set(
    String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  )];
const isoDate = (d) => (d ? String(d).slice(0, 10) : '');
const errText = (error) => error?.message || 'Something went wrong';
const enumLabel = (value = '') =>
  String(value)
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
const moneyLabel = (value) =>
  value === null || value === undefined
    ? 'Not set'
    : new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 0,
      }).format(value);
const dateLabel = (value) =>
  value
    ? new Intl.DateTimeFormat('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      }).format(new Date(value))
    : 'Not set';
const requisitionDescription = (requisition) => {
  const experience = requisition.experienceLevel === 'FRESHER'
    ? 'Fresher'
    : `${requisition.minExperience}–${requisition.maxExperience} years`;

  return [
    `${requisition.position} role${requisition.team ? ` for ${requisition.team}` : ''}.`,
    requisition.requiredSkills?.length
      ? `Required skills: ${requisition.requiredSkills.join(', ')}.`
      : '',
    requisition.preferredSkills?.length
      ? `Preferred skills: ${requisition.preferredSkills.join(', ')}.`
      : '',
    `Experience: ${experience}.`,
  ].filter(Boolean).join('\n\n');
};

const RecruitmentPage = () => {
  const { user: me } = useAuth();
  const { hasPermission } = usePermission();
  const [searchParams, setSearchParams] = useSearchParams();
  const handledRequisition = useRef('');
  const isHR = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER].includes(me?.role);
  const canCreateJob = hasPermission('RECRUITMENT_CREATE');

  const [jobs, setJobs] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [careerCompany, setCareerCompany] = useState(null);
  const [copiedJobCode, setCopiedJobCode] = useState('');
  const [banner, setBanner] = useState(null);
  const [loading, setLoading] = useState(true);

  const [jobModal, setJobModal] = useState({
    open: false,
    editing: null,
    requisition: null,
  });
  const [jobForm, setJobForm] = useState(emptyJobForm);
  const [candModal, setCandModal] = useState(false);
  const [candForm, setCandForm] = useState(emptyCandForm);
  const [stageModal, setStageModal] = useState(null);
  const [stageReason, setStageReason] = useState('');
  const [offerModal, setOfferModal] = useState(null); // candidate
  const [offerForm, setOfferForm] = useState({ offerSalary: '', offerJoiningDate: '' });
  const [convModal, setConvModal] = useState(null);   // { candidate, result }
  const [busy, setBusy] = useState(false);

  const flash = useCallback((type, text) => {
    setBanner({ type, text });
    window.setTimeout(() => setBanner(null), 5000);
  }, []);

  const loadJobs = useCallback(async () => {
    try {
      const list = await recruitmentService.jobs();
      const arr = Array.isArray(list) ? list : [];
      setJobs(arr);
      setSelectedId((current) =>
        current || arr.find((job) => job.status === 'OPEN')?._id || arr[0]?._id || ''
      );
      return arr;
    } catch (error) {
      flash('error', errText(error));
      return [];
    } finally {
      setLoading(false);
    }
  }, [flash]);

  const loadCandidates = useCallback(async () => {
    if (!selectedId) {
      setCandidates([]);
      return;
    }

    try {
      const list = await recruitmentService.candidates(selectedId);
      setCandidates(Array.isArray(list) ? list : []);
    } catch (error) {
      flash('error', errText(error));
    }
  }, [flash, selectedId]);

  useEffect(() => { loadJobs(); }, [loadJobs]);
  useEffect(() => { loadCandidates(); }, [loadCandidates]);
  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/departments');
        setDepartments(Array.isArray(res) ? res : res?.departments || res?.data || []);
      } catch { /* non-fatal */ }
    })();
  }, []);

  useEffect(() => {
    companyService
      .getMy()
      .then((company) => setCareerCompany(company))
      .catch(() => setCareerCompany(null));
  }, []);

  useEffect(() => {
    const requestedJobId = searchParams.get('job');

    if (requestedJobId && jobs.some((job) => job._id === requestedJobId)) {
      setSelectedId(requestedJobId);
    }
  }, [jobs, searchParams]);

  useEffect(() => {
    const requisitionId = searchParams.get('requisition');

    if (!requisitionId) {
      handledRequisition.current = '';
      return;
    }

    if (handledRequisition.current === requisitionId) return;
    handledRequisition.current = requisitionId;

    const loadApprovedRequisition = async () => {
      try {
        const requisition = await requisitionService.getById(requisitionId);
        const linkedJobId = requisition.jobPosting?._id || requisition.jobPosting;

        if (linkedJobId) {
          flash('success', 'This approved requisition already has a job posting');
          setSearchParams({ job: linkedJobId }, { replace: true });
          return;
        }

        if (requisition.status !== 'APPROVED') {
          flash('error', 'Only an approved requisition can create a job');
          setSearchParams({}, { replace: true });
          return;
        }

        setJobForm({
          title: requisition.position,
          department: requisition.department?._id || requisition.department || '',
          location: requisition.location || '',
          employmentType: requisition.employmentType || 'FULL_TIME',
          openings: requisition.openings || 1,
          description: requisitionDescription(requisition),
          workMode: requisition.workMode || 'ONSITE',
          experienceLevel: requisition.experienceLevel || 'EXPERIENCED',
          minExperience: requisition.minExperience || 0,
          maxExperience: requisition.maxExperience || 0,
          requiredSkills: (requisition.requiredSkills || []).join(', '),
          preferredSkills: (requisition.preferredSkills || []).join(', '),
          educationRequirements: '',
          maxNoticePeriod: 30,
        });
        setJobModal({
          open: true,
          editing: null,
          requisition,
        });
      } catch (error) {
        flash('error', errText(error));
        setSearchParams({}, { replace: true });
      }
    };

    loadApprovedRequisition();
  }, [flash, searchParams, setSearchParams]);

  const selected = jobs.find((job) => job._id === selectedId);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const minimumDeadline = tomorrow.toISOString().slice(0, 10);

  const publicJobUrl = (job) => {
    if (!careerCompany?.careerSlug || !job?.jobCode) return '';
    return `${window.location.origin}/careers/${careerCompany.careerSlug}/jobs/${job.jobCode}`;
  };

  const copyPublicJobUrl = async (job) => {
    const url = publicJobUrl(job);
    if (!url) return;

    try {
      await navigator.clipboard.writeText(url);
      setCopiedJobCode(job.jobCode);
      window.setTimeout(() => setCopiedJobCode(''), 2000);
    } catch {
      flash('error', 'Could not copy the public job URL');
    }
  };

  // ── job create / edit ──
  const openJobModal = (editing) => {
    setJobForm(editing
      ? {
          title: editing.title,
          department: editing.department?._id || '',
          location: editing.location,
          employmentType: editing.employmentType,
          openings: editing.openings,
          description: editing.description || '',
          workMode: editing.workMode || 'ONSITE',
          experienceLevel: editing.experienceLevel || 'EXPERIENCED',
          minExperience: editing.minExperience || 0,
          maxExperience: editing.maxExperience || 0,
          requiredSkills: (editing.requiredSkills || []).join(', '),
          preferredSkills: (editing.preferredSkills || []).join(', '),
          educationRequirements: (editing.educationRequirements || []).join(', '),
          maxNoticePeriod: editing.maxNoticePeriod ?? 30,
          publicationStatus: editing.publicationStatus || 'DRAFT',
          applicationDeadline: isoDate(editing.applicationDeadline),
          publicSalaryVisible: Boolean(editing.publicSalaryVisible),
        }
      : emptyJobForm);
    setJobModal({
      open: true,
      editing: editing || null,
      requisition: null,
    });
  };

  const closeJobModal = () => {
    if (busy) return;

    const fromRequisition = Boolean(jobModal.requisition);
    setJobModal({ open: false, editing: null, requisition: null });

    if (fromRequisition) {
      setSearchParams({}, { replace: true });
    }
  };

  const saveJob = async (event) => {
    event.preventDefault();
    setBusy(true);

    try {
      const payload = {
        ...jobForm,
        openings: Number(jobForm.openings) || 1,
        minExperience: jobForm.experienceLevel === 'FRESHER'
          ? 0
          : Number(jobForm.minExperience) || 0,
        maxExperience: jobForm.experienceLevel === 'FRESHER'
          ? 0
          : Number(jobForm.maxExperience) || 0,
        requiredSkills: splitList(jobForm.requiredSkills),
        preferredSkills: splitList(jobForm.preferredSkills),
        educationRequirements: splitList(jobForm.educationRequirements),
        maxNoticePeriod: jobForm.maxNoticePeriod === ''
          ? 30
          : Number(jobForm.maxNoticePeriod),
        applicationDeadline: jobForm.applicationDeadline
          ? new Date(`${jobForm.applicationDeadline}T23:59:59.999`).toISOString()
          : null,
      };
      let createdJob = null;

      if (jobModal.editing) {
        await recruitmentService.updateJob(jobModal.editing._id, payload);
        flash('success', 'Job updated');
      } else if (jobModal.requisition) {
        createdJob = await requisitionService.createJob(
          jobModal.requisition._id,
          { description: jobForm.description.trim() }
        );
        flash(
          'success',
          `${createdJob.title} created from ${jobModal.requisition.requisitionNumber}`
        );
      } else {
        createdJob = await recruitmentService.createJob(payload);
        flash('success', 'Job posted');
      }

      setJobModal({ open: false, editing: null, requisition: null });
      await loadJobs();

      if (createdJob?._id) {
        setSelectedId(createdJob._id);
        setSearchParams({ job: createdJob._id }, { replace: true });
      }
    } catch (error) {
      flash('error', errText(error));
    } finally {
      setBusy(false);
    }
  };

  const toggleJobStatus = async () => {
    if (!selected) return;
    try {
      await recruitmentService.updateJob(selected._id, { status: selected.status === 'OPEN' ? 'CLOSED' : 'OPEN' });
      flash('success', selected.status === 'OPEN' ? 'Job closed' : 'Job reopened');
      loadJobs();
    } catch (err) { flash('error', errText(err)); }
  };

  // ── candidates ──
  const saveCandidate = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await recruitmentService.addCandidate({ ...candForm, job: selectedId });
      flash('success', `${candForm.name} added to pipeline 👤`);
      setCandModal(false);
      setCandForm(emptyCandForm);
      loadCandidates();
      loadJobs(); // refresh counts
    } catch (err) { flash('error', errText(err)); } finally { setBusy(false); }
  };

  const requestStageMove = (candidate, targetStage) => {
    const fromStage = candidate.currentStage || candidate.stage;
    if (targetStage === fromStage) return;
    setStageReason('');
    setStageModal({ candidate, fromStage, targetStage });
  };

  const stageMoveRequiresReason = stageModal
    ? DISPOSITION_PIPELINE_STAGES.includes(stageModal.targetStage) ||
      (
        POSITIVE_PIPELINE_STAGES.includes(stageModal.fromStage) &&
        POSITIVE_PIPELINE_STAGES.indexOf(stageModal.targetStage) <
          POSITIVE_PIPELINE_STAGES.indexOf(stageModal.fromStage)
      )
    : false;

  const moveStage = async (event) => {
    event.preventDefault();
    if (!stageModal) return;
    setBusy(true);
    try {
      await recruitmentService.updateStage(
        stageModal.candidate._id,
        stageModal.targetStage,
        stageReason.trim()
      );
      flash('success', `Candidate moved to ${STAGE_LABEL[stageModal.targetStage]}`);
      setStageModal(null);
      setStageReason('');
      await loadCandidates();
    } catch (err) {
      flash('error', errText(err));
    } finally {
      setBusy(false);
    }
  };

  const openOffer = (c) => {
    setOfferForm({ offerSalary: c.offerSalary || '', offerJoiningDate: isoDate(c.offerJoiningDate) });
    setOfferModal(c);
  };

  const sendOffer = async (offerStatus) => {
    setBusy(true);
    try {
      await recruitmentService.updateOffer(offerModal._id, {
        offerStatus,
        offerSalary: Number(offerForm.offerSalary) || 0,
        offerJoiningDate: offerForm.offerJoiningDate,
      });
      flash('success', `Offer ${offerStatus.toLowerCase()} 📨`);
      setOfferModal(null);
      loadCandidates();
    } catch (err) { flash('error', errText(err)); } finally { setBusy(false); }
  };

  const doConvert = async () => {
    setBusy(true);
    try {
      const res = await recruitmentService.convert(convModal.candidate._id);
      const data = res?.data || res; // unwrap { user, tempPassword }
      setConvModal({ candidate: convModal.candidate, result: data });
      loadCandidates();
      loadJobs();
    } catch (err) {
      flash('error', errText(err));
      setConvModal(null);
    } finally { setBusy(false); }
  };

  if (!isHR) {
    return <div className="p-6"><div className="card p-6">🚫 Recruitment is managed by Company Admin &amp; HR Manager only.</div></div>;
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-indigo-300">
            <BriefcaseBusiness className="h-4 w-4" /> Recruitment workspace
          </div>
          <h1 className="mt-1 text-2xl font-bold text-slate-100">Jobs and hiring pipeline</h1>
          <p className="mt-1 text-sm text-slate-400">
            Create traceable jobs from approved requisitions and manage candidates.
          </p>
        </div>
        {canCreateJob && (
          <button className="btn-primary gap-2" onClick={() => openJobModal(null)}>
            <FilePlus2 className="h-4 w-4" /> Post standalone job
          </button>
        )}
      </header>

      <nav className="flex gap-6 overflow-x-auto border-b border-slate-800 text-sm">
        <Link
          to="/app/recruitment/requisitions"
          className="px-1 pb-3 text-slate-400 transition hover:text-slate-200"
        >
          Requisitions
        </Link>
        <Link
          to="/app/recruitment/approvals"
          className="px-1 pb-3 text-slate-400 transition hover:text-slate-200"
        >
          HR approvals
        </Link>
        <Link
          to="/app/recruitment/candidates"
          className="px-1 pb-3 text-slate-400 transition hover:text-slate-200"
        >
          Candidates
        </Link>
        <span className="border-b-2 border-indigo-400 px-1 pb-3 font-semibold text-indigo-300">
          Jobs & candidate pipeline
        </span>
        <span className="cursor-not-allowed px-1 pb-3 text-slate-600" title="Later Phase 27 subphase">
          Analytics
        </span>
      </nav>

      {banner && (
        <div className={`card px-4 py-3 text-sm ${banner.type === 'error' ? 'text-crewly-red' : 'text-crewly-green'}`}>{banner.text}</div>
      )}

      {/* job chips */}
      {loading ? (
        <div className="card p-4 text-crewly-dim">Loading jobs…</div>
      ) : jobs.length === 0 ? (
        <div className="card p-8 text-center text-crewly-dim">No jobs yet — click <b>+ Post Job</b> to open your first position 🚀</div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {jobs.map((j) => (
            <button key={j._id} onClick={() => setSelectedId(j._id)}
              className={`rounded-lg px-3 py-2 text-sm border transition ${
                j._id === selectedId
                  ? 'border-crewly-green bg-crewly-green/10 text-crewly-green'
                  : 'border-crewly-border text-crewly-dim hover:text-crewly-text'
              }`}>
              📌 {j.title}
              <span className="ml-1 text-xs">({j.candidateCount})</span>
              {j.status === 'CLOSED' && <span className="ml-1 text-[10px] text-crewly-red">CLOSED</span>}
            </button>
          ))}
        </div>
      )}

      {/* selected job header */}
      {selected && (
        <>
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold text-slate-100">{selected.title}</p>
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                    selected.status === 'OPEN'
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                      : 'border-rose-500/30 bg-rose-500/10 text-rose-300'
                  }`}>
                    {selected.status}
                  </span>
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                    selected.publicationStatus === 'PUBLISHED'
                      ? 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300'
                      : 'border-slate-700 bg-slate-800/60 text-slate-400'
                  }`}>
                    {enumLabel(selected.publicationStatus || 'DRAFT')}
                  </span>
                  {selected.sourceRequisitionNumber && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2 py-0.5 text-[10px] font-semibold text-indigo-300">
                      <BadgeCheck className="h-3 w-3" /> {selected.sourceRequisitionNumber}
                    </span>
                  )}
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  {TYPE_LABEL[selected.employmentType]} · {selected.location} · {selected.openings} opening(s)
                  {selected.department?.name ? ` · ${selected.department.name}` : ''}
                </div>
              </div>
              {selected.publicationStatus === 'PUBLISHED' && publicJobUrl(selected) && (
                <>
                  <button
                    type="button"
                    className="btn-ghost gap-1.5 text-xs"
                    onClick={() => copyPublicJobUrl(selected)}
                    title="Copy public job URL"
                  >
                    {copiedJobCode === selected.jobCode
                      ? <Check className="h-3.5 w-3.5 text-emerald-300" />
                      : <Copy className="h-3.5 w-3.5" />}
                    {copiedJobCode === selected.jobCode ? 'Copied' : 'Copy public link'}
                  </button>
                  <a
                    className="btn-ghost gap-1.5 text-xs"
                    href={publicJobUrl(selected)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> Open public job
                  </a>
                </>
              )}
              <button className="btn-primary" onClick={() => setCandModal(true)} disabled={selected.status !== 'OPEN'}>+ Add Candidate</button>
              <button className="btn-ghost text-xs" onClick={() => openJobModal(selected)}>Edit Job</button>
              <button className="btn-ghost text-xs" onClick={toggleJobStatus}>
                {selected.status === 'OPEN' ? 'Close Job' : 'Reopen Job'}
              </button>
            </div>

            {selected.publicationStatus === 'PUBLISHED' && (
              <div className={`mt-4 rounded-lg border px-3 py-2 text-xs ${
                careerCompany?.careerPortalEnabled
                  ? 'border-indigo-500/25 bg-indigo-500/10 text-indigo-200'
                  : 'border-amber-500/25 bg-amber-500/10 text-amber-200'
              }`}>
                <div className="flex items-center gap-2">
                  <Globe2 className="h-4 w-4 shrink-0" />
                  {careerCompany?.careerPortalEnabled ? (
                    <span className="min-w-0 truncate">
                      Public URL: {publicJobUrl(selected) || 'Career URL is being prepared'}
                    </span>
                  ) : (
                    <span>
                      This job is published, but the company career portal is disabled.{' '}
                      <Link to="/app/company" className="font-semibold underline">
                        Open company settings
                      </Link>
                    </span>
                  )}
                </div>
              </div>
            )}

            {selected.sourceRequisition && (
              <div className="mt-4 grid gap-3 border-t border-slate-800 pt-4 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-lg bg-slate-950/50 p-3">
                  <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-500">
                    <Building2 className="h-3 w-3" /> Team / work mode
                  </p>
                  <p className="mt-1 text-xs text-slate-200">
                    {selected.team || 'No team'} · {enumLabel(selected.workMode)}
                  </p>
                </div>
                <div className="rounded-lg bg-slate-950/50 p-3">
                  <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-500">
                    <Users className="h-3 w-3" /> Experience
                  </p>
                  <p className="mt-1 text-xs text-slate-200">
                    {selected.experienceLevel === 'FRESHER'
                      ? 'Fresher'
                      : `${selected.minExperience}–${selected.maxExperience} years`}
                  </p>
                </div>
                <div className="rounded-lg bg-slate-950/50 p-3">
                  <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-500">
                    Salary range
                  </p>
                  <p className="mt-1 text-xs text-slate-200">
                    {moneyLabel(selected.salaryMin)} – {moneyLabel(selected.salaryMax)}
                  </p>
                </div>
                <div className="rounded-lg bg-slate-950/50 p-3">
                  <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-500">
                    <CalendarDays className="h-3 w-3" /> Expected joining
                  </p>
                  <p className="mt-1 text-xs text-slate-200">{dateLabel(selected.expectedJoiningDate)}</p>
                </div>
                <div className="sm:col-span-2 xl:col-span-4">
                  <p className="text-[10px] uppercase tracking-wide text-slate-500">Approved skills</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(selected.requiredSkills || []).map((skill) => (
                      <span key={skill} className="rounded-full bg-indigo-500/10 px-2 py-1 text-[11px] text-indigo-300">
                        {skill}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Phase 27.8 — every configured stage is visible and mutations use the audited API. */}
          <div className="flex gap-3 overflow-x-auto pb-3" aria-label="Candidate pipeline board">
            {STAGES.map(({ key, label, dot }) => {
              const list = candidates.filter(
                (candidate) => (candidate.currentStage || candidate.stage) === key
              );
              return (
                <div key={key} className="min-w-[230px] flex-1">
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-crewly-dim">
                    <span className={`h-2 w-2 rounded-full ${dot}`} /> {label}
                    <span className="ml-auto rounded-full bg-slate-800 px-2 py-0.5">{list.length}</span>
                  </div>
                  <div className="space-y-2">
                    {list.length === 0 && <div className="card p-3 text-center text-[11px] text-crewly-dim">No candidates</div>}
                    {list.map((candidate) => {
                      const currentStage = candidate.currentStage || candidate.stage;
                      return (
                        <div key={candidate._id} className="card space-y-2 p-3">
                          <Link
                            className="block text-sm font-medium hover:text-indigo-300"
                            to={`/app/recruitment/candidates/${candidate.candidateCode || candidate._id}`}
                          >
                            {candidate.name}
                          </Link>
                          <div className="truncate text-xs text-crewly-dim" title={candidate.email}>{candidate.email}</div>
                          {candidate.phone && <div className="text-xs text-crewly-dim">{candidate.phone}</div>}
                          {candidate.offerStatus !== 'NONE' && (
                            <span className={`inline-block rounded-md px-2 py-0.5 text-[11px] ${OFFER_STYLE[candidate.offerStatus]}`}>
                              Offer {candidate.offerStatus.toLowerCase()}
                            </span>
                          )}
                          {currentStage !== 'JOINED' && (
                            <select
                              aria-label={`Move ${candidate.name} to another stage`}
                              className="input !py-1 text-xs"
                              value={currentStage}
                              onChange={(event) => requestStageMove(candidate, event.target.value)}
                            >
                              {PIPELINE_STAGES.map((stage) => (
                                <option key={stage} value={stage}>{STAGE_LABEL[stage]}</option>
                              ))}
                            </select>
                          )}
                          <div className="flex flex-wrap gap-2">
                            {[
                              'INTERVIEW_1',
                              'INTERVIEW_2',
                              'INTERVIEW_3',
                              'MANAGER_ROUND',
                              'HR_FINAL',
                              'FINAL_REVIEW',
                              'SELECTED',
                              'OFFER',
                            ].includes(currentStage) && (
                              <button className="btn-ghost px-2 py-0.5 text-[11px]" onClick={() => openOffer(candidate)}>Offer</button>
                            )}
                            {candidate.offerStatus === 'ACCEPTED' && currentStage !== 'JOINED' && (
                              <button className="btn-ghost px-2 py-0.5 text-[11px] text-crewly-green"
                                onClick={() => setConvModal({ candidate, result: null })}>Convert</button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {stageModal && (
        <Modal
          onClose={() => !busy && setStageModal(null)}
          title={`Move ${stageModal.candidate.name}`}
        >
          <form className="space-y-4" onSubmit={moveStage}>
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">Stage transition</p>
              <p className="mt-2 text-sm text-slate-200">
                {STAGE_LABEL[stageModal.fromStage]} → {STAGE_LABEL[stageModal.targetStage]}
              </p>
            </div>
            <div>
              <label className="label">
                Reason {stageMoveRequiresReason ? '*' : '(optional)'}
              </label>
              <textarea
                className="input min-h-24"
                value={stageReason}
                onChange={(event) => setStageReason(event.target.value)}
                maxLength={1000}
                required={stageMoveRequiresReason}
                placeholder={
                  stageMoveRequiresReason
                    ? 'Explain the disposition or why the candidate is being sent back'
                    : 'Add context for the candidate timeline'
                }
              />
              <p className="mt-1 text-right text-[10px] text-slate-500">{stageReason.length}/1000</p>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setStageModal(null)} disabled={busy}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={busy || (stageMoveRequiresReason && !stageReason.trim())}>
                {busy ? 'Moving…' : 'Confirm stage change'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Job create/edit modal. Approved requisition fields stay read-only. */}
      {jobModal.open && (
        <Modal
          onClose={closeJobModal}
          wide={Boolean(jobModal.requisition)}
          title={
            jobModal.editing
              ? 'Edit job'
              : jobModal.requisition
                ? `Create job from ${jobModal.requisition.requisitionNumber}`
                : 'Post a standalone job'
          }
        >
          <form onSubmit={saveJob} className="space-y-5">
            {jobModal.requisition ? (
              <>
                <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-4">
                  <p className="flex items-center gap-2 text-sm font-semibold text-emerald-300">
                    <BadgeCheck className="h-4 w-4" /> Approved hiring requirement
                  </p>
                  <p className="mt-1 text-xs text-emerald-200/70">
                    Approved headcount, department, skills, salary, and work arrangement will be copied to the job and remain linked to this requisition.
                  </p>
                </div>

                <section>
                  <h3 className="mb-3 text-sm font-semibold text-slate-200">
                    {jobModal.requisition.position}
                  </h3>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {[
                      ['Department', jobModal.requisition.department?.name || 'Unavailable'],
                      ['Team', jobModal.requisition.team || 'Not set'],
                      ['Openings', String(jobModal.requisition.openings)],
                      ['Employment', TYPE_LABEL[jobModal.requisition.employmentType]],
                      ['Experience', jobModal.requisition.experienceLevel === 'FRESHER' ? 'Fresher' : `${jobModal.requisition.minExperience}–${jobModal.requisition.maxExperience} years`],
                      ['Work mode', enumLabel(jobModal.requisition.workMode)],
                      ['Location', jobModal.requisition.location],
                      ['Expected joining', dateLabel(jobModal.requisition.expectedJoiningDate)],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                        <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
                        <p className="mt-1 text-xs text-slate-200">{value || 'Not set'}</p>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                    <p className="text-xs font-semibold text-slate-300">Approved skills</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {(jobModal.requisition.requiredSkills || []).map((skill) => (
                        <span key={skill} className="rounded-full bg-indigo-500/10 px-2.5 py-1 text-xs text-indigo-300">
                          {skill}
                        </span>
                      ))}
                    </div>
                    {(jobModal.requisition.preferredSkills || []).length > 0 && (
                      <>
                        <p className="mt-4 text-[10px] uppercase tracking-wide text-slate-500">Preferred</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {jobModal.requisition.preferredSkills.map((skill) => (
                            <span key={skill} className="rounded-full bg-sky-500/10 px-2.5 py-1 text-xs text-sky-300">
                              {skill}
                            </span>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                    <p className="text-xs font-semibold text-slate-300">Approved budget</p>
                    <div className="mt-3 grid grid-cols-3 gap-2">
                      <div>
                        <p className="text-[10px] uppercase text-slate-500">Salary min</p>
                        <p className="mt-1 text-xs text-slate-200">{moneyLabel(jobModal.requisition.salaryMin)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase text-slate-500">Salary max</p>
                        <p className="mt-1 text-xs text-slate-200">{moneyLabel(jobModal.requisition.salaryMax)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase text-slate-500">Hiring budget</p>
                        <p className="mt-1 text-xs text-slate-200">{moneyLabel(jobModal.requisition.hiringBudget)}</p>
                      </div>
                    </div>
                    <p className="mt-4 text-[10px] uppercase text-slate-500">Business reason</p>
                    <p className="mt-1 text-xs text-slate-300">
                      {enumLabel(jobModal.requisition.hiringReason)}
                      {jobModal.requisition.hiringReasonDetails
                        ? ` — ${jobModal.requisition.hiringReasonDetails}`
                        : ''}
                    </p>
                  </div>
                </section>
              </>
            ) : (
              <>
                <div>
                  <label className="label">Job Title *</label>
                  <input
                    className="input"
                    value={jobForm.title}
                    onChange={(event) => setJobForm((form) => ({ ...form, title: event.target.value }))}
                    required
                    minLength={3}
                    maxLength={120}
                    placeholder="Associate DevOps Engineer"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Department</label>
                    <select className="input" value={jobForm.department} onChange={(event) => setJobForm((form) => ({ ...form, department: event.target.value }))}>
                      <option value="">— None —</option>
                      {departments.map((department) => <option key={department._id} value={department._id}>{department.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label">Employment Type</label>
                    <select className="input" value={jobForm.employmentType} onChange={(event) => setJobForm((form) => ({ ...form, employmentType: event.target.value }))}>
                      {Object.entries(TYPE_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label">Location</label>
                    <input className="input" value={jobForm.location} onChange={(event) => setJobForm((form) => ({ ...form, location: event.target.value }))} placeholder="Chennai / Remote" />
                  </div>
                  <div>
                    <label className="label">Openings</label>
                    <input className="input" type="number" min="1" max="500" value={jobForm.openings} onChange={(event) => setJobForm((form) => ({ ...form, openings: event.target.value }))} />
                  </div>
                </div>
              </>
            )}

            {!jobModal.requisition && (
              <section className="rounded-xl border border-indigo-500/25 bg-indigo-500/5 p-4">
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-indigo-300" />
                  <h3 className="text-sm font-semibold text-slate-200">ATS matching requirements</h3>
                </div>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  These requirements feed the explainable ATS analysis. Changing them does not automatically shortlist or reject anyone.
                </p>

                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="label">Work mode</label>
                    <select
                      className="input"
                      value={jobForm.workMode}
                      onChange={(event) => setJobForm((form) => ({ ...form, workMode: event.target.value }))}
                    >
                      <option value="ONSITE">On-site</option>
                      <option value="HYBRID">Hybrid</option>
                      <option value="REMOTE">Remote</option>
                    </select>
                  </div>
                  <div>
                    <label className="label">Experience level</label>
                    <select
                      className="input"
                      value={jobForm.experienceLevel}
                      onChange={(event) => setJobForm((form) => ({ ...form, experienceLevel: event.target.value }))}
                    >
                      <option value="EXPERIENCED">Experienced</option>
                      <option value="FRESHER">Fresher</option>
                    </select>
                  </div>
                  <div>
                    <label className="label">Minimum experience in years</label>
                    <input
                      className="input"
                      type="number"
                      min="0"
                      max="60"
                      step="0.5"
                      value={jobForm.minExperience}
                      disabled={jobForm.experienceLevel === 'FRESHER'}
                      onChange={(event) => setJobForm((form) => ({ ...form, minExperience: event.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="label">Maximum experience in years</label>
                    <input
                      className="input"
                      type="number"
                      min="0"
                      max="60"
                      step="0.5"
                      value={jobForm.maxExperience}
                      disabled={jobForm.experienceLevel === 'FRESHER'}
                      onChange={(event) => setJobForm((form) => ({ ...form, maxExperience: event.target.value }))}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="label">Required skills</label>
                    <input
                      className="input"
                      value={jobForm.requiredSkills}
                      maxLength={1000}
                      onChange={(event) => setJobForm((form) => ({ ...form, requiredSkills: event.target.value }))}
                      placeholder="Node.js, MongoDB, REST APIs"
                    />
                    <p className="mt-1 text-[10px] text-slate-500">Separate skills with commas.</p>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="label">Preferred skills</label>
                    <input
                      className="input"
                      value={jobForm.preferredSkills}
                      maxLength={1000}
                      onChange={(event) => setJobForm((form) => ({ ...form, preferredSkills: event.target.value }))}
                      placeholder="TypeScript, Redis"
                    />
                    <p className="mt-1 text-[10px] text-slate-500">Separate skills with commas.</p>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="label">Education requirements</label>
                    <input
                      className="input"
                      value={jobForm.educationRequirements}
                      maxLength={1000}
                      onChange={(event) => setJobForm((form) => ({ ...form, educationRequirements: event.target.value }))}
                      placeholder="Bachelor's degree in Computer Science"
                    />
                    <p className="mt-1 text-[10px] text-slate-500">Optional. Separate multiple requirements with commas.</p>
                  </div>
                  <div>
                    <label className="label">Maximum notice period in days</label>
                    <input
                      className="input"
                      type="number"
                      min="0"
                      max="365"
                      value={jobForm.maxNoticePeriod}
                      onChange={(event) => setJobForm((form) => ({ ...form, maxNoticePeriod: event.target.value }))}
                    />
                  </div>
                </div>
              </section>
            )}

            <div>
              <label className="label">
                {jobModal.requisition ? 'Job description and responsibilities' : 'Description'}
              </label>
              <textarea
                className="input min-h-32"
                maxLength={2000}
                value={jobForm.description}
                onChange={(event) => setJobForm((form) => ({ ...form, description: event.target.value }))}
                placeholder="Describe responsibilities, outcomes, and role expectations"
              />
              <p className="mt-1 text-right text-[10px] text-slate-500">{jobForm.description.length}/2000</p>
            </div>

            {jobModal.editing && (
              <section className="rounded-xl border border-indigo-500/25 bg-indigo-500/5 p-4">
                <div className="flex items-center gap-2">
                  <Globe2 className="h-4 w-4 text-indigo-300" />
                  <h3 className="text-sm font-semibold text-slate-200">Public career publication</h3>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  Job code {jobModal.editing.jobCode || 'is being prepared'}. Publishing never changes the operational OPEN/CLOSED status.
                </p>

                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="label">Publication status</label>
                    <select
                      className="input"
                      value={jobForm.publicationStatus}
                      onChange={(event) => setJobForm((form) => ({
                        ...form,
                        publicationStatus: event.target.value,
                      }))}
                    >
                      <option value="DRAFT">Draft</option>
                      <option value="PUBLISHED">Published</option>
                      <option value="PAUSED">Paused</option>
                      <option value="ARCHIVED">Archived</option>
                    </select>
                  </div>
                  <div>
                    <label className="label">Application deadline</label>
                    <input
                      type="date"
                      className="input"
                      value={jobForm.applicationDeadline}
                      min={jobForm.publicationStatus === 'PUBLISHED' ? minimumDeadline : undefined}
                      onChange={(event) => setJobForm((form) => ({
                        ...form,
                        applicationDeadline: event.target.value,
                      }))}
                    />
                    <p className="mt-1 text-[10px] text-slate-500">Optional. Published jobs expire after this date.</p>
                  </div>
                </div>

                <label className="mt-4 flex items-start gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-slate-900 text-indigo-500"
                    checked={jobForm.publicSalaryVisible}
                    onChange={(event) => setJobForm((form) => ({
                      ...form,
                      publicSalaryVisible: event.target.checked,
                    }))}
                  />
                  Show the approved salary range on the public job page when salary data exists
                </label>

                {jobForm.publicationStatus === 'PUBLISHED' && jobModal.editing.status !== 'OPEN' && (
                  <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                    Reopen this job before publishing it.
                  </p>
                )}
              </section>
            )}

            <div className="flex flex-col-reverse gap-2 border-t border-slate-800 pt-4 sm:flex-row sm:items-center sm:justify-end">
              {jobModal.requisition && (
                <p className="text-xs text-slate-500 sm:mr-auto">
                  Creating this job is recorded once and cannot be repeated for the same requisition.
                </p>
              )}
              <button type="button" className="btn-ghost" onClick={closeJobModal} disabled={busy}>Cancel</button>
              <button type="submit" className="btn-primary gap-2" disabled={busy}>
                <BriefcaseBusiness className="h-4 w-4" />
                {busy
                  ? 'Saving…'
                  : jobModal.editing
                    ? 'Save Job'
                    : jobModal.requisition
                      ? 'Create open job'
                      : 'Post Job'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ── add candidate modal ── */}
      {candModal && (
        <Modal onClose={() => setCandModal(false)} title={`👤 Add Candidate — ${selected?.title}`}>
          <form onSubmit={saveCandidate} className="space-y-3">
            <div>
              <label className="label">Full Name *</label>
              <input className="input" value={candForm.name} onChange={(e) => setCandForm((f) => ({ ...f, name: e.target.value }))} required minLength={2} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Email *</label>
                <input className="input" type="email" value={candForm.email} onChange={(e) => setCandForm((f) => ({ ...f, email: e.target.value }))} required />
              </div>
              <div>
                <label className="label">Phone</label>
                <input className="input" value={candForm.phone} onChange={(e) => setCandForm((f) => ({ ...f, phone: e.target.value }))} placeholder="9876543210" />
              </div>
            </div>
            <div>
              <label className="label">Resume Link (Drive/portfolio URL)</label>
              <input className="input" value={candForm.resumeLink} onChange={(e) => setCandForm((f) => ({ ...f, resumeLink: e.target.value }))} placeholder="https://…" />
            </div>
            <div>
              <label className="label">Notes</label>
              <textarea className="input" rows={2} value={candForm.notes} onChange={(e) => setCandForm((f) => ({ ...f, notes: e.target.value }))} />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setCandModal(false)}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Add to Pipeline'}</button>
            </div>
          </form>
        </Modal>
      )}

      {/* ── offer modal ── */}
      {offerModal && (
        <Modal onClose={() => setOfferModal(null)} title={`💼 Offer — ${offerModal.name}`}>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Offer Salary (₹/month)</label>
                <input className="input" type="number" min="0" value={offerForm.offerSalary}
                  onChange={(e) => setOfferForm((f) => ({ ...f, offerSalary: e.target.value }))}
                  disabled={offerModal.offerStatus !== 'NONE'} />
              </div>
              <div>
                <label className="label">Joining Date</label>
                <input className="input" type="date" value={offerForm.offerJoiningDate}
                  onChange={(e) => setOfferForm((f) => ({ ...f, offerJoiningDate: e.target.value }))}
                  disabled={offerModal.offerStatus !== 'NONE'} />
              </div>
            </div>

            {offerModal.offerStatus === 'NONE' && (
              <button className="btn-primary w-full" disabled={busy} onClick={() => sendOffer('SENT')}>
                {busy ? 'Sending…' : '📨 Mark Offer Sent'}
              </button>
            )}
            {offerModal.offerStatus === 'SENT' && (
              <>
                <p className="text-xs text-crewly-dim">Offer sent. Now record the candidate's reply:</p>
                <div className="flex gap-2">
                  <button className="btn-primary flex-1" disabled={busy} onClick={() => sendOffer('ACCEPTED')}>✅ Accepted</button>
                  <button className="btn-ghost flex-1 text-crewly-red" disabled={busy} onClick={() => sendOffer('DECLINED')}>❌ Declined</button>
                </div>
              </>
            )}
            {offerModal.offerStatus === 'ACCEPTED' && (
              <div className="rounded-lg border border-crewly-green/40 bg-crewly-green/10 px-3 py-2 text-sm text-crewly-green">
                Offer accepted 🎉 Close this and click <b>🎉 Convert</b> on the card to create the employee account.
              </div>
            )}
            {offerModal.offerStatus === 'DECLINED' && (
              <div className="rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-3 py-2 text-sm text-crewly-red">
                Offer declined. Move the card to Rejected or keep it in Offer while you re-negotiate.
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* ── convert modal ── */}
      {convModal && (
        <Modal onClose={() => setConvModal(null)} title={`🎉 Convert — ${convModal.candidate.name}`}>
          {!convModal.result ? (
            <div className="space-y-3">
              <p className="text-sm text-crewly-dim">
                This will create an <b>EMPLOYEE</b> account for <b>{convModal.candidate.name}</b> ({convModal.candidate.email}),
                with designation <b>{selected?.title}</b>{selected?.department?.name ? ` in ${selected.department.name}` : ''},
                joining date from the accepted offer, and an auto employee code. A temporary password will be generated — share it with the new hire.
              </p>
              <div className="flex justify-end gap-2">
                <button className="btn-ghost" onClick={() => setConvModal(null)}>Cancel</button>
                <button className="btn-primary" disabled={busy} onClick={doConvert}>{busy ? 'Converting…' : '🎉 Convert to Employee'}</button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="rounded-lg border border-crewly-green/40 bg-crewly-green/10 px-3 py-2 text-sm text-crewly-green">
                Employee account created! 🎉
              </div>
              <div className="card p-3 space-y-1 text-sm">
                <div><span className="text-crewly-dim">Name:</span> {convModal.result.user?.name}</div>
                <div><span className="text-crewly-dim">Login email:</span> {convModal.result.user?.email}</div>
                <div><span className="text-crewly-dim">Employee code:</span> {convModal.result.user?.employeeCode}</div>
                <div>
                  <span className="text-crewly-dim">Temp password:</span>{' '}
                  <b className="font-mono text-crewly-green">{convModal.result.tempPassword}</b>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  className="btn-ghost flex-1"
                  onClick={() => {
                    const text = `Crewly HRMS login → email: ${convModal.result.user?.email} | password: ${convModal.result.tempPassword}`;
                    try { navigator.clipboard.writeText(text); } catch { /* clipboard blocked */ }
                  }}>
                  📋 Copy credentials
                </button>
                <button className="btn-primary flex-1" onClick={() => setConvModal(null)}>Done</button>
              </div>
              <p className="text-xs text-crewly-dim">⚠️ Shown once — share it now. Password can be reset later via Users → Reset PW.</p>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
};

export default RecruitmentPage;
