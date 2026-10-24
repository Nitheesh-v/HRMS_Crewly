import { Outlet } from 'react-router-dom';

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC LAYOUT — a pass-through.
//
// This used to draw a dark app bar ("Crewly HRMS" + green buttons) and a footer
// around the auth screens. The auth screens now own their whole viewport: a
// charcoal shell with its own logo line and its own legal line, from
// AuthLayout. Keeping the old chrome would have put a second header above every
// sign-in form and made the two surfaces look like different products.
//
// The wrapper is kept in the route tree because the auth routes are still
// logically grouped, and because a future non-auth public page needs somewhere
// to live that is not the marketing page.
// ═══════════════════════════════════════════════════════════════════════════

const PublicLayout = () => <Outlet />;

export default PublicLayout;
