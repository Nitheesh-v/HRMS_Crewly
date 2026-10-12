// ═══════════════════════════════════════════════════════════════════════════
// HOME PAGE (public, `/`)
//
// WHAT THIS REPLACES
//   A 94-line page with a hero and a nine-card grid: no header, no footer, no
//   navigation, and a LIGHT theme sitting one click away from dark auth screens.
//   It also listed modules the product does not have ("Learning") while missing
//   most of the ones it does.
//
// WHAT IT IS NOW
//   header → main (hero · trust strip · modules · workflow · security · pricing
//   · FAQ · CTA) → footer. Dark canvas and emerald/teal accents, matching the
//   sign-in screens the visitor lands on next.
//
// TWO PROPERTIES WORTH KEEPING WHEN EDITING THIS PAGE:
//   1. Content lives in landingData.js, not in markup, so the test suite can
//      check the page's claims (prices vs the backend catalogue, the trial
//      length vs TRIAL_DAYS, anchors vs sections, links vs real routes).
//   2. Nothing here is fabricated. There are no customers, logos, testimonials
//      or usage numbers anywhere in the repository, so there are none here.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect } from 'react';
import LandingHeader from './LandingHeader.jsx';
import LandingFooter from './LandingFooter.jsx';
import HeroSection from './sections/HeroSection.jsx';
import ModulesSection from './sections/ModulesSection.jsx';
import WorkflowSection from './sections/WorkflowSection.jsx';
import SecuritySection from './sections/SecuritySection.jsx';
import PricingSection from './sections/PricingSection.jsx';
import FaqSection from './sections/FaqSection.jsx';
import CtaSection from './sections/CtaSection.jsx';

const LandingPage = () => {
  useEffect(() => {
    document.title = 'Crewly — HR, payroll and attendance in one workspace';
  }, []);

  return (
    <div className="landing-shell min-h-screen bg-[#0b1120] text-slate-200">
      {/* Keyboard users should not have to tab the whole nav to reach content. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-emerald-500 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-[#06251a] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
      >
        Skip to content
      </a>

      <LandingHeader />

      <main id="main">
        <HeroSection />
        <ModulesSection />
        <WorkflowSection />
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
