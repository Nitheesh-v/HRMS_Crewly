import { useLocation } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { menuItemForPath, sectionForPath } from '../../utils/breadcrumb.js';

// ═══════════════════════════════════════════════════════════════════════════
// PAGE BREADCRUMB — "People › Organization Structure", in the app header.
//
// It answers a question the sidebar cannot when it is collapsed or scrolled:
// where in the app am I right now. Both halves are derived — the page name from
// the nav the sidebar is already rendering, the section from the path — so this
// can never drift out of sync with navigation the way a hand-written list does.
//
// Hidden below `sm`: on a phone the header is five icons wide already, and the
// page's own title sits an inch below it in the content.
// ═══════════════════════════════════════════════════════════════════════════

const PageBreadcrumb = ({ menu = [] }) => {
  const { pathname } = useLocation();
  const current = menuItemForPath(menu, pathname);
  const section = sectionForPath(pathname);

  if (!current?.title) return null;

  // "/app" is the dashboard: "Home › Dashboard" says the same thing twice.
  const showSection = Boolean(section) && section !== current.title && pathname !== '/app';

  return (
    <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1.5 sm:flex">
      {showSection && (
        <>
          <span className="shrink-0 text-sm text-crewly-dim">{section}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-crewly-dim/60" aria-hidden="true" />
        </>
      )}
      <span aria-current="page" className="truncate text-sm font-semibold text-crewly-text">
        {current.title}
      </span>
    </nav>
  );
};

export default PageBreadcrumb;
