import { Link } from 'react-router-dom';
import { ArrowRight, Check } from 'lucide-react';
import { SECTION_IDS, WORKFLOW_BLOCKS } from '../landingData.js';
import { eyebrow, ghostLink, sectionCopy, sectionTitle } from '../landingStyles.js';

// Three alternating rows: copy on one side, a small product frame on the other.
// The frame is markup, so it stays crisp and adds no request; it is decorative
// and hidden from assistive technology.
const Panel = ({ blockKey }) => {
  const rows = {
    hire: [
      { label: 'Senior React Developer', meta: 'Interview 2 · feedback due', tone: 'border-emerald-400/25 bg-emerald-500/[0.07] text-emerald-200' },
      { label: 'Requisition HR-1042', meta: 'Approved by HR', tone: 'border-violet-400/25 bg-violet-500/[0.07] text-violet-200' },
      { label: 'Pre-onboarding · 3 documents', meta: 'Awaiting candidate', tone: 'border-white/10 bg-white/[0.03] text-slate-300' },
    ],
    time: [
      { label: 'Check-in 09:04 · Office', meta: 'Within geo-fence', tone: 'border-emerald-400/25 bg-emerald-500/[0.07] text-emerald-200' },
      { label: 'Regularisation request', meta: 'Approved · 1 day', tone: 'border-teal-400/25 bg-teal-500/[0.07] text-teal-200' },
      { label: 'Payroll inputs locked', meta: 'October run', tone: 'border-white/10 bg-white/[0.03] text-slate-300' },
    ],
    team: [
      { label: 'Away after 10 min idle', meta: 'Set per company', tone: 'border-amber-400/25 bg-amber-400/[0.07] text-amber-200' },
      { label: 'Session ended → offline', meta: 'Detected automatically', tone: 'border-rose-400/25 bg-rose-500/[0.07] text-rose-200' },
      { label: 'Team visibility', meta: 'Manager scope only', tone: 'border-emerald-400/25 bg-emerald-500/[0.07] text-emerald-200' },
    ],
  }[blockKey];

  return (
    <div aria-hidden="true" className="landing-preview overflow-hidden rounded-2xl">
      <div className="flex items-center gap-2 border-b border-white/[0.08] bg-white/[0.03] px-4 py-2.5">
        <span className="flex gap-1.5">
          <span className="h-2 w-2 rounded-full bg-white/15" />
          <span className="h-2 w-2 rounded-full bg-white/15" />
          <span className="h-2 w-2 rounded-full bg-white/15" />
        </span>
        <span className="ml-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          In the product
        </span>
      </div>
      <div className="space-y-2.5 p-4 sm:p-5">
        {rows.map((row) => (
          <div key={row.label} className={`rounded-xl border px-3.5 py-3 ${row.tone}`}>
            <p className="text-sm font-semibold">{row.label}</p>
            <p className="mt-0.5 text-[11px] opacity-70">{row.meta}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

const WorkflowSection = () => (
  <section
    id={SECTION_IDS.workflow}
    className="scroll-mt-28 border-t border-white/[0.06] bg-[#080d19] px-5 py-16 sm:px-6 lg:px-8 lg:py-24"
  >
    <div className="mx-auto max-w-7xl">
      <div className="max-w-2xl">
        <div className="flex items-center gap-3">
          <span className="h-px w-8 bg-gradient-to-r from-emerald-400 to-transparent" aria-hidden="true" />
          <p className={eyebrow}>How it works</p>
        </div>
        <h2 className={sectionTitle}>The boring parts, joined up</h2>
        <p className={sectionCopy}>
          Most HR software does not fail at features — it fails at the seams between them. These are the
          seams Crewly closes, in the order the work actually happens.
        </p>
      </div>

      <div className="mt-12 space-y-8">
        {WORKFLOW_BLOCKS.map((block, index) => (
          <div
            key={block.key}
            className={`relative grid items-center gap-8 rounded-3xl border border-white/10 bg-white/[0.02] p-6 transition-colors hover:border-white/15 sm:p-8 lg:grid-cols-2 lg:gap-14 ${
              index % 2 === 1 ? 'lg:[&>*:first-child]:order-2' : ''
            }`}
          >
            <div>
              <div className="flex items-center gap-3">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-emerald-400/30 bg-emerald-500/10 text-sm font-bold text-emerald-300">
                  {index + 1}
                </span>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-300">{block.eyebrow}</p>
                <span className="landing-hairline hidden h-px flex-1 sm:block" aria-hidden="true" />
              </div>

              <h3 className="mt-4 text-2xl font-bold tracking-tight text-white sm:text-[1.75rem]">{block.title}</h3>

              <ul className="mt-5 space-y-3">
                {block.points.map((point) => (
                  <li key={point} className="flex gap-3 text-sm leading-relaxed text-slate-300">
                    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 ring-1 ring-emerald-400/20">
                      <Check className="h-2.5 w-2.5 text-emerald-300" aria-hidden="true" />
                    </span>
                    <span>{point}</span>
                  </li>
                ))}
              </ul>

              {block.cta?.to ? (
                <Link to={block.cta.to} className={`mt-6 ${ghostLink}`}>
                  {block.cta.label}
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              ) : (
                <a href={block.cta.href} className={`mt-6 ${ghostLink}`}>
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
