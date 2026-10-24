import { Link } from 'react-router-dom';
import { ArrowRight, Check } from 'lucide-react';
import { SECTION_IDS, WORKFLOW_BLOCKS } from '../landingData.js';

// Three alternating rows: copy on one side, a small product frame on the other.
// The frame is markup, so it stays crisp and adds no request; it is decorative
// and hidden from assistive technology.
const Panel = ({ blockKey }) => {
  const rows = {
    hire: [
      { label: 'Senior React Developer', meta: 'Interview 2 · feedback due', tone: 'bg-emerald-50 text-emerald-800' },
      { label: 'Requisition HR-1042', meta: 'Approved by HR', tone: 'bg-violet-50 text-violet-800' },
      { label: 'Pre-onboarding · 3 documents', meta: 'Awaiting candidate', tone: 'bg-slate-50 text-slate-700' },
    ],
    time: [
      { label: 'Check-in 09:04 · Office', meta: 'Within geo-fence', tone: 'bg-emerald-50 text-emerald-800' },
      { label: 'Regularisation request', meta: 'Approved · 1 day', tone: 'bg-violet-50 text-violet-800' },
      { label: 'Payroll inputs locked', meta: 'October run', tone: 'bg-slate-50 text-slate-700' },
    ],
    team: [
      { label: 'Away after 10 min idle', meta: 'Set per company', tone: 'bg-amber-50 text-amber-900' },
      { label: 'Session ended → offline', meta: 'Detected automatically', tone: 'bg-rose-50 text-rose-800' },
      { label: 'Team visibility', meta: 'Manager scope only', tone: 'bg-emerald-50 text-emerald-800' },
    ],
  }[blockKey];

  return (
    <div aria-hidden="true" className="landing-preview overflow-hidden rounded-2xl">
      <div className="flex items-center gap-2 border-b border-slate-200/80 bg-slate-50/80 px-4 py-2.5">
        <span className="flex gap-1.5">
          <span className="h-2 w-2 rounded-full bg-slate-300" />
          <span className="h-2 w-2 rounded-full bg-slate-300" />
          <span className="h-2 w-2 rounded-full bg-slate-300" />
        </span>
        <span className="ml-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          In the product
        </span>
      </div>
      <div className="space-y-2.5 bg-white p-4 sm:p-5">
        {rows.map((row) => (
          <div key={row.label} className={`rounded-xl px-3.5 py-3 ${row.tone}`}>
            <p className="text-sm font-semibold">{row.label}</p>
            <p className="mt-0.5 text-[11px] opacity-75">{row.meta}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

const WorkflowSection = () => (
  <section
    id={SECTION_IDS.workflow}
    className="scroll-mt-28 border-t border-crewly-lilac-line bg-crewly-lilac/40 px-5 py-16 sm:px-6 lg:px-8 lg:py-24"
  >
    <div className="mx-auto max-w-7xl">
      <div className="max-w-2xl">
        <div className="flex items-center gap-3">
          <span className="h-px w-8 bg-gradient-to-r from-violet-500 to-transparent" aria-hidden="true" />
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">How it works</p>
        </div>
        <h2 className="mt-3 text-3xl font-bold tracking-tight text-crewly-ink sm:text-4xl">
          The boring parts, joined up
        </h2>
        <p className="mt-4 text-base leading-relaxed text-slate-600">
          Most HR software does not fail at features — it fails at the seams between them. These are the
          seams Crewly closes, in the order the work actually happens.
        </p>
      </div>

      <div className="mt-12 space-y-10">
        {WORKFLOW_BLOCKS.map((block, index) => (
          <div
            key={block.key}
            className={`relative grid items-center gap-8 rounded-3xl border border-white bg-white p-6 shadow-[0_20px_50px_-42px_rgba(23,18,51,0.6)] sm:p-8 lg:grid-cols-2 lg:gap-14 ${
              index % 2 === 1 ? 'lg:[&>*:first-child]:order-2' : ''
            }`}
          >
            <div>
              <div className="flex items-center gap-3">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-violet-100 text-sm font-bold text-violet-800">
                  {index + 1}
                </span>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">{block.eyebrow}</p>
                <span
                  className="hidden h-px flex-1 bg-gradient-to-r from-slate-200 to-transparent sm:block"
                  aria-hidden="true"
                />
              </div>

              <h3 className="mt-4 text-2xl font-bold tracking-tight text-crewly-ink sm:text-[1.75rem]">
                {block.title}
              </h3>

              <ul className="mt-5 space-y-3">
                {block.points.map((point) => (
                  <li key={point} className="flex gap-3 text-sm leading-relaxed text-slate-600">
                    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-50 ring-1 ring-emerald-100">
                      <Check className="h-2.5 w-2.5 text-emerald-700" aria-hidden="true" />
                    </span>
                    <span>{point}</span>
                  </li>
                ))}
              </ul>

              {block.cta?.to ? (
                <Link
                  to={block.cta.to}
                  className="mt-6 inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-crewly-ink transition-colors hover:border-slate-400 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700"
                >
                  {block.cta.label}
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              ) : (
                <a
                  href={block.cta.href}
                  className="mt-6 inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-crewly-ink transition-colors hover:border-slate-400 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700"
                >
                  {block.cta.label}
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </a>
              )}
            </div>

            <Panel blockKey={block.key} />
          </div>
        ))}
      </div>
    </div>
  </section>
);

export default WorkflowSection;
