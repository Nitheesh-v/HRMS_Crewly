import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check } from 'lucide-react';
import { BRAND, PLATFORM_TABS, SECTION_IDS } from '../landingData.js';
import LandingIcon from '../LandingIcon.jsx';
import PlatformPreview from '../PlatformPreview.jsx';
import { onPlatformTabRequested } from '../landingTabs.js';
import { eyebrow, ghostLink, primaryCta } from '../landingStyles.js';

const tabId = (key) => `platform-tab-${key}`;
const panelId = (key) => `platform-panel-${key}`;

// The centrepiece: one workspace, shown six ways.
//
// The tabs are a real ARIA tablist — arrow keys, Home and End move the selection,
// only the active tab is in the tab order, and the panel names the tab that
// controls it. The header's platform menu can open a specific tab through
// landingTabs.js without either component knowing about the other.
const PlatformSection = () => {
  const [activeKey, setActiveKey] = useState(PLATFORM_TABS[0].key);
  const tabRefs = useRef({});
  const active = PLATFORM_TABS.find((tab) => tab.key === activeKey) || PLATFORM_TABS[0];

  useEffect(() => onPlatformTabRequested((key) => {
    if (PLATFORM_TABS.some((tab) => tab.key === key)) setActiveKey(key);
  }), []);

  const focusTab = (index) => {
    const next = PLATFORM_TABS[index];

    setActiveKey(next.key);
    tabRefs.current[next.key]?.focus();
  };

  const onKeyDown = (event, index) => {
    const last = PLATFORM_TABS.length - 1;

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusTab(index === last ? 0 : index + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusTab(index === 0 ? last : index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusTab(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusTab(last);
    }
  };

  return (
    <section
      id={SECTION_IDS.platform}
      className="relative scroll-mt-28 overflow-hidden border-t border-white/[0.06] bg-crewly-night px-5 py-16 sm:px-6 lg:px-8 lg:py-24"
    >
      <div
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_60%_45%_at_50%_0%,rgba(16,185,129,0.09),transparent)]"
        aria-hidden="true"
      />

      <div className="mx-auto max-w-7xl">
        <div className="mx-auto max-w-3xl text-center">
          <div className="flex items-center justify-center gap-3">
            <span className="h-px w-8 bg-gradient-to-l from-emerald-400 to-transparent" aria-hidden="true" />
            <p className={eyebrow}>The platform</p>
            <span className="h-px w-8 bg-gradient-to-r from-emerald-400 to-transparent" aria-hidden="true" />
          </div>
          <h2 className="mt-3 text-balance text-3xl font-bold tracking-tight text-white sm:text-4xl lg:text-[2.9rem]">
            One workspace to run people, time and money
          </h2>
          <p className="mt-4 text-base leading-relaxed text-slate-400">
            Six connected areas, one employee record underneath. Pick an area to see what it actually
            does — every line below is a screen that ships today, not a roadmap item.
          </p>
        </div>

        {/* The tablist scrolls horizontally on a phone rather than shrinking the
            labels into unreadable pills. */}
        <div className="-mx-5 mt-10 overflow-x-auto px-5 pb-1 sm:mx-0 sm:px-0 [scrollbar-width:none]">
          <div
            role="tablist"
            aria-label="Product areas"
            className="mx-auto flex w-max items-center gap-1 rounded-2xl border border-white/10 bg-white/[0.03] p-1.5 sm:w-auto sm:justify-center"
          >
            {PLATFORM_TABS.map((tab, index) => {
              const selected = tab.key === activeKey;

              return (
                <button
                  key={tab.key}
                  ref={(node) => {
                    tabRefs.current[tab.key] = node;
                  }}
                  type="button"
                  role="tab"
                  id={tabId(tab.key)}
                  aria-selected={selected}
                  aria-controls={panelId(tab.key)}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActiveKey(tab.key)}
                  onKeyDown={(event) => onKeyDown(event, index)}
                  className={`inline-flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2.5 text-[13px] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 ${
                    selected
                      ? 'bg-emerald-500 text-[#04231a] shadow-[0_10px_24px_-14px_rgba(16,185,129,0.9)]'
                      : 'text-slate-400 hover:bg-white/[0.05] hover:text-white'
                  }`}
                >
                  <LandingIcon name={tab.icon} className={`h-4 w-4 ${selected ? 'text-[#04231a]' : 'text-emerald-400'}`} />
                  <span className="hidden sm:inline">{tab.label}</span>
                  <span className="sm:hidden">{tab.short}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div
          role="tabpanel"
          id={panelId(active.key)}
          aria-labelledby={tabId(active.key)}
          tabIndex={0}
          className="landing-card mt-10 grid items-center gap-8 rounded-3xl p-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300 sm:p-8 lg:grid-cols-[1.02fr_0.98fr] lg:gap-12 lg:p-10"
        >
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-300">{active.eyebrow}</p>
            <h3 className="mt-3 text-2xl font-bold tracking-tight text-white sm:text-[2rem] sm:leading-tight">
              {active.title}
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-slate-400 sm:text-[15px]">{active.copy}</p>

            <ul className="mt-5 space-y-2.5">
              {active.points.map((point) => (
                <li key={point} className="flex gap-2.5 text-sm leading-relaxed text-slate-300">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 ring-1 ring-emerald-400/20">
                    <Check className="h-2.5 w-2.5 text-emerald-300" aria-hidden="true" />
                  </span>
                  <span>{point}</span>
                </li>
              ))}
            </ul>

            <p className="mt-5 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-2.5 text-xs leading-relaxed text-slate-400">
              {active.footnote}
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Link to="/register" className={primaryCta}>
                Try it free for {BRAND.trialDays} days
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </Link>
              <a href={`#${SECTION_IDS.modules}`} className={ghostLink}>
                See every module
              </a>
            </div>
          </div>

          <div className="relative isolate mt-10 lg:mt-0">
            <div
              className="pointer-events-none absolute -inset-4 -z-10 rounded-3xl bg-[radial-gradient(60%_60%_at_30%_20%,rgba(16,185,129,0.16),transparent_70%),radial-gradient(55%_55%_at_80%_80%,rgba(139,92,246,0.14),transparent_70%)] blur-xl"
              aria-hidden="true"
            />
            <PlatformPreview name={active.preview} />
          </div>
        </div>
      </div>
    </section>
  );
};

export default PlatformSection;
