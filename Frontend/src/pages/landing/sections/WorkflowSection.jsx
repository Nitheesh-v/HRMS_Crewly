import { Link } from 'react-router-dom';
import { ArrowRight, Check } from 'lucide-react';
import { SECTION_IDS, WORKFLOW_BLOCKS } from '../landingData.js';

// Alternating rows: copy, then a supporting panel. The panel is markup, not a
// screenshot, so it stays crisp on every screen and adds no request. Each row
// carries a numbered step rail — the "how it works" read as a path, not a list.
const Panel = ({ blockKey }) => {
  const rows = {
    hire: [
      { label: 'Senior React Developer', meta: 'Interview 2 · feedback due', tone: 'border-emerald-400/30 text-emerald-300' },
      { label: 'Requisition HR-1042', meta: 'Approved by HR', tone: 'border-indigo-400/30 text-indigo-300' },
      { label: 'Pre-onboarding · 3 documents', meta: 'Awaiting employee', tone: 'border-white/15 text-slate-300' },
    ],
    time: [
      { label: 'Check-in 09:04 · Office', meta: 'Within geo-fence', tone: 'border-emerald-400/30 text-emerald-300' },
      { label: 'Regularisation request', meta: 'Approved · 1 day', tone: 'border-indigo-400/30 text-indigo-300' },
      { label: 'Payroll inputs locked', meta: '120 employees', tone: 'border-white/15 text-slate-300' },
    ],
    team: [
      { label: 'Away after 10 min idle', meta: 'Set per company', tone: 'border-amber-400/30 text-amber-300' },
      { label: 'Session ended → offline', meta: 'Detected automatically', tone: 'border-rose-400/30 text-rose-300' },
      { label: 'Team visibility', meta: 'Manager scope only', tone: 'border-emerald-400/30 text-emerald-300' },
    ],
  }[blockKey];

  return (
    <div aria-hidden="true" className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
      <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.02] px-4 py-2.5">
        <span className="flex gap-1.5">
          <span className="h-2 w-2 rounded-full bg-white/15" />
          <span className="h-2 w-2 rounded-full bg-white/15" />
          <span className="h-2 w-2 rounded-full bg-white/15" />
        </span>
        <span className="ml-1 text-[10px] font-medium uppercase tracking-[0.14em] text-slate-500">
          In the product
        </span>
      </div>
      <div className="space-y-2.5 p-4 sm:p-5">
        {rows.map((row) => (
          <div key={row.label} className={`rounded-xl border bg-[#0e1526]/70 px-3.5 py-3 ${row.tone}`}>
            <p className="text-sm font-medium text-slate-100">{row.label}</p>
            <p className="mt-0.5 text-xs opacity-80">{row.meta}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

const WorkflowSection = () => (
  <section id={SECTION_IDS.workflow} className="relative scroll-mt-24 border-t border-white/10 px-5 py-16 sm:px-6 lg:px-8 lg:py-24">
    <div
      className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_55%_35%_at_80%_10%,rgba(99,102,241,0.07),transparent)]"
      aria-hidden="true"
    />

    <div className="mx-auto max-w-7xl">
      <div className="max-w-2xl">
        <div className="flex items-center gap-3">
          <span className="h-px w-8 bg-gradient-to-r from-emerald-400 to-transparent" aria-hidden="true" />
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400">How it works</p>
        </div>
        <h2 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">
          The boring parts, joined up
        </h2>
        <p className="mt-4 text-base leading-relaxed text-slate-400">
          Most HR software does not fail at features — it fails at the seams between
          them. These are the seams Crewly closes.
        </p>
      </div>

      <div className="mt-12 space-y-16">
        {WORKFLOW_BLOCKS.map((block, index) => (
          <div
            key={block.key}
            className={`relative grid items-center gap-8 lg:grid-cols-2 lg:gap-14 ${
              index % 2 === 1 ? 'lg:[&>*:first-child]:order-2' : ''
            }`}
          >
            <div>
              <div className="flex items-center gap-3">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-emerald-400/30 bg-emerald-500/10 text-sm font-bold text-emerald-300">
                  {index + 1}
                </span>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300">{block.eyebrow}</p>
                <span className="hidden h-px flex-1 bg-gradient-to-r from-white/15 to-transparent sm:block" aria-hidden="true" />
              </div>
              <h3 className="mt-4 text-2xl font-bold tracking-tight text-white sm:text-3xl">{block.title}</h3>
              <ul className="mt-5 space-y-3">
                {block.points.map((point) => (
                  <li key={point} className="flex gap-3 text-sm leading-relaxed text-slate-300">
                    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/15">
                      <Check className="h-2.5 w-2.5 text-emerald-300" aria-hidden="true" />
                    </span>
                    <span>{point}</span>
                  </li>
                ))}
              </ul>

              {block.cta?.to ? (
                <Link
                  to={block.cta.to}
                  className="mt-6 inline-flex items-center gap-2 rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-slate-100 transition-colors hover:border-white/25 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
                >
                  {block.cta.label}
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              ) : (
                <a
                  href={block.cta.href}
                  className="mt-6 inline-flex items-center gap-2 rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-slate-100 transition-colors hover:border-white/25 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
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
