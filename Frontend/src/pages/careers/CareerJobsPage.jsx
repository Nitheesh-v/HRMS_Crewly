/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import {
  BriefcaseBusiness,
  ChevronLeft,
  ChevronRight,
  Filter,
  Search,
} from 'lucide-react';
import { useOutletContext } from 'react-router-dom';
import publicCareerService from '../../services/publicCareerService.js';
import CareerJobCard from './CareerJobCard.jsx';
import { careerEnumLabel } from './careerFormatters.js';

const EMPTY_FILTERS = {
  department: '',
  location: '',
  workMode: '',
  employmentType: '',
  experience: '',
  sort: 'NEWEST',
};

const CareerJobsPage = () => {
  const { company, companySlug } = useOutletContext();
  const [jobs, setJobs] = useState([]);
  const [meta, setMeta] = useState({ page: 1, pages: 1, total: 0 });
  const [options, setOptions] = useState({
    departments: [],
    locations: [],
    workModes: [],
    employmentTypes: [],
    experience: [],
  });
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    document.title = `Open Jobs — ${company.name} Careers`;
  }, [company.name]);

  useEffect(() => {
    let active = true;

    publicCareerService
      .filters(companySlug)
      .then((result) => {
        if (active) setOptions(result);
      })
      .catch(() => {
        if (active) setOptions((current) => current);
      });

    return () => {
      active = false;
    };
  }, [companySlug]);

  const loadJobs = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const result = await publicCareerService.jobs(companySlug, {
        page,
        limit: 12,
        search: appliedSearch || undefined,
        ...Object.fromEntries(
          Object.entries(filters).filter(([, value]) => value)
        ),
      });
      setJobs(result.jobs);
      setMeta(result.meta);
    } catch (loadError) {
      setJobs([]);
      setError(loadError?.message || 'Could not load open jobs');
    } finally {
      setLoading(false);
    }
  }, [appliedSearch, companySlug, filters, page]);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  const updateFilter = (field) => (event) => {
    setPage(1);
    setFilters((current) => ({
      ...current,
      [field]: event.target.value,
    }));
  };

  const clearFilters = () => {
    setSearch('');
    setAppliedSearch('');
    setFilters(EMPTY_FILTERS);
    setPage(1);
  };

  const hasFilters =
    appliedSearch ||
    Object.entries(filters).some(
      ([key, value]) => key !== 'sort' && Boolean(value)
    );

  return (
    <div className="mx-auto max-w-6xl px-5 py-10 sm:py-14">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">
          Join {company.name}
        </p>
        <h1 className="mt-2 text-3xl font-bold text-white">Open positions</h1>
        <p className="mt-2 text-sm text-slate-400">
          Search current opportunities by team, location and work style.
        </p>
      </header>

      <section className="mt-8 rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <form
          className="relative"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setAppliedSearch(search.trim());
          }}
        >
          <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-500" />
          <input
            className="input !py-2.5 !pl-10 text-sm"
            value={search}
            maxLength={100}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by title, skill or keyword"
          />
        </form>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Filter className="h-4 w-4 text-slate-500" />
          {[
            ['department', 'All departments', options.departments],
            ['location', 'All locations', options.locations],
            ['workMode', 'All work modes', options.workModes],
            ['employmentType', 'All employment types', options.employmentTypes],
            ['experience', 'All experience levels', options.experience],
          ].map(([field, placeholder, values]) => (
            <select
              key={field}
              className="input w-auto min-w-40 !py-2 text-xs"
              value={filters[field]}
              onChange={updateFilter(field)}
            >
              <option value="">{placeholder}</option>
              {(values || []).map((value) => (
                <option key={value} value={value}>
                  {field === 'department' || field === 'location'
                    ? value
                    : careerEnumLabel(value)}
                </option>
              ))}
            </select>
          ))}
          <select
            className="input ml-auto w-auto !py-2 text-xs"
            value={filters.sort}
            onChange={updateFilter('sort')}
          >
            <option value="NEWEST">Newest first</option>
            <option value="OLDEST">Oldest first</option>
            <option value="TITLE_ASC">Title A–Z</option>
          </select>
        </div>
      </section>

      <div className="mt-7 flex items-center justify-between">
        <p className="text-sm text-slate-400">
          {loading ? 'Finding roles…' : `${meta.total || 0} open position${meta.total === 1 ? '' : 's'}`}
        </p>
        {hasFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="text-xs font-semibold text-indigo-300 hover:text-indigo-200"
          >
            Clear filters
          </button>
        )}
      </div>

      {loading ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {[1, 2, 3, 4, 5, 6].map((item) => (
            <div key={item} className="h-52 animate-pulse rounded-2xl bg-slate-900" />
          ))}
        </div>
      ) : error ? (
        <div className="mt-4 rounded-2xl border border-rose-500/30 bg-rose-500/10 p-6 text-sm text-rose-300">
          {error}
        </div>
      ) : jobs.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-slate-700 bg-slate-900/50 p-12 text-center">
          <BriefcaseBusiness className="mx-auto h-10 w-10 text-slate-600" />
          <h2 className="mt-3 font-semibold text-slate-200">
            {hasFilters ? 'No jobs match these filters' : 'No published jobs right now'}
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            {hasFilters
              ? 'Try removing a filter or using a different keyword.'
              : 'Please check back for future opportunities.'}
          </p>
        </div>
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {jobs.map((job) => (
            <CareerJobCard key={job.jobCode} companySlug={companySlug} job={job} />
          ))}
        </div>
      )}

      {!loading && !error && meta.pages > 1 && (
        <nav className="mt-8 flex items-center justify-center gap-3" aria-label="Job pages">
          <button
            type="button"
            className="btn-ghost gap-1 !px-3 !py-2 text-xs"
            disabled={page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            <ChevronLeft className="h-4 w-4" /> Previous
          </button>
          <span className="text-xs text-slate-500">
            Page {meta.page} of {meta.pages}
          </span>
          <button
            type="button"
            className="btn-ghost gap-1 !px-3 !py-2 text-xs"
            disabled={page >= meta.pages}
            onClick={() => setPage((current) => Math.min(meta.pages, current + 1))}
          >
            Next <ChevronRight className="h-4 w-4" />
          </button>
        </nav>
      )}
    </div>
  );
};

export default CareerJobsPage;
