import { Link } from 'react-router-dom';
import { ArrowRight, Check } from 'lucide-react';
import { SECTION_IDS, WORKFLOW_BLOCKS } from '../landingData.js';

// Alternating rows: copy, then a supporting panel. The panel is markup, not a
// screenshot, so it stays crisp on every screen and adds no request.
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
    <div aria-hidden="true" className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
      <div className="space-y-2.5">
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
  <section id={SECTION_IDS.workflow} className="scroll-mt-24 border-t border-white/10 px-5 py-16 sm:px-6 lg:px-8 lg:py-24">
    <div className="mx-auto max-w-7xl">
      <div className="max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400">How it works</p>
        <h2 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">
          The boring parts, joined up
        </h2>
        <p className="mt-4 text-base leading-relaxed text-slate-400">
          Most HR software does not fail at features — it fails at the seams between
          them. These are the seams Crewly closes.
        </p>
      </div>

      <div className="mt-12 space-y-14">
        {WORKFLOW_BLOCKS.map((block, index) => (
          <div
            key={block.key}
            className={`grid items-center gap-8 lg:grid-cols-2 lg:gap-14 ${
              index % 2 === 1 ? 'lg:[&>*:first-child]:order-2' : ''
            }`}
          >
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300">{block.eyebrow}</p>
              <h3 className="mt-3 text-2xl font-bold tracking-tight text-white sm:text-3xl">{block.title}</h3>
              <ul className="mt-5 space-y-3">
                {block.points.map((point) => (
                  <li key={point} className="flex gap-3 text-sm leading-relaxed text-slate-300">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>

              {block.cta?.to ? (
                <Link
                  to={block.cta.to}
                  className="mt-6 inline-flex items-center gap-2 rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-slate-100 transition-colors hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
                >
                  {block.cta.label}
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              ) : (
                <a
                  href={block.cta.href}
                  className="mt-6 inline-flex items-center gap-2 rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-slate-100 transition-colors hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
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
