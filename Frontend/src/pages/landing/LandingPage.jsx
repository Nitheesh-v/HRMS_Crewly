// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE (`/`)
//
// The marketing surface for the product, in the shape the category uses —
// announcement → header → hero with the product → capability band → tabbed
// platform → inventory → AI layer → how it works → roles → security → pricing
// → FAQ → CTA → footer — but with one rule the category usually breaks:
// nothing on this page is invented. No customers, no logos, no badges, no
// usage numbers. Every claim is pinned by Frontend/test/landingPage.test.js to
// the code that implements it.
//
// TWO PROPERTIES WORTH KEEPING WHEN EDITING THIS PAGE:
//   1. Content lives in landingData.js, not in markup, so the test suite can
//      check the page's claims (prices vs the backend catalogue, the trial
//      length vs TRIAL_DAYS, roles vs ROLE_LABELS, languages vs the language
//      list, anchors vs sections, links vs real routes).
//   2. The page is its own lazy chunk. Adding a section must not pull the app
//      shell along with it.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect } from 'react';
import LandingHeader from './LandingHeader.jsx';
import LandingFooter from './LandingFooter.jsx';
import HeroSection from './sections/HeroSection.jsx';
import CapabilityStrip from './sections/CapabilityStrip.jsx';
import PlatformSection from './sections/PlatformSection.jsx';
import ModulesSection from './sections/ModulesSection.jsx';
import AiSection from './sections/AiSection.jsx';
import WorkflowSection from './sections/WorkflowSection.jsx';
import RolesSection from './sections/RolesSection.jsx';
import SecuritySection from './sections/SecuritySection.jsx';
import PricingSection from './sections/PricingSection.jsx';
import FaqSection from './sections/FaqSection.jsx';
import CtaSection from './sections/CtaSection.jsx';

const LandingPage = () => {
  useEffect(() => {
    const previousTitle = document.title;

    document.title = 'Crewly — HR, payroll and attendance in one workspace';

    return () => {
      document.title = previousTitle;
    };
  }, []);

  return (
    <div className="landing-shell min-h-screen bg-crewly-night text-slate-200">
      {/* Keyboard users should not have to tab the whole nav to reach content. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-emerald-500 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-[#04231a] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-200"
      >
        Skip to content
      </a>

      <LandingHeader />

      <main id="main">
        <HeroSection />
        <CapabilityStrip />
        <PlatformSection />
        <ModulesSection />
        <AiSection />
        <WorkflowSection />
        <RolesSection />
        <SecuritySection />
        <PricingSection />
        <FaqSection />
        <CtaSection />
      </main>

      <LandingFooter />
    </div>
  );
};

export default LandingPage;
