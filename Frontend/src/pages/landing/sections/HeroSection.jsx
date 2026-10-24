// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE — HERO
//
// The reference's fold, translated: warm paper, one editorial serif headline
// where the second clause is italic and black while the first is muted, a single
// lilac pill, a line of availability, and — the signature move — transcript
// ribbons curving across the fold with a live waveform resting on them.
//
// The reference streams a raw voice transcript beside its cleaned-up version.
// Crewly's equivalent is the mess an HR desk receives beside the record it ends
// up with, which is a truer demonstration of this product than a voice demo.
//
// Everything decorative — the ribbons, the waveform, the stickers, the cards,
// the mock — is aria-hidden. The screen reader gets the promise, the terms and
// the two actions.
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Bell, Check } from 'lucide-react';
import {
  HERO,
  HERO_NOTIFICATIONS,
  HERO_RIBBONS,
  HERO_STICKERS,
  WORKPLACE_FACTS,
} from '../landingData.js';
import LandingIcon from '../LandingIcon.jsx';
import ProductWindow from '../ProductWindow.jsx';
import { displayXl, primaryCta, secondaryCta, sectionCopy } from '../landingStyles.js';
import { tintAt } from '../landingTints.js';

// The "what it does" strip. There are no customers in this repository to fill a
// logo wall, so it carries shipped facts instead and loops. The list is rendered
// twice for the CSS marquee to wrap seamlessly, and the duplicate is aria-hidden
// so it is not read out twice.
const FactsMarquee = () => (
  <div className="landing-marquee relative overflow-hidden border-y border-crewly-ink/10 bg-white/40 py-3.5">
    <div
      className="pointer-events-none absolute inset-y-0 left-0 z-10 w-24 bg-gradient-to-r from-crewly-void via-crewly-void/80 to-transparent"
      aria-hidden="true"
    />
    <div
      className="pointer-events-none absolute inset-y-0 right-0 z-10 w-24 bg-gradient-to-l from-crewly-void via-crewly-void/80 to-transparent"
      aria-hidden="true"
    />

    <div className="landing-marquee-track flex w-max">
      {[0, 1].map((copy) => (
        <ul
          key={copy}
          aria-hidden={copy === 1 ? 'true' : undefined}
          className="flex shrink-0 items-center gap-10 pr-10"
        >
          {WORKPLACE_FACTS.map((fact, index) => (
            <li key={`${copy}-${fact.label}`} className="flex items-center gap-2 whitespace-nowrap">
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-md border ${tintAt(index).chip}`}
              >
                <LandingIcon name={fact.icon} className="h-3.5 w-3.5" />
              </span>
              <span className="text-[13px] font-medium text-crewly-ink/65">{fact.label}</span>
            </li>
          ))}
        </ul>
      ))}
    </div>
  </div>
);

const Sticker = ({ sticker, index = 0 }) => (
  <span
    aria-hidden="true"
    style={{ animationDelay: `${index * -1.7}s`, '--sticker-bg': sticker.bg }}
    className={`landing-sticker landing-wiggle absolute hidden items-center gap-1.5 rounded-full px-3.5 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-crewly-ink xl:inline-flex ${sticker.rotate} ${sticker.className}`}
  >
    <LandingIcon name={sticker.icon} className={`h-3.5 w-3.5 ${sticker.tone}`} />
    {sticker.label}
  </span>
);

// Two arcs of text, one grey and loose, one ink and tight. The paths are drawn
// wider than the viewBox so the text runs off both edges, the way the reference's
// transcript wraps around the fold.
const Ribbons = () => (
  <svg
    viewBox="0 0 1200 260"
    preserveAspectRatio="xMidYMid slice"
    className="landing-ribbon-drift absolute inset-0 h-full w-full"
    aria-hidden="true"
  >
    <defs>
      <path id="crewly-ribbon-raw" d="M -80 120 C 220 30 640 26 1280 176" fill="none" />
      <path id="crewly-ribbon-clean" d="M -80 214 C 300 118 780 132 1280 48" fill="none" />
    </defs>

    <text className="landing-ribbon-raw" fontSize="17">
      <textPath href="#crewly-ribbon-raw">{HERO_RIBBONS.raw}</textPath>
    </text>

    <text className="landing-ribbon-clean" fontSize="14" letterSpacing="0.02em">
      <textPath href="#crewly-ribbon-clean">{HERO_RIBBONS.clean}</textPath>
    </text>
  </svg>
);

// The waveform pill that rests where the ribbons cross.
const WAVEFORM = [8, 14, 20, 11, 24, 16, 9, 22, 13, 18, 10, 15];

// Bars take their colour from the same four families as the cards, so the pill
// reads as the page's palette moving rather than as a grey equaliser.
const WAVE_TONES = ['bg-crewly-forest', 'bg-crewly-clay', 'bg-crewly-lilac-deep', 'bg-crewly-amber'];

const Waveform = () => (
  <div
    aria-hidden="true"
    className="landing-glass relative z-10 inline-flex items-center gap-1 rounded-full px-5 py-3.5"
  >
    {WAVEFORM.map((height, index) => (
      <span
        key={index}
        style={{ height: `${height}px`, animationDelay: `${index * 0.08}s` }}
        className={`landing-wave-bar w-[3px] rounded-full ${WAVE_TONES[index % WAVE_TONES.length]}`}
      />
    ))}
  </div>
);

const toneClasses = {
  sage: 'border-crewly-sage-deep/30 bg-crewly-sage text-crewly-sage-deep',
  amber: 'border-crewly-amber/60 bg-crewly-amber-soft text-crewly-amber-deep',
  lilac: 'border-crewly-lilac-deep/60 bg-crewly-lilac text-crewly-forest',
  clay: 'border-crewly-clay/40 bg-crewly-clay-soft text-crewly-clay-deep',
};

// The reference lets small cards sit on top of its product shot; so does this,
// but only from `xl`, where there is gutter to do it without burying a number.
const NotificationStack = () => (
  <div aria-hidden="true" className="absolute -left-28 -top-4 z-20 hidden w-56 -rotate-3 xl:block">
    <p className="mb-2 flex items-center gap-1.5 pl-1 text-[10px] font-bold uppercase tracking-[0.18em] text-crewly-ink/45">
      <Bell className="h-3 w-3" />
      Today at Crewly
    </p>

    <div className="space-y-2">
      {HERO_NOTIFICATIONS.map((note, index) => (
        <div
          key={note.title}
          style={{ animationDelay: `${0.25 + index * 0.14}s, ${1.1 + index * 0.4}s` }}
          className="landing-glass landing-pop rounded-2xl p-3"
        >
          <div className="flex items-start gap-2">
            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${toneClasses[note.tone]}`}>
              <LandingIcon name={note.icon} className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[11px] font-semibold text-crewly-ink">{note.title}</span>
                <span className="shrink-0 text-[9px] text-crewly-ink/40">{note.time}</span>
              </span>
              <span className="mt-0.5 block truncate text-[10px] text-crewly-ink/55">{note.body}</span>
            </span>
          </div>
        </div>
      ))}
    </div>
  </div>
);

const HeroSection = () => {
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const tiltRef = useRef(null);
  // A ref, not state: this flag only guards a pointer handler, and re-rendering
  // the hero when a media query flips would be a render for nothing.
  const canTilt = useRef(false);

  // A visitor who has not asked for calm. The pointer check is per event
  // (`pointerType === 'mouse'`) rather than a media query: a finger scrolling
  // past must never drag the window, and the media query for that is unreliable
  // in embedded browsers.
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: no-preference)');

    canTilt.current = query.matches;

    const onChange = (event) => {
      canTilt.current = event.matches;
    };

    query.addEventListener('change', onChange);

    return () => query.removeEventListener('change', onChange);
  }, []);

  const onPointerMove = useCallback((event) => {
    if (!canTilt.current || !tiltRef.current || event.pointerType !== 'mouse') return;

    const box = tiltRef.current.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width - 0.5;
    const y = (event.clientY - box.top) / box.height - 0.5;

    // At most ~3.5 degrees: enough to feel alive, not enough to distort.
    setTilt({ x: Number((-y * 3.5).toFixed(2)), y: Number((x * 4.5).toFixed(2)) });
  }, []);

  const resetTilt = useCallback(() => setTilt({ x: 0, y: 0 }), []);

  return (
    <section className="relative overflow-hidden">
      <div className="landing-glow pointer-events-none absolute inset-x-0 -top-40 -z-10 h-[72rem]" aria-hidden="true" />
      <div
        className="landing-grid pointer-events-none absolute inset-x-0 top-0 -z-10 h-[42rem] [mask-image:radial-gradient(ellipse_58%_50%_at_50%_0%,black,transparent)]"
        aria-hidden="true"
      />

      {/* Stickers sit in the section's margins, never on the headline. */}
      <div className="pointer-events-none absolute inset-0 hidden xl:block" aria-hidden="true">
        {HERO_STICKERS.map((sticker, index) => (
          <Sticker key={sticker.label} sticker={sticker} index={index} />
        ))}
      </div>

      <div className="relative mx-auto max-w-7xl px-5 pb-4 pt-12 sm:px-6 sm:pt-16 lg:px-8 lg:pt-20">
        <div className="relative mx-auto max-w-4xl text-center">
          <p className="landing-rise inline-flex items-center gap-2 rounded-full border border-crewly-lilac-deep/60 bg-crewly-lilac/70 px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-crewly-forest backdrop-blur">
            <span className="landing-breathe h-1.5 w-1.5 rounded-full bg-crewly-forest" aria-hidden="true" />
            {HERO.badge}
            {/* The note is a second thought on a phone: at 390px it turned the
                pill into a three-line block above the headline. */}
            <span className="hidden h-3 w-px bg-crewly-ink/20 sm:inline-block" aria-hidden="true" />
            <span className="hidden font-medium normal-case tracking-normal text-crewly-ink/45 sm:inline">
              {HERO.badgeNote}
            </span>
          </p>

          {/* The reference's headline is one serif line where the first clause is
              greyed out and the second is black italic. Same construction here. */}
          <h1 className={`landing-rise landing-rise-1 mx-auto mt-7 max-w-5xl ${displayXl}`}>
            <span className="text-crewly-ink/35">{HERO.titleLead}</span>{' '}
            <em className="italic text-crewly-ink">{HERO.titleAccent}</em>
          </h1>

          <p className={`landing-rise landing-rise-2 mx-auto mt-6 max-w-xl ${sectionCopy}`}>{HERO.copy}</p>

          <div className="landing-rise landing-rise-2 mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link to={HERO.primaryCta.to} className={primaryCta}>
              {HERO.primaryCta.label}
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </Link>
            <a href={HERO.secondaryCta.href} className={secondaryCta}>
              {HERO.secondaryCta.label}
            </a>
          </div>

          <p className="landing-rise landing-rise-3 mt-5 text-[12px] font-medium text-crewly-ink/45">
            {HERO.availability}
          </p>

          <ul className="landing-rise landing-rise-3 mt-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
            {HERO.assurances.map((item) => (
              <li key={item} className="inline-flex items-center gap-1.5 text-xs font-medium text-crewly-ink/50">
                <Check className="h-3.5 w-3.5 text-crewly-forest" aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </div>

        {/* The ribbons + the waveform, then the product. */}
        <div className="relative mx-auto mt-6 h-[210px] max-w-6xl sm:mt-8 sm:h-[240px]">
          <Ribbons />

          <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
            <Waveform />
          </div>

          {HERO_RIBBONS.chips.map((chip, index) => (
            <span
              key={chip}
              aria-hidden="true"
              style={{ animationDelay: `${index * -2.2}s`, '--sticker-bg': index === 0 ? '#e6ccff' : '#c3ddc6' }}
              className={`landing-sticker landing-wiggle absolute hidden items-center gap-1.5 rounded-full px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-crewly-ink xl:inline-flex ${
                index === 0 ? 'left-[10%] -top-2 -rotate-3' : 'right-[8%] -bottom-2 rotate-2'
              }`}
            >
              <Check className={`h-3 w-3 ${index === 0 ? 'text-crewly-forest' : 'text-crewly-sage-deep'}`} />
              {chip}
            </span>
          ))}
        </div>

        {/* The product window, with the collage around it. */}
        <div className="landing-rise landing-rise-3 relative mx-auto mt-4 max-w-5xl">
          <NotificationStack />

          {/* The window leans a couple of degrees under the pointer — the
              reference's product shot is what the page is showing off, and
              movement is what makes it read as an object rather than a picture.
              Pointer-only, motion-preference-aware, and it returns to rest. */}
          <div
            ref={tiltRef}
            onPointerMove={onPointerMove}
            onPointerLeave={resetTilt}
            style={{ transform: `perspective(1600px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)` }}
            className="transition-transform duration-500 ease-out"
          >
            <div className="landing-drift origin-top">
              <ProductWindow />
            </div>
          </div>
        </div>
      </div>

      <FactsMarquee />
    </section>
  );
};

export default HeroSection;
