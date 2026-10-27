import { NavLink, useLocation } from 'react-router-dom';

import usePermission from '../../hooks/usePermission.js';
import { payrollAreaForPath, visiblePayrollTabs } from '../../config/payrollNav.js';

// ═══════════════════════════════════════════════════════════════════════════
// PAYROLL SECTION TABS — the Settings-style strip that replaced a fifteen-row
// sidebar section.
//
// The strip is the ONLY navigation between a section's pages, so it is
// permission-filtered exactly like the sidebar rows it replaced: a tab a person
// cannot open is not drawn, and the strip itself stays hidden until permissions
// have loaded (otherwise everyone would see one tab for a frame and the layout
// would jump).
//
// `active` is decided by the longest matching tab path, so a detail route
// (/app/payroll/analytics/variance, an employee's result) keeps its parent tab
// lit instead of leaving none.
// ═══════════════════════════════════════════════════════════════════════════

const tabClass = (isActive) =>
  `inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] transition ${
    isActive
      ? 'bg-st-primary-container font-bold text-st-on-primary-container'
      : 'font-semibold text-st-on-variant hover:bg-st-low hover:text-st-on'
  }`;

const PayrollSectionTabs = () => {
  const { pathname } = useLocation();
  const { loading, hasAnyPermission } = usePermission();

  const area = payrollAreaForPath(pathname);
  if (!area) return null;

  const tabs = visiblePayrollTabs(area, hasAnyPermission);
  if (loading || tabs.length < 2) return null;

  const activeTab = tabs
    .filter((tab) => pathname === tab.to || pathname.startsWith(`${tab.to}/`))
    .sort((a, b) => b.to.length - a.to.length)[0];

  return (
    <nav aria-label={`${area.label} sections`} className="border-b border-st-high/70">
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
          {area.description}
        </span>
      </div>
    </nav>
  );
};

export default PayrollSectionTabs;
