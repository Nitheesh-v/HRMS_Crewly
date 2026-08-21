import { useEffect, useState } from 'react';
import {
  ArrowRight,
  BriefcaseBusiness,
  Building2,
  MapPin,
  Sparkles,
} from 'lucide-react';
import { Link, useOutletContext } from 'react-router-dom';
import publicCareerService from '../../services/publicCareerService.js';
import CareerJobCard from './CareerJobCard.jsx';

const CareerLandingPage = () => {
  const { company, companySlug, openJobs } = useOutletContext();
  const [state, setState] = useState({
    loading: true,
    jobs: [],
    error: '',
  });

  useEffect(() => {
    let active = true;
    document.title = `${company.name} Careers`;

    publicCareerService
      .jobs(companySlug, { page: 1, limit: 6, sort: 'NEWEST' })
      .then((result) => {
        if (!active) return;
        setState({ loading: false, jobs: result.jobs, error: '' });
      })
      .catch((error) => {
        if (!active) return;
        setState({
          loading: false,
          jobs: [],
          error: error?.message || 'Could not load open jobs',
        });
      });

    return () => {
      active = false;
    };
  }, [company.name, companySlug]);

  return (
    <div>
      <section className="relative overflow-hidden border-b border-slate-800">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(99,102,241,0.16),transparent_38%),radial-gradient(circle_at_bottom_left,rgba(16,185,129,0.1),transparent_35%)]" />
        <div className="relative mx-auto grid max-w-6xl gap-10 px-5 py-16 lg:grid-cols-[1.35fr_0.65fr] lg:items-center lg:py-24">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1 text-xs font-semibold text-indigo-300">
              <Sparkles className="h-3.5 w-3.5" /> Build your future with us
            </p>
            <h1 className="mt-5 max-w-3xl text-4xl font-bold tracking-tight text-white sm:text-5xl">
              Do meaningful work at {company.name}
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-slate-400 sm:text-lg">
              {company.about ||
                'Explore current opportunities and find a role where your skills can make an impact.'}
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                to={`/careers/${companySlug}/jobs`}
                className="btn-primary gap-2 !px-5 !py-3"
              >
                View open positions <ArrowRight className="h-4 w-4" />
              </Link>
              {company.website && (
                <a
                  href={company.website}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-ghost !px-5 !py-3"
                >
                  Learn about {company.name}
                </a>
              )}
            </div>
          </div>

          <aside className="rounded-3xl border border-slate-800 bg-slate-900/80 p-6 shadow-2xl shadow-slate-950/60">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-300">
              <BriefcaseBusiness className="h-6 w-6" />
            </div>
            <p className="mt-6 text-4xl font-bold text-white">{openJobs}</p>
            <p className="mt-1 text-sm text-slate-400">
              open position{openJobs === 1 ? '' : 's'}
            </p>
            <div className="mt-6 space-y-3 border-t border-slate-800 pt-5 text-sm text-slate-400">
              <p className="flex items-center gap-2">
                <Building2 className="h-4 w-4 text-indigo-300" /> {company.name}
              </p>
              {company.location && (
                <p className="flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-indigo-300" /> {company.location}
                </p>
              )}
            </div>
          </aside>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-14">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">
              Latest opportunities
            </p>
            <h2 className="mt-2 text-2xl font-bold text-white">Find your next role</h2>
          </div>
          {openJobs > 0 && (
            <Link
              to={`/careers/${companySlug}/jobs`}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-indigo-300 hover:text-indigo-200"
            >
              Browse all jobs <ArrowRight className="h-4 w-4" />
            </Link>
          )}
        </div>

        {state.loading ? (
          <div className="mt-7 grid gap-4 lg:grid-cols-2">
            {[1, 2, 3, 4].map((item) => (
              <div key={item} className="h-52 animate-pulse rounded-2xl bg-slate-900" />
            ))}
          </div>
        ) : state.error ? (
          <div className="mt-7 rounded-2xl border border-rose-500/30 bg-rose-500/10 p-6 text-sm text-rose-300">
            {state.error}
          </div>
        ) : state.jobs.length === 0 ? (
          <div className="mt-7 rounded-2xl border border-dashed border-slate-700 bg-slate-900/50 p-10 text-center">
            <BriefcaseBusiness className="mx-auto h-9 w-9 text-slate-600" />
            <h3 className="mt-3 font-semibold text-slate-200">No open roles right now</h3>
            <p className="mt-1 text-sm text-slate-500">Please check back for future opportunities.</p>
          </div>
        ) : (
          <div className="mt-7 grid gap-4 lg:grid-cols-2">
            {state.jobs.map((job) => (
              <CareerJobCard key={job.jobCode} companySlug={companySlug} job={job} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

export default CareerLandingPage;
