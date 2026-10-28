import { useLocation } from 'react-router-dom';

import AreaTabs from '../common/AreaTabs.jsx';
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
// The pixels live in components/common/AreaTabs.jsx, shared with Time & Leave
// so the two modules cannot drift into two tab designs.
// ═══════════════════════════════════════════════════════════════════════════

const PayrollSectionTabs = () => {
  const { pathname } = useLocation();
  const { loading, hasAnyPermission } = usePermission();

  const area = payrollAreaForPath(pathname);
  if (!area) return null;

  const tabs = visiblePayrollTabs(area, hasAnyPermission);
  if (loading || tabs.length < 2) return null;

  return <AreaTabs areaLabel={area.label} description={area.description} tabs={tabs} />;
};

export default PayrollSectionTabs;
