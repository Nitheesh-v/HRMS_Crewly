import { TRUST_CHIPS } from '../landingData.js';
import LandingIcon from '../LandingIcon.jsx';

// Keka's trust band is a customer wall. There are no customers in this
// repository, so this band makes the honest version of the same promise: the
// things that are true on every plan, on day one, whatever you pay.
const CapabilityStrip = () => (
  <section className="bg-white px-5 py-12 sm:px-6 lg:px-8">
    <div className="mx-auto max-w-7xl">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">Every plan includes</p>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            Not a feature list you have to upgrade for — the foundations of the workspace are the same
            whether you run five people or five hundred.
          </p>
        </div>

        <ul className="grid flex-1 gap-2.5 sm:grid-cols-2 lg:max-w-3xl lg:grid-cols-3">
          {TRUST_CHIPS.map((chip) => (
            <li
              key={chip.label}
              className="flex items-center gap-2.5 rounded-xl border border-crewly-lilac-line bg-crewly-lilac/50 px-3.5 py-2.5 text-[13px] font-medium text-crewly-ink-soft transition-colors hover:border-violet-200 hover:bg-violet-50"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white text-violet-700 ring-1 ring-crewly-lilac-line">
                <LandingIcon name={chip.icon} className="h-3.5 w-3.5" />
              </span>
              {chip.label}
            </li>
          ))}
        </ul>
      </div>
    </div>
  </section>
);

export default CapabilityStrip;
