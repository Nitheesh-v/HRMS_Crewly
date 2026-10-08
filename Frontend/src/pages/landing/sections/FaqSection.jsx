import { useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { FAQS, SECTION_IDS } from '../landingData.js';

// A real disclosure: the trigger is a button with aria-expanded and it names the
// panel it controls, so the answer is reachable by keyboard and announced by a
// screen reader. Only one panel is open at a time — six open panels is a wall.
const FaqSection = () => {
  const [openIndex, setOpenIndex] = useState(0);

  return (
    <section id={SECTION_IDS.faq} className="scroll-mt-24 border-t border-white/10 px-5 py-16 sm:px-6 lg:px-8 lg:py-24">
      <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400">FAQ</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Questions worth asking before you sign up
          </h2>
          <p className="mt-4 text-base leading-relaxed text-slate-400">
            If something is not answered here, the workspace itself has a support desk —
            raise a ticket and keep the thread inside your own company.
          </p>
        </div>

        <div className="divide-y divide-white/10 rounded-2xl border border-white/10 bg-white/[0.03]">
          {FAQS.map((faq, index) => {
            const open = openIndex === index;
            const panelId = `faq-panel-${index}`;
            const buttonId = `faq-trigger-${index}`;

            return (
              <div key={faq.q}>
                <h3>
                  <button
                    type="button"
                    id={buttonId}
                    aria-expanded={open}
                    aria-controls={panelId}
                    onClick={() => setOpenIndex(open ? -1 : index)}
                    className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-white/[0.03] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-emerald-400"
                  >
                    <span className="text-sm font-semibold text-white sm:text-base">{faq.q}</span>
                    <span
                      aria-hidden="true"
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/10 ${
                        open ? 'bg-emerald-500/15 text-emerald-300' : 'text-slate-400'
                      }`}
                    >
                      {open ? <Minus className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                    </span>
                  </button>
                </h3>

                {open && (
                  <div id={panelId} role="region" aria-labelledby={buttonId} className="px-5 pb-5">
                    <p className="max-w-2xl text-sm leading-relaxed text-slate-400">{faq.a}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default FaqSection;
