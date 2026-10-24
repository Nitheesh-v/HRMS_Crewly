// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE — STICKY ACTION BAR
//
// The hero's CTA is far away by the time a visitor has read the pricing. This is
// the same action, repeated, once the hero has scrolled out of view — glass, one
// line, no new claim.
//
//   · appears only after the hero, and hides again at the very top
//   · `inert` while hidden, so a hidden control cannot take focus
//   · listens passively: one boolean of state per scroll, not per pixel
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, X } from 'lucide-react';
import { BRAND, STICKY_CTA } from './landingData.js';
import { focusRing, primaryCta } from './landingStyles.js';

const StickyCta = () => {
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let footer = null;

    // Past the hero, but not over the footer: the footer has its own CTA, and
    // a floating bar parked on top of it covers links the visitor came for.
    const onScroll = () => {
      footer = footer || document.querySelector('footer');

      const footerTop = footer ? footer.getBoundingClientRect().top : Number.POSITIVE_INFINITY;

      setVisible(window.scrollY > 720 && footerTop > window.innerHeight - 40);
    };

    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  const shown = visible && !dismissed;

  return (
    <div
      inert={!shown}
      className={`fixed inset-x-0 bottom-0 z-40 px-3 pb-3 transition-[opacity,transform] duration-300 sm:px-6 sm:pb-5 ${
        shown ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-6 opacity-0'
      }`}
    >
      <div className="mx-auto flex max-w-3xl items-center gap-3 rounded-full border border-crewly-ink/12 bg-crewly-void/90 py-2 pl-4 pr-2 shadow-[0_24px_60px_-24px_rgba(0,0,0,0.95)] backdrop-blur-xl sm:pl-5">
        <p className="min-w-0 flex-1 truncate text-[12px] font-medium text-crewly-ink/60 sm:text-[13px]">
          <span className="font-semibold text-crewly-ink">{BRAND.name}</span>
          <span className="mx-1.5 text-crewly-ink/25">·</span>
          <span className="hidden sm:inline">{STICKY_CTA.note}</span>
          <span className="sm:hidden">{BRAND.trialDays}-day trial</span>
        </p>

        <Link to={STICKY_CTA.href} className={`${primaryCta} shrink-0 text-[12px]`}>
          {STICKY_CTA.label}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>

        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss the sign-up bar"
          className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-crewly-ink/50 transition-colors hover:bg-crewly-ink/[0.06] hover:text-crewly-ink/85 ${focusRing}`}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};

export default StickyCta;
