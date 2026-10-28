import { useLocation } from 'react-router-dom';

import AreaTabs from '../common/AreaTabs.jsx';
import usePermission from '../../hooks/usePermission.js';
import { timeAreaForPath, visibleTimeTabs } from '../../config/timeNav.js';

// ═══════════════════════════════════════════════════════════════════════════
// TIME & LEAVE SECTION TABS — the same strip as payroll, for the section that
// had nineteen sidebar rows.
//
// Filtered exactly like the rows it replaced: a tab the person cannot open is
// not drawn, and the strip stays hidden until permissions have loaded so the
// layout does not reflow when they arrive. A page inside an area that shows a
// single tab (an employee on their own attendance) gets no strip — one pill
// alone is noise, not navigation.
// ═══════════════════════════════════════════════════════════════════════════

const TimeSectionTabs = () => {
  const { pathname } = useLocation();
  const { role, loading, hasAnyPermission } = usePermission();

  const area = timeAreaForPath(pathname);
  if (!area) return null;

  const tabs = visibleTimeTabs(area, hasAnyPermission, role);
  if (loading || tabs.length < 2) return null;

  return <AreaTabs areaLabel={area.label} description={area.description} tabs={tabs} />;
};

export default TimeSectionTabs;
