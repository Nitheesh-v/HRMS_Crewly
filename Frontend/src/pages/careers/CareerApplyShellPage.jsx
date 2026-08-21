/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useState } from 'react';
import { ArrowLeft, BriefcaseBusiness, Clock3, ShieldCheck } from 'lucide-react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import publicCareerService from '../../services/publicCareerService.js';

const CareerApplyShellPage = () => {
  const { company, companySlug } = useOutletContext();
  const { jobCode } = useParams();
  const [state, setState] = useState({
    loading: true,
    job: null,
    error: '',
  });

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

  if (state.loading) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-16">
        <div className="h-80 animate-pulse rounded-2xl bg-slate-900" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-5 py-12 sm:py-16">
      <Link
        to={`/careers/${companySlug}/jobs/${jobCode}`}
        className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" /> Back to role
      </Link>

      <section className="mt-6 rounded-3xl border border-slate-800 bg-slate-900 p-7 sm:p-10">
        {state.job ? (
          <>
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-500/10 text-indigo-300">
              <BriefcaseBusiness className="h-6 w-6" />
            </div>
            <p className="mt-6 text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300">
              {state.job.jobCode}
            </p>
            <h1 className="mt-2 text-2xl font-bold text-white sm:text-3xl">
              Apply for {state.job.title}
            </h1>
            <p className="mt-2 text-sm text-slate-400">{company.name}</p>

            <div className="mt-8 rounded-2xl border border-amber-500/25 bg-amber-500/10 p-5">
              <p className="flex items-center gap-2 font-semibold text-amber-200">
                <Clock3 className="h-5 w-5" /> Online applications are coming soon
              </p>
              <p className="mt-2 text-sm leading-6 text-amber-100/70">
                This is a preview of the application experience. Candidate creation,
                resume upload and form submission are intentionally not enabled in this phase.
              </p>
            </div>

            <div className="mt-6 flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" />
              <p className="text-xs leading-5 text-slate-400">
                No candidate data is collected on this page. Return to the job page to review
                the role while {company.name} prepares its application form.
              </p>
            </div>
          </>
        ) : (
          <>
            <BriefcaseBusiness className="h-10 w-10 text-slate-600" />
            <h1 className="mt-4 text-xl font-semibold text-white">Application unavailable</h1>
            <p className="mt-2 text-sm text-slate-400">{state.error}</p>
            <Link
              to={`/careers/${companySlug}/jobs`}
              className="btn-primary mt-6 inline-flex"
            >
              View open jobs
            </Link>
          </>
        )}
      </section>
    </div>
  );
};

export default CareerApplyShellPage;
