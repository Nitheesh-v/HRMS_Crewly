import { TRUST_CHIPS } from '../landingData.js';
import LandingIcon from '../LandingIcon.jsx';

// There are no customers in this repository to fill a logo wall, so this band
// makes the honest version of the same promise: what is true on every plan, on
// day one, whatever you pay.
//
// Laid out as an instrument panel rather than six floating pills: one card, a
// label column, and a hairline grid built from `gap-px` over a tinted parent, so
// the rules line up at every breakpoint without arithmetic on nth-child.
const CapabilityStrip = () => (
  <section className="border-t border-white/[0.06] bg-[#080d19] px-5 py-12 sm:px-6 lg:px-8">
    <div className="mx-auto max-w-7xl">
      <div className="overflow-hidden rounded-2xl border border-white/10">
        <div className="grid bg-white/[0.06] lg:grid-cols-[18rem_1fr]">
          <div className="bg-[#0a0f1d] p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400">Every plan includes</p>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              Not a feature list you have to upgrade for — the foundations are the same whether you run five
              people or five hundred.
            </p>
          </div>

          <ul className="grid gap-px bg-white/[0.06] sm:grid-cols-2 lg:grid-cols-3">
            {TRUST_CHIPS.map((chip) => (
              <li
                key={chip.label}
                className="flex items-center gap-2.5 bg-[#0a0f1d] px-5 py-3.5 text-[13px] font-medium text-slate-300 transition-colors hover:bg-white/[0.04]"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-emerald-400/20 bg-emerald-500/10 text-emerald-300">
                  <LandingIcon name={chip.icon} className="h-3.5 w-3.5" />
                </span>
                {chip.label}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  </section>
);

export default CapabilityStrip;
