/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  Check,
  Clock3,
  Copy,
  MapPin,
  Users,
} from 'lucide-react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import publicCareerService from '../../services/publicCareerService.js';
import {
  careerDateLabel,
  careerEnumLabel,
  careerExperienceLabel,
} from './careerFormatters.js';

const salaryLabel = (value) =>
  value === null || value === undefined
    ? 'Not disclosed'
    : new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 0,
      }).format(value);

const CareerJobDetailPage = () => {
  const { company, companySlug } = useOutletContext();
  const { jobCode } = useParams();
  const [state, setState] = useState({
    loading: true,
    job: null,
    error: '',
    unavailable: false,
  });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    setState({ loading: true, job: null, error: '', unavailable: false });

    publicCareerService
      .job(companySlug, jobCode)
      .then((result) => {
        if (!active) return;

        document.title = `${result.job.title} — ${company.name} Careers`;
        setState({
          loading: false,
          job: result.job,
          error: '',
          unavailable: false,
        });
      })
      .catch((error) => {
        if (!active) return;

        document.title = `Job unavailable — ${company.name} Careers`;
        setState({
          loading: false,
          job: null,
          error: error?.message || 'Job not found',
          unavailable: error?.status === 410,
        });
      });

    return () => {
      active = false;
    };
  }, [company.name, companySlug, jobCode]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  if (state.loading) {
    return (
      <div className="mx-auto max-w-5xl px-5 py-12">
        <div className="h-8 w-48 animate-pulse rounded bg-slate-900" />
        <div className="mt-6 h-80 animate-pulse rounded-2xl bg-slate-900" />
      </div>
    );
  }

  if (!state.job) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-16">
        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-10 text-center">
          <BriefcaseBusiness className="mx-auto h-10 w-10 text-slate-600" />
          <h1 className="mt-4 text-xl font-semibold text-white">
            {state.unavailable ? 'No longer accepting applications' : 'Job not found'}
          </h1>
          <p className="mt-2 text-sm text-slate-400">{state.error}</p>
          <Link
            to={`/careers/${companySlug}/jobs`}
            className="btn-primary mt-6 inline-flex gap-2"
          >
            <ArrowLeft className="h-4 w-4" /> View open jobs
          </Link>
        </section>
      </div>
    );
  }

  const job = state.job;

  return (
    <div className="mx-auto max-w-5xl px-5 py-10 sm:py-14">
      <Link
        to={`/careers/${companySlug}/jobs`}
        className="inline-flex items-center gap-2 text-sm text-slate-400 transition hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" /> Back to all jobs
      </Link>

      <article className="mt-6 overflow-hidden rounded-3xl border border-slate-800 bg-slate-900">
        <header className="border-b border-slate-800 bg-gradient-to-br from-indigo-500/10 via-slate-900 to-emerald-500/5 p-6 sm:p-9">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300">
                {job.jobCode}
              </p>
              <h1 className="mt-2 text-3xl font-bold text-white sm:text-4xl">{job.title}</h1>
              <p className="mt-3 text-sm text-slate-400">{company.name}</p>
            </div>
            <button
              type="button"
              onClick={copyLink}
              className="btn-ghost gap-2 self-start !px-3 !py-2 text-xs"
            >
              {copied ? <Check className="h-4 w-4 text-emerald-300" /> : <Copy className="h-4 w-4" />}
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>

          <div className="mt-7 grid gap-3 text-sm text-slate-300 sm:grid-cols-2 lg:grid-cols-4">
            <p className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-indigo-300" />
              {job.department || job.team || 'General'}
            </p>
            <p className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-indigo-300" />
              {job.location || 'Location flexible'}
            </p>
            <p className="flex items-center gap-2">
              <BriefcaseBusiness className="h-4 w-4 text-indigo-300" />
              {careerEnumLabel(job.employmentType)} · {careerEnumLabel(job.workMode)}
            </p>
            <p className="flex items-center gap-2">
              <Clock3 className="h-4 w-4 text-indigo-300" />
              {careerExperienceLabel(job)}
            </p>
          </div>
        </header>

        <div className="grid gap-8 p-6 sm:p-9 lg:grid-cols-[1fr_280px]">
          <div className="space-y-8">
            <section>
              <h2 className="text-lg font-semibold text-white">About this role</h2>
              <p className="mt-3 whitespace-pre-line text-sm leading-7 text-slate-300">
                {job.description || 'Role details will be discussed during the hiring process.'}
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-white">Required skills</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {(job.requiredSkills || []).length > 0 ? (
                  job.requiredSkills.map((skill) => (
                    <span key={skill} className="rounded-full bg-indigo-500/10 px-3 py-1.5 text-xs font-medium text-indigo-300">
                      {skill}
                    </span>
                  ))
                ) : (
                  <span className="text-sm text-slate-500">Skills will be discussed with the hiring team.</span>
                )}
              </div>
            </section>

            {(job.preferredSkills || []).length > 0 && (
              <section>
                <h2 className="text-lg font-semibold text-white">Preferred skills</h2>
                <div className="mt-3 flex flex-wrap gap-2">
                  {job.preferredSkills.map((skill) => (
                    <span key={skill} className="rounded-full bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-300">
                      {skill}
                    </span>
                  ))}
                </div>
              </section>
            )}
          </div>

          <aside className="h-fit rounded-2xl border border-slate-800 bg-slate-950/50 p-5">
            <h2 className="font-semibold text-white">Role summary</h2>
            <dl className="mt-4 space-y-4 text-xs">
              <div>
                <dt className="flex items-center gap-2 text-slate-500">
                  <Users className="h-3.5 w-3.5" /> Openings
                </dt>
                <dd className="mt-1 text-slate-200">{job.numberOfOpenings || 1}</dd>
              </div>
              <div>
                <dt className="flex items-center gap-2 text-slate-500">
                  <CalendarDays className="h-3.5 w-3.5" /> Application deadline
                </dt>
                <dd className="mt-1 text-slate-200">
                  {job.applicationDeadline
                    ? careerDateLabel(job.applicationDeadline)
                    : 'Open until filled'}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Published</dt>
                <dd className="mt-1 text-slate-200">
                  {job.publishedAt ? careerDateLabel(job.publishedAt) : 'Recently'}
                </dd>
              </div>
              {job.salary && (
                <div>
                  <dt className="text-slate-500">Salary range</dt>
                  <dd className="mt-1 text-slate-200">
                    {salaryLabel(job.salary.min)} – {salaryLabel(job.salary.max)}
                  </dd>
                </div>
              )}
            </dl>

            <Link
              to={`/careers/${companySlug}/jobs/${job.jobCode}/apply`}
              className="btn-primary mt-6 w-full justify-center"
            >
              Apply for this role
            </Link>
            <p className="mt-3 text-center text-[11px] text-slate-500">
              Application form opens in the next hiring phase.
            </p>
          </aside>
        </div>
      </article>
    </div>
  );
};

export default CareerJobDetailPage;
