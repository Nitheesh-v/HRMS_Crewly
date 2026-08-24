/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  BriefcaseBusiness,
  CheckCircle2,
  FileText,
  Send,
  ShieldCheck,
  UploadCloud,
} from 'lucide-react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import publicCareerService from '../../services/publicCareerService.js';

const configuredResumeSizeMb = Number(
  import.meta.env.VITE_MAX_RESUME_SIZE_MB || 5
);
const MAX_RESUME_SIZE_MB = Number.isFinite(configuredResumeSizeMb)
  ? Math.min(10, Math.max(1, configuredResumeSizeMb))
  : 5;
const MAX_RESUME_SIZE = MAX_RESUME_SIZE_MB * 1024 * 1024;
const ACCEPTED_RESUME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const EMPTY_FORM = {
  fullName: '',
  email: '',
  phone: '',
  location: '',
  currentCompany: '',
  currentTitle: '',
  totalExperience: '',
  relevantExperience: '',
  expectedSalary: '',
  noticePeriod: '',
  degree: '',
  institution: '',
  graduationYear: '',
  skills: '',
  linkedIn: '',
  github: '',
  portfolio: '',
  consent: false,
};

const Field = ({ label, required = false, children, hint = '' }) => (
  <label className="block">
    <span className="mb-1.5 block text-sm font-medium text-slate-200">
      {label}{required ? <span className="text-rose-300"> *</span> : null}
    </span>
    {children}
    {hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}
  </label>
);

