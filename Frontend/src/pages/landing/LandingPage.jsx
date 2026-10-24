// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE (`/`)
//
// Seven bands, one argument:
//   hero (the promise + a floating window onto the product)
//   → the product moment (attendance, leave and payroll reading one record)
//   → capabilities (six areas, the counted numbers, the full module inventory)
//   → the AI layer (violet, guarded, multilingual)
//   → trust (security and roles in one place)
//   → pricing (four real plans, and the questions the price raises)
//   → the closing CTA and the footer.
//
// Two properties worth keeping when editing this page:
//
//   1. Content lives in landingData.js, not in markup, so the test suite can
//      CHECK the page's claims — prices against the backend catalogue, the trial
//      length against TRIAL_DAYS, roles against ROLE_LABELS, languages against
//      the language list, anchors against sections, links against real routes.
//      Nothing on this page is invented: no customers, logos, testimonials,
//      usage counts or certification badges, because none of that exists here.
//
//   2. The page is its own lazy chunk, and its look is one light source: a
//      near-black canvas, an emerald glow, glass panels, violet for the assistant
//      only. The CSS lives in `style.css` §12 (`.landing-*`) and the shared class
//      strings in landingStyles.js — sections do not invent their own buttons.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect } from 'react';
import LandingHeader from './LandingHeader.jsx';
import LandingFooter from './LandingFooter.jsx';
import StickyCta from './StickyCta.jsx';
import HeroSection from './sections/HeroSection.jsx';
import ProductMomentSection from './sections/ProductMomentSection.jsx';
import CapabilityStrip from './sections/CapabilityStrip.jsx';
import AiSection from './sections/AiSection.jsx';
import SecuritySection from './sections/SecuritySection.jsx';
import PricingSection from './sections/PricingSection.jsx';
import CtaSection from './sections/CtaSection.jsx';

const LandingPage = () => {
  useEffect(() => {
    const previousTitle = document.title;

    document.title = 'Crewly — HR, payroll and attendance that agree with each other';

    return () => {
      document.title = previousTitle;
    };
  }, []);

  return (
    <div className="landing-shell relative min-h-screen bg-crewly-void text-crewly-ink/85">
      {/* Keyboard users should not have to tab the whole nav to reach content. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-full focus:bg-crewly-lilac focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-crewly-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-crewly-forest"
      >
        Skip to content
      </a>

      <LandingHeader />

      <main id="main">
        <HeroSection />
        <ProductMomentSection />
        <CapabilityStrip />
        <AiSection />
        <SecuritySection />
        <PricingSection />
        <CtaSection />
      </main>

      <LandingFooter />
      <StickyCta />
    </div>
  );
};

export default LandingPage;
