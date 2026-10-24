// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE — pins for the marketing surface (`/`)
//
// A landing page is marketing copy, and marketing copy rots silently: a price
// changes in the backend and the page keeps advertising the old one; a role or a
// language is renamed and the page describes a product that no longer exists; a
// section is renamed and the header nav points at nothing; a footer link is
// added for a route that does not exist. None of that fails a build by itself.
//
// So the checks here are mostly CHECKS AGAINST THE SOURCE OF TRUTH, not against
// strings typed twice:
//   · every price on the page  vs  Backend/src/utils/platformPlans.js
//   · the trial length         vs  TRIAL_DAYS in Backend/src/utils/constants.js
//   · "2 months free"          vs  the arithmetic of the plan data itself
//   · the five roles           vs  ROLE_LABELS in permissionRegistry.js
//   · the AI language counts   vs  chatLanguages.js
//   · the module inventory     vs  the sidebar's own module list
//   · every nav anchor         vs  a section id that is actually rendered
//   · every link               vs  a route that exists in AppRoutes.jsx
//
// The rest pin the things a marketing page must never do: invent social proof,
// claim certifications nobody audited, or forget that a keyboard exists — plus
// the page's own identity, which has been re-lit twice and must not drift back
// to the light SaaS palette the first draft used.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import landing, {
  AI_LAYER,
  CAPABILITIES,
  FAQS,
  FOOTER_COLUMNS,
  HERO,
  MODULE_GROUPS,
  NAV_LINKS,
  PLANS,
  PRODUCT_MOMENT,
  ROLE_CARDS,
  SECTION_IDS,
  STICKY_CTA,
} from '../src/pages/landing/landingData.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const LANDING_FILES = [
  'src/pages/landing/LandingPage.jsx',
  'src/pages/landing/LandingHeader.jsx',
  'src/pages/landing/LandingFooter.jsx',
  'src/pages/landing/LandingIcon.jsx',
  'src/pages/landing/ProductWindow.jsx',
  'src/pages/landing/StickyCta.jsx',
  'src/pages/landing/sections/HeroSection.jsx',
  'src/pages/landing/sections/ProductMomentSection.jsx',
  'src/pages/landing/sections/CapabilityStrip.jsx',
  'src/pages/landing/sections/AiSection.jsx',
  'src/pages/landing/sections/SecuritySection.jsx',
  'src/pages/landing/sections/PricingSection.jsx',
  'src/pages/landing/sections/CtaSection.jsx',
];

const SECTION_FILES = LANDING_FILES.filter((file) => file.includes('sections/'));

// The pass-#2 deep-dive (six tabbed platform previews, a workflow band, a
// separate roles band, its own FAQ band) was replaced by seven punchier bands.
// These files must stay deleted — resurrecting one brings back the classes the
// cinematic layer no longer defines.
const RETIRED_FILES = [
  'src/pages/landing/DashboardPreview.jsx',
  'src/pages/landing/PlatformPreview.jsx',
  'src/pages/landing/landingTabs.js',
  'src/pages/landing/sections/PlatformSection.jsx',
  'src/pages/landing/sections/WorkflowSection.jsx',
  'src/pages/landing/sections/RolesSection.jsx',
  'src/pages/landing/sections/FaqSection.jsx',
  'src/pages/landing/sections/ModulesSection.jsx',
];

const BACKEND_PLANS = path.join(root, '..', 'Backend', 'src', 'utils', 'platformPlans.js');
const BACKEND_CONSTANTS = path.join(root, '..', 'Backend', 'src', 'utils', 'constants.js');
const BACKEND_PERMISSIONS = path.join(root, '..', 'Backend', 'src', 'utils', 'permissionRegistry.js');

// ── the backend catalogue, parsed ──────────────────────────────────────────
const backendPlans = () => {
  const source = fs.readFileSync(BACKEND_PLANS, 'utf8');
  const plans = {};

  const block = /^ {2}([A-Z_]+): \{([\s\S]*?)^ {2}\},?$/gm;

  for (const match of source.matchAll(block)) {
    const [, planCode, body] = match;
    const prices = body.match(/prices:\s*\{([^}]*)\}/);

    if (!prices) continue;

    const monthly = prices[1].match(/monthly:\s*([\d.]+)/);
    const yearly = prices[1].match(/yearly:\s*([\d.]+)/);

    plans[planCode] = {
      monthly: monthly ? Number(monthly[1]) : null,
      yearly: yearly ? Number(yearly[1]) : null,
    };
  }

  return plans;
};

