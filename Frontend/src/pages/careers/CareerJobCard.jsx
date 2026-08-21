import {
  ArrowRight,
  BriefcaseBusiness,
  Building2,
  Clock3,
  MapPin,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  careerDateLabel,
  careerEnumLabel,
  careerExperienceLabel,
} from './careerFormatters.js';

const CareerJobCard = ({ companySlug, job }) => (
  <article className="group rounded-2xl border border-slate-800 bg-slate-900 p-5 transition hover:-translate-y-0.5 hover:border-indigo-500/40 hover:shadow-xl hover:shadow-indigo-950/20">
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-wide text-indigo-300">
          {job.jobCode}
        </p>
        <h2 className="mt-1 text-lg font-semibold text-slate-100 group-hover:text-white">
          {job.title}
        </h2>
      </div>
      <BriefcaseBusiness className="h-5 w-5 shrink-0 text-slate-600" />
    </div>

    <div className="mt-4 grid gap-2 text-xs text-slate-400 sm:grid-cols-2">
      <p className="flex items-center gap-2">
        <Building2 className="h-3.5 w-3.5 text-slate-500" />
        {job.department || job.team || 'General'}
      </p>
      <p className="flex items-center gap-2">
        <MapPin className="h-3.5 w-3.5 text-slate-500" />
        {job.location || 'Location flexible'}
      </p>
      <p className="flex items-center gap-2">
        <BriefcaseBusiness className="h-3.5 w-3.5 text-slate-500" />
        {careerEnumLabel(job.employmentType)} · {careerEnumLabel(job.workMode)}
      </p>
      <p className="flex items-center gap-2">
        <Clock3 className="h-3.5 w-3.5 text-slate-500" />
        {careerExperienceLabel(job)}
      </p>
    </div>

    <div className="mt-5 flex items-center justify-between border-t border-slate-800 pt-4">
      <span className="text-[11px] text-slate-500">
        {job.publishedAt ? `Posted ${careerDateLabel(job.publishedAt)}` : 'Open position'}
      </span>
      <Link
        to={`/careers/${companySlug}/jobs/${job.jobCode}`}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-300 transition group-hover:text-indigo-200"
      >
        View role <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  </article>
);

export default CareerJobCard;
