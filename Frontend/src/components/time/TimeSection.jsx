import TimeSectionTabs from './TimeSectionTabs.jsx';

// Sits directly above the page it frames, inside the same content column, so
// the strip and the cards below it share one left edge. Time & Leave pages
// keep their own surface root; this wrapper adds none.
const TimeSection = ({ children }) => (
  <div className="flex flex-col gap-4">
    <TimeSectionTabs />
    {children}
  </div>
);

export default TimeSection;