describe('Home page — structure', () => {
  test('the page is header + main + footer, with a skip link', () => {
    const source = code('src/pages/landing/LandingPage.jsx');

    assert.ok(source.includes('<LandingHeader />'), 'header');
    assert.ok(source.includes('<main id="main">'), 'a main landmark the skip link can target');
    assert.ok(source.includes('<LandingFooter />'), 'footer');
    assert.ok(source.includes('Skip to content'), 'keyboard users get past the nav');
  });

  test('the document title says what the product is', () => {
    assert.match(code('src/pages/landing/LandingPage.jsx'), /document\.title\s*=\s*'Crewly/);
  });

  test('the page stays lazy-loaded, so the app bundle does not absorb it', () => {
    const routes = code('src/routes/AppRoutes.jsx');

    assert.match(
      routes,
      /lazy\(\(\) => import\("\.\.\/pages\/landing\/LandingPage\.jsx"\)\)/,
      'the landing page must remain a lazy chunk',
    );
    assert.ok(routes.includes('element={<LandingPage />}'));
  });

  test('the landing route is not nested inside PublicLayout', () => {
    // PublicLayout supplies its own header, main and footer for the auth
    // screens. Nesting the marketing page inside it rendered TWO headers and
    // TWO footers on `/`.
    const routes = code('src/routes/AppRoutes.jsx');

    const landingIndex = routes.indexOf('path="/"');
    const layoutIndex = routes.indexOf('element={<PublicLayout />}');

    assert.ok(landingIndex > -1, 'the `/` route exists');
    assert.ok(layoutIndex > -1, 'the PublicLayout wrapper exists');
    assert.ok(
      landingIndex < layoutIndex,
      'path="/" must be declared BEFORE the PublicLayout wrapper, i.e. outside it',
    );
  });

  test('every section the data advertises is actually rendered', () => {
    for (const key of Object.keys(SECTION_IDS)) {
      const id = SECTION_IDS[key];
      const owner = SECTION_FILES.find((file) => code(file).includes(`id={SECTION_IDS.${key}}`));

      assert.ok(owner, `no section renders id={SECTION_IDS.${key}} (anchor #${id})`);
    }
  });

  test('the page is seven bands, in the order the argument needs', () => {
    const page = code('src/pages/landing/LandingPage.jsx');
    const order = [
      '<HeroSection />',
      '<ProductMomentSection />',
      '<CapabilityStrip />',
      '<AiSection />',
      '<SecuritySection />',
      '<PricingSection />',
      '<CtaSection />',
    ];

    let cursor = page.indexOf('<main id="main">');

    assert.ok(cursor > -1);

    for (const band of order) {
      const at = page.indexOf(band, cursor);

      assert.ok(at > cursor, `${band} is missing from the composition, or out of order`);
      cursor = at;
    }

    assert.equal(SECTION_FILES.length, 7, `expected seven section files, found ${SECTION_FILES.length}`);

    for (const retired of RETIRED_FILES) {
      assert.equal(fs.existsSync(path.join(root, retired)), false, `${retired} was retired in the trim — delete it`);
    }
  });

  test('the page wears Crewly’s own surface, not a template’s', () => {
    const page = code('src/pages/landing/LandingPage.jsx');
    const shell = read('src/style.css');

    assert.ok(page.includes('landing-shell'), 'the shell class drives the page-scoped CSS');
    assert.ok(page.includes('bg-crewly-void'), 'the canvas is the near-black brand surface');

    // One brand, two accents — emerald for action, violet reserved for AI and
    // the logo. A third primary colour would mean the page had drifted into
    // someone else's identity (it did once: the first draft was a light,
    // violet-and-white Keka imitation, which is the rejected answer).
    for (const file of LANDING_FILES) {
      const source = code(file);

      for (const foreign of ['bg-[#0b1120] text-crewly-ink', 'from-violet-700 to-[#4c1d95]', 'text-crewly-ink']) {
        assert.equal(source.includes(foreign), false, `${file} still carries the retired light theme (${foreign})`);
      }
    }

    // The cinematic layer's own vocabulary. These are the classes the CSS
    // defines; the retired pass-#2 classes must not come back, because nothing
    // styles them any more.
    assert.match(shell, /\.landing-shell\s*\{[\s\S]*?background-color:\s*var\(--color-crewly-void\)/, 'the shell is the void canvas in CSS too');
    assert.match(shell, /--color-crewly-void:\s*#05060b/, 'the void token is declared once');
    assert.match(shell, /--color-crewly-mint:\s*#34d399/, 'the emerald accent comes from the token file');
    assert.match(shell, /--color-crewly-violet:\s*#8b5cf6/, 'violet is a token, not an ad-hoc hex');

    for (const cls of ['landing-glow', 'landing-glass', 'landing-window', 'landing-mark']) {
      assert.match(shell, new RegExp(`\\.${cls}\\s*\\{`), `.${cls} is defined in the landing layer`);
    }

    const everywhere = [...LANDING_FILES, 'src/pages/landing/landingData.js']
      .map((file) => code(file))
      .join('\n');

    for (const retired of ['landing-aurora', 'landing-card', 'landing-preview', 'landing-hairline']) {
      assert.equal(shell.includes(`.${retired}`), false, `.${retired} is dead CSS — remove the last reference instead`);
      assert.equal(everywhere.includes(retired), false, `${retired} is referenced by a component the CSS no longer styles`);
    }
  });

  test('the hero is one light source and one floating product window', () => {
    const hero = code('src/pages/landing/sections/HeroSection.jsx');

    assert.ok(hero.includes('landing-glow'), 'the emerald glow sits behind the hero');
    assert.ok(hero.includes('landing-grid'), 'the graph paper is part of the hero field');
    assert.ok(hero.includes('<ProductWindow'), 'the product is shown as a window, not a screenshot');
    assert.ok(hero.includes('landing-drift'), 'the window drifts on a perspective — the page’s signature move');

    // The mock is decorative: a screen reader must never be read a fake table.
    assert.ok(code('src/pages/landing/ProductWindow.jsx').includes('aria-hidden="true"'));
    assert.ok(hero.includes('landing-breathe'), 'the live dot breathes');

    // The marquee duplicates its list for a seamless loop; the copy is silent.
    assert.match(hero, /aria-hidden=\{copy === 1 \? 'true' : undefined\}/, 'the duplicate marquee row is hidden from AT');
  });

  test('the primary action is emerald everywhere, from one shared class', () => {
    const styles = code('src/pages/landing/landingStyles.js');

    assert.match(styles, /export const primaryCta =[\s\S]*?bg-emerald-400/, 'primary = emerald');
    assert.match(styles, /export const primaryCta =[\s\S]*?focus-visible:outline/, 'and it keeps its ring');

    // The sections import the shared class instead of retyping a button.
    for (const file of [
      'src/pages/landing/LandingHeader.jsx',
      'src/pages/landing/LandingFooter.jsx',
      'src/pages/landing/StickyCta.jsx',
      'src/pages/landing/sections/HeroSection.jsx',
      'src/pages/landing/sections/PricingSection.jsx',
      'src/pages/landing/sections/CtaSection.jsx',
    ]) {
      assert.ok(code(file).includes('primaryCta'), `${file} must use the shared primary CTA, not its own gradient`);
    }

    assert.ok(code('src/pages/landing/LandingHeader.jsx').includes('sticky top-0'), 'the header stays reachable while scrolling');
  });

  test('the sign-up bar follows the reader and cannot take focus while hidden', () => {
    const bar = code('src/pages/landing/StickyCta.jsx');

    assert.ok(bar.includes('STICKY_CTA'), 'the bar’s copy comes from the data');
    assert.ok(bar.includes('inert={!shown}'), 'a hidden control must not be tabbable');
    assert.ok(bar.includes('window.addEventListener'), 'it appears on scroll');
    assert.ok(code('src/pages/landing/LandingPage.jsx').includes('<StickyCta />'));

    // And it is the same action as the hero, not a second, louder one.
    assert.equal(STICKY_CTA.href, HERO.primaryCta.to);
  });

  test('no control animates `all` (it freezes the focus ring)', () => {
    // Tailwind's `transition-all`/`transition` animate outline-width and
    // outline-offset. The app's global reduced-motion rule collapses durations
    // to 0.01ms, and in Chromium that left the ring at outline-width: 0px —
    // measured, not theorised. Every control lists its properties instead.
    for (const file of LANDING_FILES) {
      assert.equal(
        /(?<![-\w])(transition-all|transition)(?![- \w[\]])/.test(code(file)),
        false,
        `${file} animates every property; list color/background/border/shadow/transform instead`,
      );
    }
  });
});

describe('Home page — the claims match the product', () => {
  test('every price equals the platform catalogue', () => {
    const catalogue = backendPlans();

    assert.ok(Object.keys(catalogue).length >= 4, 'the backend catalogue parsed');

    for (const plan of PLANS) {
      const backend = catalogue[plan.code];

      assert.ok(backend, `plan ${plan.code} is not in the platform catalogue`);
      assert.equal(
        plan.monthly,
        backend.monthly,
        `${plan.name} monthly is ${plan.monthly} on the page and ${backend.monthly} in the catalogue`,
      );
      assert.equal(
        plan.yearly,
        backend.yearly,
        `${plan.name} yearly is ${plan.yearly} on the page and ${backend.yearly} in the catalogue`,
      );
    }
  });

  test('"2 months free" is arithmetic, not a slogan', () => {
    const paid = PLANS.filter((plan) => plan.monthly > 0);

    assert.ok(paid.length >= 3, 'the paid tiers are present');

    for (const plan of paid) {
      assert.equal(
        plan.monthly * 12 - plan.yearly,
        plan.monthly * 2,
        `${plan.name}: yearly is not exactly ten months`,
      );
    }

    // The badge is rendered from that arithmetic, and only on the yearly cycle.
    const pricing = code('src/pages/landing/sections/PricingSection.jsx');

    assert.match(pricing, /const monthsFree = \(plan\) =>/, 'the saving is computed');
    assert.match(pricing, /plan\.monthly \* 12 - plan\.yearly/, 'from the plan data itself');
  });

  test('the trial length matches TRIAL_DAYS', () => {
    const constants = fs.readFileSync(BACKEND_CONSTANTS, 'utf8');
    const match = constants.match(/TRIAL_DAYS\s*=\s*(\d+)/);

    assert.ok(match, 'TRIAL_DAYS is declared');
    assert.equal(landing.BRAND.trialDays, Number(match[1]), 'the page and the backend disagree on the trial length');
    assert.match(landing.PRICING_NOTE, new RegExp(`${landing.BRAND.trialDays}-day`));

    // The number is rendered from BRAND, never typed into markup: a changed
    // trial length must not leave a stale "14" behind in a button.
    for (const file of LANDING_FILES) {
      assert.equal(
        /[\s>(]14[\s-]*day/i.test(code(file)),
        false,
        `${file} hard-codes a 14-day claim instead of reading BRAND.trialDays`,
      );
    }
  });

  test('"no credit card" is true of the signup form', () => {
    const register = code('src/pages/register/RegisterCompanyPage.jsx');

    for (const field of ['cardNumber', 'cvc', 'expiry', 'razorpay', 'paymentMethod']) {
      assert.equal(
        register.includes(field),
        false,
        `the register page mentions ${field}, so "no credit card" needs re-checking`,
      );
    }
  });

  test('the role cards are the roles the product ships', () => {
    const source = fs.readFileSync(BACKEND_PERMISSIONS, 'utf8');
    const block = source.match(/ROLE_LABELS\s*=\s*\{([\s\S]*?)\n\};/);

    assert.ok(block, 'ROLE_LABELS parsed');

    const labels = new Map(
      [...block[1].matchAll(/([A-Z_]+):\s*"([^"]+)"/g)].map((match) => [match[1], match[2]]),
    );

    assert.ok(labels.size >= 5, 'all five system roles are declared');

    for (const role of ROLE_CARDS) {
      assert.equal(
        labels.get(role.code),
        role.name,
        `${role.code} is "${labels.get(role.code)}" in the backend and "${role.name}" on the page`,
      );
    }

    assert.equal(
      ROLE_CARDS.length,
      labels.size,
      'a role exists in the backend but is missing from the page (or the reverse)',
    );

    // Roles live inside the trust band now — that is the whole pass-#3 decision:
    // "who can see this" is a security answer, not a persona page.
    assert.ok(
      code('src/pages/landing/sections/SecuritySection.jsx').includes('ROLE_CARDS'),
      'the roles must be rendered by the trust section',
    );
  });

  test('the AI language counts match the language list', () => {
    const source = read('src/components/AIAssistant/chatLanguages.js');

    const countOf = (name) => {
      // Anchored on `const NAME`, not on `NAME`: PLATFORM_CHAT_LANGUAGES ends
      // with CHAT_LANGUAGES, and an unanchored match counted the 14 platform
      // languages as the 5 defaults.
      const block = source.match(
        new RegExp(`(?:^|\\n)(?:export\\s+)?const\\s+${name}\\s*=\\s*Object\\.freeze\\(\\[([\\s\\S]*?)\\n\\]\\);`),
      );

      assert.ok(block, `${name} parsed`);

      return (block[1].match(/value:\s*'/g) || []).length;
    };

    assert.equal(
      AI_LAYER.languageCount,
      countOf('PLATFORM_CHAT_LANGUAGES'),
      'the page and the platform language list disagree',
    );
    assert.equal(
      AI_LAYER.defaultLanguageCount,
      countOf('CHAT_LANGUAGES'),
      'the page and the default tenant language list disagree',
    );
  });

  test('the module inventory matches the app, not a wish list', () => {
    const modules = MODULE_GROUPS.flatMap((group) => group.items.map((item) => item.name));
    const sidebar = read('src/layout/SidebarNav.jsx');

    // "Learning" existed on an older page and is not a module in this product.
    assert.equal(sidebar.includes('Learning'), false, 'the sidebar has no Learning module');
    assert.equal(modules.includes('Learning'), false, 'so the home page must not claim one');

    for (const expected of ['Attendance', 'Payroll', 'Recruitment', 'Chat Hub', 'Meetings']) {
      assert.ok(modules.includes(expected), `${expected} is missing from the module list`);
    }

    assert.equal(modules.length, 20, 'the module inventory changed — update the copy and this pin');
    assert.equal(new Set(modules).size, modules.length, 'a module is listed twice');

    // The counted headline number is derived, never typed: 20 cannot drift.
    const strip = code('src/pages/landing/sections/CapabilityStrip.jsx');

    assert.ok(strip.includes('MODULE_GROUPS.reduce'), 'the module count is counted from the data');
    assert.equal(CAPABILITIES.length, 6, 'the six capability areas are the page’s shape');
    assert.ok(
      CAPABILITIES.every((capability) => capability.points.length >= 3),
      'each capability needs at least three shipped bullets',
    );
  });

  test('no fabricated social proof, and no placeholder copy', () => {
    // Comments stripped: several files explain WHY there is no social proof
    // here, and a ban must not be tripped by the comment documenting the ban.
    const data = [...LANDING_FILES, 'src/pages/landing/landingData.js']
      .map((file) => code(file))
      .join('\n');

    for (const phrase of ['testimonial', 'Lorem ipsum', 'trusted by', 'Trusted by', 'Chosen by']) {
      assert.equal(data.includes(phrase), false, `found "${phrase}" — nothing in this repo backs it up`);
    }

    // A count followed by users/customers/companies is the classic invention.
    // A DIGIT must be present — a bare comma would match a JSX list of icon
    // names (`UserPlus,\n  Users,`) and report a number that is not there.
    assert.equal(
      /\b\d[\d,]*\s*\+?\s*(users|customers|companies|teams)\b/i.test(data),
      false,
      'a usage number appeared without a source',
    );
  });
});

describe('Home page — navigation integrity', () => {
  test('every nav, hero and footer anchor points at a section that exists', () => {
    const ids = Object.values(SECTION_IDS);
    const anchors = [
      ...NAV_LINKS.map((link) => link.href),
      HERO.secondaryCta.href,
      ...FOOTER_COLUMNS.flatMap((column) => column.links.filter((link) => link.href).map((link) => link.href)),
    ];

    assert.ok(anchors.length >= 15, `only ${anchors.length} anchors were collected`);

    for (const href of anchors) {
      assert.match(href, /^#/, `unexpected external href ${href}`);
      assert.ok(ids.includes(href.slice(1)), `${href} has no matching section id`);
    }

    assert.equal(new Set(ids).size, ids.length, 'section ids are unique');

    // Five links in the pill, no mega-menu: the page is long and loud, the nav
    // should not compete with it.
    assert.equal(NAV_LINKS.length, 5, 'the header nav is five links');
  });

  test('every link resolves to a route that exists', () => {
    const routes = code('src/routes/AppRoutes.jsx');
    const declared = new Set([...routes.matchAll(/path="([^"]+)"/g)].map((match) => match[1]));

    const links = [
      HERO.primaryCta.to,
      ...FOOTER_COLUMNS.flatMap((column) => column.links.filter((link) => link.to).map((link) => link.to)),
      ...PLANS.map((plan) => plan.cta.to),
      landing.FOOTER_SUPPORT.link.to,
      STICKY_CTA.href,
    ];

    assert.ok(links.length >= 6, 'the links were collected');

    for (const to of links) {
      assert.ok(declared.has(to), `${to} is linked but no route declares it`);
    }

    // The footer must not repeat AuthLayout's dead legal text as fake links.
    const footer = code('src/pages/landing/LandingFooter.jsx');

    assert.equal(/to="\/?(privacy|terms)"/.test(footer), false, 'those pages do not exist');
    assert.ok(footer.includes('LEGAL_NOTE'), 'the footer must say the legal pages are unpublished rather than link them');
    assert.match(landing.LEGAL_NOTE.text, /not published/i, 'the legal note must be honest about the pages not existing');
  });

  test('in-page links inside components are declared in the data, not typed twice', () => {
    for (const file of LANDING_FILES) {
      for (const match of code(file).matchAll(/href="#([\w-]+)"/g)) {
        // `#main` is the skip link's target — the landmark, not a marketing section.
        const target = match[1];
        const allowed = target === 'main' || Object.values(SECTION_IDS).includes(target);

        assert.ok(allowed, `${file}: href="#${target}" is neither a SECTION_IDS value nor the #main landmark`);
      }
    }
  });
});

describe('Home page — accessibility', () => {
  test('the mobile menu is a real disclosure', () => {
    const header = code('src/pages/landing/LandingHeader.jsx');

    assert.ok(header.includes('aria-expanded={menuOpen}'), 'the trigger reports its state');
    assert.ok(header.includes('aria-controls="landing-mobile-menu"'), 'and names its panel');
    assert.ok(header.includes('id="landing-mobile-menu"'), 'the panel it names exists');
    assert.ok(header.includes("aria-label={menuOpen ? 'Close menu' : 'Open menu'}"), 'and has an accessible name');
    assert.ok(header.includes("event.key === 'Escape'"), 'Escape closes it');
  });

  test('the pricing toggle and decorative visuals announce themselves correctly', () => {
    const pricing = code('src/pages/landing/sections/PricingSection.jsx');

    assert.ok(pricing.includes('aria-pressed={cycle === option.id}'), 'the billing toggle is a toggle');
    assert.ok(pricing.includes('role="group"'), 'and its buttons are grouped');
    assert.ok(code('src/pages/landing/ProductWindow.jsx').includes('aria-hidden="true"'), 'the mock window is not read aloud');
  });

  test('the FAQ is keyboard-operable and announced', () => {
    const pricing = code('src/pages/landing/sections/PricingSection.jsx');

    assert.ok(pricing.includes('aria-expanded={openNow}'), 'the trigger reports its state');
    assert.ok(pricing.includes('aria-controls={`${id}-panel`}'), 'and names its panel');
    assert.ok(pricing.includes('aria-labelledby={`${id}-button`}'), 'and the panel names its trigger');
    assert.ok(pricing.includes('<button'), 'the trigger is a button, not a div');
  });

  test('the motion preference is respected', () => {
    const css = read('src/style.css');

    assert.match(css, /prefers-reduced-motion: reduce/, 'the app already honours it');
    assert.match(css, /html:has\(\.landing-shell\)\s*\{[\s\S]*?scroll-behavior/, 'smooth scroll is opt-in per shell');
    assert.match(
      css,
      /prefers-reduced-motion: no-preference[\s\S]*?landing-marquee/,
      'the marquee only animates when motion is welcome',
    );

    // The entrance/floating animations must live inside that media query, or a
    // visitor who asked for calm gets a drifting dashboard anyway.
    const cinematic = css.slice(css.indexOf('.landing-shell'));

    assert.equal(
      /\.landing-rise\s*\{/.test(cinematic.slice(0, cinematic.indexOf('prefers-reduced-motion: no-preference'))),
      false,
      'the entrance animation is defined outside the reduced-motion guard',
    );
  });

  test('every interactive element has a visible focus style', () => {
    // Reads the OPENING TAG of each control. A naive `[\s\S]*?>` stops at the
    // first `>` it meets, which for `onClick={() => setOpen(o => !o)}` lands in
    // the middle of the props and reports a focus ring that is actually there —
    // so the scan tracks braces and quotes and stops at the real tag end.
    const openingTags = (source) => {
      const tags = [];

      for (const match of source.matchAll(/<(?:Link|a|button)\b/g)) {
        let depth = 0;
        let quote = null;
        let index = match.index + match[0].length;

        for (; index < source.length; index += 1) {
          const char = source[index];

          if (quote) {
            if (char === quote) quote = null;
            continue;
          }

          if (char === '"' || char === "'" || char === '`') quote = char;
          else if (char === '{') depth += 1;
          else if (char === '}') depth -= 1;
          else if (char === '>' && depth === 0) break;
        }

        tags.push(source.slice(match.index, index + 1));
      }

      return tags;
    };

    // A shared class string counts: `className={shared}` is resolved from the
    // file's own `const shared = '…'` OR from the shared design primitives the
    // file imports, and `${shared}` — or a ternary between two of them — inside
    // a template literal is resolved the same way. So the pin stays strict
    // instead of exempting every expression, which is how a real gap would hide.
    const sharedClassNames = (source) => {
      const map = new Map();

      for (const match of source.matchAll(/const\s+(\w+)\s*=\s*\n?\s*'([^']*)'/g)) {
        map.set(match[1], match[2]);
      }

      return map;
    };

    const designPrimitives = sharedClassNames(read('src/pages/landing/landingStyles.js'));

    const importedNames = (source) => {
      const names = new Set();

      for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\.?\/[^']*landingStyles\.js'/g)) {
        match[1].split(',').forEach((name) => names.add(name.trim()));
      }

      return names;
    };

    let scanned = 0;
    const perFile = new Map();

    for (const file of LANDING_FILES) {
      const source = code(file);
      const tags = openingTags(source);
      const shared = sharedClassNames(source);

      for (const name of importedNames(source)) {
        assert.ok(designPrimitives.has(name), `${file} imports ${name} from landingStyles.js but it is not a class string`);
        shared.set(name, designPrimitives.get(name));
      }

      scanned += tags.length;
      perFile.set(file, tags.length);

      for (const tag of tags) {
        // Only the class list carries the ring; `href={`#${SECTION_IDS.x}`}`
        // interpolates data, not classes, and would be a false positive here.
        const classAt = tag.indexOf('className=');

        assert.ok(classAt > -1, `${file}: an interactive element has no className → ${tag.slice(0, 80)}…`);

        let resolved = tag.slice(classAt);
        const viaVariable = resolved.match(/className=\{(\w+)\}/);

        if (viaVariable) {
          const literal = shared.get(viaVariable[1]);

          assert.ok(
            literal,
            `${file}: className={${viaVariable[1]}} could not be resolved to a string literal`,
          );

          resolved = `${resolved} ${literal}`;
        }

        for (const interpolation of resolved.matchAll(/\$\{([^}]*)\}/g)) {
          // The expression may be a bare name, or a ternary/concatenation that
          // only names shared primitives — those resolve to real class strings.
          const found = [...interpolation[1].matchAll(/\b([A-Za-z_$][\w$]*)\b/g)]
            .map((match) => shared.get(match[1]))
            .filter(Boolean);

          if (found.length > 0) {
            resolved = resolved.replace(interpolation[0], found.join(' '));
            continue;
          }

          // A conditional built purely from string literals is inline markup,
          // not a shared primitive: it cannot hide the ring, and the ring is
          // asserted on the resolved tag below.
          const literals = [...interpolation[1].matchAll(/'([^']*)'/g)].map((match) => match[1]);

          assert.ok(
            literals.length > 0,
            `${file}: \${${interpolation[1]}} could not be resolved to a class string`,
          );

          resolved = resolved.replace(interpolation[0], literals.join(' '));
        }

        assert.match(
          resolved,
          /focus-visible:outline/,
          `${file}: an interactive element has no focus-visible style → ${tag.slice(0, 80)}…`,
        );
      }
    }

    // Guards against the scan silently matching nothing: the controls live in
    // these files, so a zero here means the scanner broke, not the page.
    assert.ok(scanned >= 25, `only ${scanned} controls were scanned — is the scanner broken?`);
    assert.ok(perFile.get('src/pages/landing/LandingHeader.jsx') >= 5, 'the header controls were found');
    assert.ok(perFile.get('src/pages/landing/LandingFooter.jsx') >= 3, 'the footer controls were found');
    // One `<Link` renders four plan CTAs, plus the billing toggle's `<button`
    // and the FAQ's `<button` — three tags in the source.
    assert.ok(perFile.get('src/pages/landing/sections/PricingSection.jsx') >= 3, 'the pricing controls were found');
  });
});

describe('Home page — content sanity', () => {
  test('the FAQ answers the questions a buyer actually asks', () => {
    const questions = FAQS.map((faq) => faq.q.toLowerCase()).join(' | ');

    for (const topic of ['trial', 'trial ends', 'another company', 'roles', 'install', 'languages', 'attendance data']) {
      assert.ok(questions.includes(topic), `no FAQ answers "${topic}"`);
    }

    for (const faq of FAQS) {
      assert.ok(faq.a.trim().length > 40, `answer too thin: ${faq.q}`);
    }
  });

  test('the security section promises only what the codebase can back', () => {
    const points = landing.SECURITY_POINTS.map((point) => `${point.title} ${point.copy}`).join(' ').toLowerCase();
    const section = code('src/pages/landing/sections/SecuritySection.jsx').toLowerCase();
    const data = code('src/pages/landing/landingData.js').toLowerCase();

    for (const fabricable of ['ISO 27001', 'SOC 2', 'HIPAA', 'GDPR certified', 'bank-grade', 'military-grade']) {
      for (const [label, haystack] of [['data', points], ['section', section], ['data file', data]]) {
        assert.equal(
          haystack.includes(fabricable.toLowerCase()),
          false,
          `"${fabricable}" is a claim with no evidence in this repo (found in ${label})`,
        );
      }
    }

    assert.ok(points.includes('tenant'), 'the tenancy promise is stated');
    assert.ok(section.includes('do not claim'), 'and the page says plainly what it does not claim');
  });

  test('the AI section states the guardrails the backend implements', () => {
    const copy = [AI_LAYER.copy, ...AI_LAYER.capabilities.map((item) => `${item.title} ${item.copy}`)]
      .join(' ')
      .toLowerCase();

    for (const required of ['permission', 'redact', 'usage']) {
      assert.ok(copy.includes(required), `the AI section never mentions ${required}`);
    }

    // The demo conversation is labelled illustrative, so a screenshot of it is
    // never mistaken for a real company's data.
    assert.match(AI_LAYER.demo.note, /illustrative/i);

    // Violet is the assistant's colour and the page's only other accent, so the
    // AI band is the one place allowed to lead with it.
    const ai = code('src/pages/landing/sections/AiSection.jsx');

    assert.ok(ai.includes('violet-300'), 'the assistant band carries the violet');
    assert.ok(!code('src/pages/landing/sections/PricingSection.jsx').includes('violet'), 'pricing does not borrow it');
  });

  test('the hero makes exactly the promises the product can keep', () => {
    assert.ok(HERO.assurances.some((item) => /no card/i.test(item)));
    assert.ok(HERO.assurances.some((item) => /nothing deleted|read-only/i.test(item)));

    // The headline takes a position; the copy underneath it explains, and the
    // product moment is a real route in the page rather than a screenshot.
    assert.ok(HERO.titleLead.length > 10);
    assert.ok(PRODUCT_MOMENT.callouts.length >= 3, 'the product moment has three beats');
    assert.ok(code('src/pages/landing/sections/ProductMomentSection.jsx').includes('id={SECTION_IDS.product}'));
  });
});
