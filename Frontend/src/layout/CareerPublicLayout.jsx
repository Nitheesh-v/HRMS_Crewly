/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useState } from 'react';
import { BriefcaseBusiness, Building2, ExternalLink } from 'lucide-react';
import { Link, Outlet, useParams } from 'react-router-dom';
import publicCareerService from '../services/publicCareerService.js';

const CareerPublicLayout = () => {
  const { companySlug } = useParams();
  const [state, setState] = useState({
    loading: true,
    company: null,
    openJobs: 0,
    error: '',
  });

  useEffect(() => {
    let active = true;

    document.title = 'Careers — Crewly';
    setState({ loading: true, company: null, openJobs: 0, error: '' });

    publicCareerService
      .header(companySlug)
      .then((result) => {
        if (!active) return;

        setState({
          loading: false,
          company: result.company,
          openJobs: result.openJobs || 0,
          error: '',
        });
      })
      .catch((error) => {
        if (!active) return;

        setState({
          loading: false,
          company: null,
          openJobs: 0,
          error: error?.message || 'Career portal is not available',
        });
      });

    return () => {
      active = false;
    };
  }, [companySlug]);

  if (state.loading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <div className="mx-auto max-w-6xl px-5 py-8">
          <div className="h-14 animate-pulse rounded-xl bg-slate-900" />
          <div className="mt-10 h-72 animate-pulse rounded-2xl bg-slate-900" />
        </div>
      </div>
    );
  }

  if (!state.company) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 px-5 text-slate-100">
        <section className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center">
          <Building2 className="mx-auto h-10 w-10 text-slate-600" />
          <h1 className="mt-4 text-xl font-semibold">Career portal unavailable</h1>
          <p className="mt-2 text-sm text-slate-400">{state.error}</p>
          <Link to="/" className="btn-primary mt-6 inline-flex">
            Visit Crewly
          </Link>
        </section>
      </div>
    );
  }

  const company = state.company;

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4">
          <Link to={`/careers/${companySlug}`} className="flex min-w-0 items-center gap-3">
            {company.logoUrl ? (
              <img
                src={company.logoUrl}
                alt={`${company.name} logo`}
                className="h-10 w-10 rounded-xl border border-slate-700 bg-white object-contain p-1"
              />
            ) : (
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-300">
                <Building2 className="h-5 w-5" />
              </span>
            )}
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-slate-100">
                {company.name}
              </span>
              <span className="block text-xs text-slate-500">Careers</span>
            </span>
          </Link>

          <nav className="flex items-center gap-2">
            <Link
              to={`/careers/${companySlug}/jobs`}
              className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-300 transition hover:bg-slate-900 hover:text-white"
            >
              <BriefcaseBusiness className="h-4 w-4" /> Open jobs
            </Link>
            {company.website && (
              <a
                href={company.website}
                target="_blank"
                rel="noreferrer"
                className="hidden items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:bg-slate-900 hover:text-white sm:inline-flex"
              >
                Company website <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <Outlet
          context={{
            company,
            companySlug,
            openJobs: state.openJobs,
          }}
        />
      </main>

      <footer className="border-t border-slate-800">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-5 py-6 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <span>© {new Date().getFullYear()} {company.name}</span>
          <span>Careers powered by Crewly HRMS</span>
        </div>
      </footer>
    </div>
  );
};

export default CareerPublicLayout;
