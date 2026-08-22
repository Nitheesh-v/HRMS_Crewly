/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  Download,
  ExternalLink,
  FileText,
  GraduationCap,
  Link2,
  Mail,
  MapPin,
  Phone,
  ShieldCheck,
  UserRound,
  Wrench,
} from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import candidateService from '../../services/candidateService.js';

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

const CandidateDetailPage = () => {
  const { candidateRef } = useParams();
  const [candidate, setCandidate] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeError, setResumeError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');

    candidateService
      .detail(candidateRef)
      .then((result) => {
        if (!active) return;
        setCandidate(result);
        document.title = `${result.overview.name} — Candidate — Crewly HRMS`;
      })
      .catch((requestError) => {
        if (!active) return;
        setError(requestError?.message || 'Candidate could not be loaded');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [candidateRef]);

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
                {enumLabel(candidate.overview.stage)}
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

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start">
        <div className="space-y-5">
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

          <Section icon={CalendarDays} title="Application status">
            <Value label="Current stage" value={enumLabel(candidate.overview.stage)} />
            <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">Screening automation</p>
              <p className="mt-1.5 text-sm font-medium text-slate-300">Not processed</p>
              <p className="mt-1 text-xs leading-5 text-slate-500">No ATS score, ranking, or automated hiring decision is available.</p>
            </div>
          </Section>
        </aside>
      </div>
    </div>
  );
};

export default CandidateDetailPage;
