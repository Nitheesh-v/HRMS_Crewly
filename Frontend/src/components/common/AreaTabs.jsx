import { NavLink, useLocation } from 'react-router-dom';

// ═══════════════════════════════════════════════════════════════════════════
// AREA TABS — the Settings-style strip that replaced two long sidebar sections.
//
// Payroll and Time & Leave both grew past a dozen rows each. Both now show a
// few AREAS in the rail and present the pages inside an area as this strip,
// borrowed from the Settings screen: active tab is a filled copper pill,
// inactive tabs are plain text, and the strip wraps rather than scrolls.
//
// This component is presentation only. Which tabs exist — and who may open
// them — is decided by config/timeNav.js, so the rail
// and the strip can never disagree about a page.
//
// `active` is the longest matching tab path, so a detail route (an employee's
// payroll record, a staged import batch) keeps its parent tab lit instead of
// leaving none lit.
// ═══════════════════════════════════════════════════════════════════════════

const tabClass = (isActive) =>
  `inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] transition ${
    isActive
      ? 'bg-st-primary-container font-bold text-st-on-primary-container'
      : 'font-semibold text-st-on-variant hover:bg-st-low hover:text-st-on'
  }`;

const AreaTabs = ({ areaLabel, description, tabs = [] }) => {
  const { pathname } = useLocation();

  const activeTab = tabs
    .filter((tab) => pathname === tab.to || pathname.startsWith(`${tab.to}/`))
    .sort((a, b) => b.to.length - a.to.length)[0];

  return (
    <nav aria-label={`${areaLabel} sections`} className="border-b border-st-high/70">
      <div className="-mb-px flex flex-wrap items-center gap-1 pb-1.5">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end
            className={tabClass(activeTab?.to === tab.to)}
            aria-current={activeTab?.to === tab.to ? 'page' : undefined}
          >
            {tab.label}
            {tab.selfOnly ? (
              <span
                className="rounded-full bg-st-low px-1.5 text-[8px] font-bold uppercase tracking-wider text-st-on-variant"
                title="This tab only ever shows your own record"
              >
                you
              </span>
            ) : null}
          </NavLink>
        ))}
        <span className="ml-auto hidden shrink-0 pl-2 text-[10px] text-st-on-variant lg:block">
          {description}
        </span>
      </div>
    </nav>
  );
};

export default AreaTabs;
