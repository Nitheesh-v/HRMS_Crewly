import PayrollSectionTabs from './PayrollSectionTabs.jsx';

// The tab strip sits directly above the page it frames, inside the same
// content column — so the strip and the cards below it share one left edge.
// Payroll pages keep their own `st-surface` root; this wrapper adds none,
// otherwise the surface would be painted twice and the page would grow a
// second min-height.
const PayrollSection = ({ children }) => (
  <div className="flex flex-col gap-4">
    <PayrollSectionTabs />
    {children}
  </div>
);

export default PayrollSection;