const CareerApplyShellPage = () => {
  const { company, companySlug } = useOutletContext();
  const { jobCode } = useParams();
  const fileInputRef = useRef(null);
  const [state, setState] = useState({
    loading: true,
    job: null,
    error: '',
  });
  const [form, setForm] = useState(EMPTY_FORM);
  const [resume, setResume] = useState(null);
  const [fileError, setFileError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(null);

  useEffect(() => {
    let active = true;
    setState({ loading: true, job: null, error: '' });

    publicCareerService
      .job(companySlug, jobCode)
      .then((result) => {
        if (!active) return;
        document.title = `Apply for ${result.job.title} — ${company.name}`;
        setState({ loading: false, job: result.job, error: '' });
      })
      .catch((error) => {
        if (!active) return;
        document.title = `Application unavailable — ${company.name}`;
        setState({
          loading: false,
          job: null,
          error: error?.message || 'This application is not available',
        });
      });

    return () => {
      active = false;
    };
  }, [company.name, companySlug, jobCode]);

  const updateField = (event) => {
    const { name, type, value, checked } = event.target;
    setForm((current) => ({
      ...current,
      [name]: type === 'checkbox' ? checked : value,
    }));
  };

  const selectResume = (event) => {
    const file = event.target.files?.[0] || null;
    setFileError('');

    if (!file) {
      setResume(null);
      return;
    }

    const extension = file.name.toLowerCase().split('.').pop();
    const acceptedExtension = ['pdf', 'docx'].includes(extension);
    const acceptedType = ACCEPTED_RESUME_TYPES.has(file.type);

    if (!acceptedExtension || !acceptedType) {
      setResume(null);
      setFileError('Choose a valid PDF or DOCX resume.');
      event.target.value = '';
      return;
    }

    if (file.size > MAX_RESUME_SIZE) {
      setResume(null);
      setFileError(`Resume must be ${MAX_RESUME_SIZE_MB} MB or smaller.`);
      event.target.value = '';
      return;
    }

    setResume(file);
  };

  const submitApplication = async (event) => {
    event.preventDefault();
    setSubmitError('');

    if (!resume) {
      setFileError('A PDF or DOCX resume is required.');
      fileInputRef.current?.focus();
      return;
    }

    setSubmitting(true);

    try {
      const data = new FormData();

      Object.entries(form).forEach(([key, value]) => {
        if (key === 'consent') {
          data.append(key, String(value));
        } else if (value !== '') {
          data.append(key, value);
        }
      });
      data.append('resume', resume);

      const result = await publicCareerService.apply(
        companySlug,
        jobCode,
        data
      );

      setForm(EMPTY_FORM);
      setResume(null);
      setFileError('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      setSuccess(result);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      setSubmitError(
        error?.message ||
          'Your application could not be submitted. Please try again.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (state.loading) {
    return (
      <div className="mx-auto max-w-5xl px-5 py-16">
        <div className="h-96 animate-pulse rounded-3xl bg-slate-900" />
      </div>
    );
  }

  if (!state.job) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-12 sm:py-16">
        <section className="rounded-3xl border border-slate-800 bg-slate-900 p-7 sm:p-10">
          <BriefcaseBusiness className="h-10 w-10 text-slate-600" />
          <h1 className="mt-4 text-xl font-semibold text-white">Application unavailable</h1>
          <p className="mt-2 text-sm text-slate-400">{state.error}</p>
          <Link
            to={`/careers/${companySlug}/jobs`}
            className="btn-primary mt-6 inline-flex"
          >
            View open jobs
          </Link>
        </section>
      </div>
    );
  }

  if (success) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-12 sm:py-16">
        <section className="rounded-3xl border border-emerald-500/25 bg-slate-900 p-7 text-center shadow-2xl shadow-emerald-950/20 sm:p-12">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-300">
            <CheckCircle2 className="h-8 w-8" />
          </div>
          <p className="mt-6 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300">
            Application received
          </p>
          <h1 className="mt-3 text-2xl font-bold text-white sm:text-3xl">
            Thank you for applying
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-slate-400">
            {company.name} received your application for {success.job?.title || state.job.title}.
            A confirmation will be sent to the email address you provided when delivery is available.
          </p>
          <dl className="mx-auto mt-8 grid max-w-xl gap-3 text-left sm:grid-cols-2">
            <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
              <dt className="text-xs uppercase tracking-wide text-slate-500">Application reference</dt>
              <dd className="mt-1 font-mono text-sm font-semibold text-slate-100">
                {success.applicationReference}
              </dd>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
              <dt className="text-xs uppercase tracking-wide text-slate-500">Job reference</dt>
              <dd className="mt-1 font-mono text-sm font-semibold text-slate-100">
                {success.job?.jobCode || state.job.jobCode}
              </dd>
            </div>
          </dl>
          <p className="mt-5 text-xs text-slate-500">
            Submitted {success.submittedAt
              ? new Date(success.submittedAt).toLocaleString()
              : 'just now'}
          </p>
          <Link
            to={`/careers/${companySlug}/jobs`}
            className="btn-primary mt-8 inline-flex"
          >
            View other open jobs
          </Link>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-5 py-10 sm:py-14">
      <Link
        to={`/careers/${companySlug}/jobs/${jobCode}`}
        className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" /> Back to role
      </Link>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start">
        <section className="rounded-3xl border border-slate-800 bg-slate-900 p-6 sm:p-9">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-500/10 text-indigo-300">
            <BriefcaseBusiness className="h-6 w-6" />
          </div>
          <p className="mt-5 text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300">
            {state.job.jobCode}
          </p>
          <h1 className="mt-2 text-2xl font-bold text-white sm:text-3xl">
            Apply for {state.job.title}
          </h1>
          <p className="mt-2 text-sm text-slate-400">{company.name}</p>

          <form className="mt-9 space-y-8" onSubmit={submitApplication}>
            <fieldset>
              <legend className="text-base font-semibold text-white">Contact information</legend>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="Full name" required>
                  <input className="input" name="fullName" value={form.fullName} onChange={updateField} required minLength={2} maxLength={100} autoComplete="name" />
                </Field>
                <Field label="Email" required>
                  <input className="input" type="email" name="email" value={form.email} onChange={updateField} required maxLength={254} autoComplete="email" />
                </Field>
                <Field label="Phone" required>
                  <input className="input" type="tel" name="phone" value={form.phone} onChange={updateField} required minLength={6} maxLength={20} autoComplete="tel" />
                </Field>
                <Field label="Location">
                  <input className="input" name="location" value={form.location} onChange={updateField} maxLength={120} autoComplete="address-level2" placeholder="Chennai, Tamil Nadu" />
                </Field>
              </div>
            </fieldset>

            <fieldset>
              <legend className="text-base font-semibold text-white">Professional profile</legend>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="Current company">
                  <input className="input" name="currentCompany" value={form.currentCompany} onChange={updateField} maxLength={120} autoComplete="organization" />
                </Field>
                <Field label="Current title">
                  <input className="input" name="currentTitle" value={form.currentTitle} onChange={updateField} maxLength={120} autoComplete="organization-title" />
                </Field>
                <Field label="Total experience" hint="Years, including decimals such as 3.5">
                  <input className="input" type="number" name="totalExperience" value={form.totalExperience} onChange={updateField} min="0" max="60" step="0.1" />
                </Field>
                <Field label="Relevant experience" hint="Years relevant to this role">
                  <input className="input" type="number" name="relevantExperience" value={form.relevantExperience} onChange={updateField} min="0" max="60" step="0.1" />
                </Field>
                <Field label="Expected annual salary">
                  <input className="input" type="number" name="expectedSalary" value={form.expectedSalary} onChange={updateField} min="0" max="1000000000" step="1" inputMode="numeric" />
                </Field>
                <Field label="Notice period" hint="Number of days">
                  <input className="input" type="number" name="noticePeriod" value={form.noticePeriod} onChange={updateField} min="0" max="365" step="1" />
                </Field>
              </div>
            </fieldset>

            <fieldset>
              <legend className="text-base font-semibold text-white">Education and skills</legend>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="Degree">
                  <input className="input" name="degree" value={form.degree} onChange={updateField} maxLength={120} />
                </Field>
                <Field label="Institution">
                  <input className="input" name="institution" value={form.institution} onChange={updateField} maxLength={160} />
                </Field>
                <Field label="Graduation year">
                  <input className="input" type="number" name="graduationYear" value={form.graduationYear} onChange={updateField} min="1950" max={new Date().getFullYear() + 5} step="1" />
                </Field>
                <Field label="Skills" hint="Separate up to 20 skills with commas">
                  <input className="input" name="skills" value={form.skills} onChange={updateField} maxLength={1000} placeholder="React, Node.js, MongoDB" />
                </Field>
              </div>
            </fieldset>

            <fieldset>
              <legend className="text-base font-semibold text-white">Professional links</legend>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="LinkedIn">
                  <input className="input" type="url" name="linkedIn" value={form.linkedIn} onChange={updateField} maxLength={300} placeholder="https://www.linkedin.com/in/..." />
                </Field>
                <Field label="GitHub">
                  <input className="input" type="url" name="github" value={form.github} onChange={updateField} maxLength={300} placeholder="https://github.com/..." />
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Portfolio">
                    <input className="input" type="url" name="portfolio" value={form.portfolio} onChange={updateField} maxLength={300} placeholder="https://..." />
                  </Field>
                </div>
              </div>
            </fieldset>

            <fieldset>
              <legend className="text-base font-semibold text-white">Resume</legend>
              <label className="mt-4 flex cursor-pointer flex-col items-center rounded-2xl border border-dashed border-slate-700 bg-slate-950/40 px-5 py-7 text-center transition hover:border-indigo-400/60 hover:bg-indigo-500/5">
                <UploadCloud className="h-7 w-7 text-indigo-300" />
                <span className="mt-3 text-sm font-medium text-slate-200">
                  {resume ? resume.name : 'Choose your resume'}
                </span>
                <span className="mt-1 text-xs text-slate-500">
                  PDF or DOCX, up to {MAX_RESUME_SIZE_MB} MB
                </span>
                <input
                  ref={fileInputRef}
                  className="sr-only"
                  type="file"
                  name="resume"
                  accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={selectResume}
                  required
                />
              </label>
              {fileError ? <p className="mt-2 text-sm text-rose-300">{fileError}</p> : null}
            </fieldset>

            <label className="flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4 text-sm leading-6 text-slate-300">
              <input
                className="mt-1 h-4 w-4 rounded border-slate-600 bg-slate-900 text-indigo-500"
                type="checkbox"
                name="consent"
                checked={form.consent}
                onChange={updateField}
                required
              />
              <span>
                I consent to {company.name} processing the information in this application for recruitment purposes. I confirm the information provided is accurate.
              </span>
            </label>

            {submitError ? (
              <div role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                {submitError}
              </div>
            ) : null}

            <button type="submit" className="btn-primary w-full justify-center gap-2 sm:w-auto" disabled={submitting}>
              <Send className="h-4 w-4" />
              {submitting ? 'Submitting application…' : 'Submit application'}
            </button>
          </form>
        </section>

        <aside className="space-y-4 lg:sticky lg:top-24">
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Role</p>
            <p className="mt-2 font-semibold text-white">{state.job.title}</p>
            <p className="mt-1 font-mono text-xs text-indigo-300">{state.job.jobCode}</p>
          </div>
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5">
            <ShieldCheck className="h-5 w-5 text-emerald-300" />
            <p className="mt-3 text-sm font-medium text-emerald-100">Private resume handling</p>
            <p className="mt-2 text-xs leading-5 text-emerald-100/60">
              Your original resume is stored privately. It is available only to authorized members of the hiring team through authenticated access.
            </p>
          </div>
          <div className="flex items-start gap-3 rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <FileText className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
            <p className="text-xs leading-5 text-slate-400">
              Submission confirms receipt only. Hiring decisions remain with the hiring team.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
};

export default CareerApplyShellPage;
