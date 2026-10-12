// ═══════════════════════════════════════════════════════════════════════════
// HOME PAGE — pins for the public landing surface (`/`)
//
// A landing page is marketing copy, and marketing copy rots silently: a price
// changes in the backend and the page keeps advertising the old one; a section
// is renamed and the header nav points at nothing; a footer link is added for a
// route that does not exist. None of that fails a build by itself.
//
// So the checks here are mostly CHECKS AGAINST THE SOURCE OF TRUTH, not against
// strings typed twice:
//   · every price on the page  vs  Backend/src/utils/platformPlans.js
//   · "14-day trial"           vs  TRIAL_DAYS in Backend/src/utils/constants.js
//   · "2 months free"          vs  the arithmetic of the plan data itself
//   · every nav anchor         vs  a section id that is actually rendered
//   · every link               vs  a route that exists in AppRoutes.jsx
//
// The rest pin the two things a marketing page must never do: invent social
// proof, and forget that a keyboard exists.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import landing, { PLANS, NAV_LINKS, FOOTER_COLUMNS, SECTION_IDS, WORKFLOW_BLOCKS, FAQS } from '../src/pages/landing/landingData.js';

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
  'src/pages/landing/DashboardPreview.jsx',
  'src/pages/landing/sections/HeroSection.jsx',
  'src/pages/landing/sections/ModulesSection.jsx',
  'src/pages/landing/sections/WorkflowSection.jsx',
  'src/pages/landing/sections/SecuritySection.jsx',
  'src/pages/landing/sections/PricingSection.jsx',
  'src/pages/landing/sections/FaqSection.jsx',
  'src/pages/landing/sections/CtaSection.jsx',
];

const BACKEND_PLANS = path.join(root, '..', 'Backend', 'src', 'utils', 'platformPlans.js');
const BACKEND_CONSTANTS = path.join(root, '..', 'Backend', 'src', 'utils', 'constants.js');

// ── the backend catalogue, parsed ──────────────────────────────────────────
const backendPlans = () => {
  const source = fs.readFileSync(BACKEND_PLANS, 'utf8');
  const plans = {};

  const block = /^ {2}([A-Z_]+): \{([\s\S]*?)^ {2}\},?$/gm;

  for (const match of source.matchAll(block)) {
    const [, code, body] = match;
    const prices = body.match(/prices:\s*\{([^}]*)\}/);

    if (!prices) continue;

    const monthly = prices[1].match(/monthly:\s*([\d.]+)/);
    const yearly = prices[1].match(/yearly:\s*([\d.]+)/);

    plans[code] = {
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

  test('every section the data advertises is actually rendered', () => {
    for (const key of Object.keys(SECTION_IDS)) {
      const id = SECTION_IDS[key];
      const owner = LANDING_FILES.filter((file) => file.includes('sections/')).find((file) =>
        code(file).includes(`id={SECTION_IDS.${key}}`),
      );

      assert.ok(owner, `no section renders id={SECTION_IDS.${key}} (anchor #${id})`);
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
  });

  test('the trial length matches TRIAL_DAYS', () => {
    const constants = fs.readFileSync(BACKEND_CONSTANTS, 'utf8');
    const match = constants.match(/TRIAL_DAYS\s*=\s*(\d+)/);

    assert.ok(match, 'TRIAL_DAYS is declared');
    assert.equal(landing.BRAND.trialDays, Number(match[1]), 'the page and the backend disagree on the trial length');
    assert.match(landing.PRICING_NOTE, new RegExp(`${landing.BRAND.trialDays}-day`));
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

  test('the module inventory matches the app, not a wish list', () => {
    const modules = landing.MODULE_GROUPS.flatMap((group) => group.items.map((item) => item.name));
    const sidebar = read('src/layout/SidebarNav.jsx');

    // "Learning" existed on the old page and is not a module in this product.
    assert.equal(sidebar.includes('Learning'), false, 'the sidebar has no Learning module');
    assert.equal(modules.includes('Learning'), false, 'so the home page must not claim one');

    // Spot-check the modules a visitor is most likely to sign up for.
    for (const expected of ['Attendance', 'Payroll', 'Recruitment', 'Chat Hub', 'Meetings']) {
      assert.ok(modules.includes(expected), `${expected} is missing from the module list`);
    }
  });

  test('no fabricated social proof, and no placeholder copy', () => {
    // Comments stripped: several files explain WHY there is no social proof here,
    // and a ban must not be tripped by the comment that documents the ban.
    const data = [...LANDING_FILES, 'src/pages/landing/landingData.js']
      .map((file) => code(file))
      .join('\n');

    for (const phrase of ['testimonial', 'Lorem ipsum', 'trusted by', 'Trusted by']) {
      assert.equal(data.includes(phrase), false, `found "${phrase}" — nothing in this repo backs it up`);
    }

    // A count followed by users/customers/companies is the classic invention.
    // A DIGIT must be present — a bare comma would match a JSX list of icon names
    // (`UserPlus,\n  Users,`) and report a fabricated number that is not there.
    assert.equal(
      /\b\d[\d,]*\s*\+?\s*(users|customers|companies|teams)\b/i.test(data),
      false,
      'a usage number appeared without a source',
    );
  });
});

describe('Home page — navigation integrity', () => {
  test('every nav and footer anchor points at a section that exists', () => {
    const ids = Object.values(SECTION_IDS);
    const anchors = [
      ...NAV_LINKS.map((link) => link.href),
      ...FOOTER_COLUMNS.flatMap((column) => column.links.filter((link) => link.href).map((link) => link.href)),
      ...WORKFLOW_BLOCKS.map((block) => block.cta.href).filter(Boolean),
    ];

    assert.ok(anchors.length >= 10, 'the anchors were collected');

    for (const href of anchors) {
      assert.match(href, /^#/, `unexpected external href ${href}`);
      assert.ok(ids.includes(href.slice(1)), `${href} has no matching section id`);
    }

    assert.equal(new Set(ids).size, ids.length, 'section ids are unique');
  });

  test('every link resolves to a route that exists', () => {
    const routes = code('src/routes/AppRoutes.jsx');
    const declared = new Set([...routes.matchAll(/path="([^"]+)"/g)].map((match) => match[1]));

    const links = [
      ...FOOTER_COLUMNS.flatMap((column) => column.links.filter((link) => link.to).map((link) => link.to)),
      ...PLANS.map((plan) => plan.cta.to),
      ...WORKFLOW_BLOCKS.map((block) => block.cta.to).filter(Boolean),
      landing.FOOTER_SUPPORT.link.to,
    ];

    assert.ok(links.length >= 6, 'the links were collected');

    for (const to of links) {
      assert.ok(declared.has(to), `${to} is linked but no route declares it`);
    }

    // The footer must not repeat AuthLayout's dead legal text as fake links.
    const footer = code('src/pages/landing/LandingFooter.jsx');

    assert.equal(/to="\/?(privacy|terms)"/.test(footer), false, 'those pages do not exist');
  });

  test('in-page links inside components are declared in the data, not typed twice', () => {
    const files = LANDING_FILES.map((file) => code(file));

    for (const source of files) {
      for (const match of source.matchAll(/href="#([\w-]+)"/g)) {
        // `#main` is the skip link's target — the landmark, not a marketing section.
        const target = match[1];
        const allowed = target === 'main' || Object.values(SECTION_IDS).includes(target);

        assert.ok(allowed, `href="#${target}" is neither a SECTION_IDS value nor the #main landmark`);
      }
    }
  });
});

describe('Home page — accessibility', () => {
  test('the mobile menu is a real disclosure', () => {
    const header = code('src/pages/landing/LandingHeader.jsx');

    assert.ok(header.includes('aria-expanded={menuOpen}'), 'the trigger reports its state');
    assert.ok(header.includes('aria-controls="landing-mobile-menu"'), 'and names its panel');
    assert.ok(header.includes("aria-label={menuOpen ? 'Close menu' : 'Open menu'}"), 'and has an accessible name');
    assert.ok(header.includes("event.key === 'Escape'"), 'Escape closes it');
  });

  test('the FAQ is keyboard-operable and announced', () => {
    const faq = code('src/pages/landing/sections/FaqSection.jsx');

    assert.ok(faq.includes('aria-expanded={open}'));
    assert.ok(faq.includes('aria-controls={panelId}'));
    assert.ok(faq.includes('aria-labelledby={buttonId}'));
    assert.ok(faq.includes('<button'), 'the trigger is a button, not a div');
  });

  test('the pricing toggle and decorative visuals announce themselves correctly', () => {
    const pricing = code('src/pages/landing/sections/PricingSection.jsx');
    const preview = code('src/pages/landing/DashboardPreview.jsx');

    assert.ok(pricing.includes('aria-pressed={cycle === option.id}'), 'the billing toggle is a toggle');
    assert.ok(pricing.includes('role="group"'), 'and its buttons are grouped');
    assert.ok(preview.includes('aria-hidden="true"'), 'the mock dashboard is not read aloud');
  });

  test('the motion preference is respected', () => {
    const css = read('src/style.css');

    assert.match(css, /prefers-reduced-motion: reduce/, 'the app already honours it');
    assert.match(css, /html:has\(\.landing-shell\)\s*\{[\s\S]*?scroll-behavior/, 'smooth scroll is opt-in per shell');
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
    // file's own `const shared = '…'` so the pin stays strict instead of
    // exempting every expression (which is how a real gap would hide).
    const sharedClassNames = (source) => {
      const map = new Map();

      for (const match of source.matchAll(/const\s+(\w+)\s*=\s*\n?\s*'([^']*)'/g)) {
        map.set(match[1], match[2]);
      }

      return map;
    };

    let scanned = 0;
    const perFile = new Map();

    for (const file of LANDING_FILES) {
      const source = code(file);
      const tags = openingTags(source);
      const shared = sharedClassNames(source);

      scanned += tags.length;
      perFile.set(file, tags.length);

      for (const tag of tags) {
        let resolved = tag;
        const viaVariable = tag.match(/className=\{(\w+)\}/);

        if (viaVariable) {
          const literal = shared.get(viaVariable[1]);

          assert.ok(
            literal,
            `${file}: className={${viaVariable[1]}} could not be resolved to a string literal`,
          );

          resolved = `${tag} ${literal}`;
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
    assert.ok(scanned >= 20, `only ${scanned} controls were scanned — is the scanner broken?`);
    assert.ok(perFile.get('src/pages/landing/LandingHeader.jsx') >= 6, 'the header controls were found');
    assert.ok(perFile.get('src/pages/landing/LandingFooter.jsx') >= 2, 'the footer controls were found');
  });
});

describe('Home page — content sanity', () => {
  test('the FAQ answers the questions a buyer actually asks', () => {
    const questions = FAQS.map((faq) => faq.q.toLowerCase()).join(' | ');

    for (const topic of ['trial', 'trial ends', 'another company', 'roles', 'install']) {
      assert.ok(questions.includes(topic), `no FAQ answers "${topic}"`);
    }

    for (const faq of FAQS) {
      assert.ok(faq.a.trim().length > 40, `answer too thin: ${faq.q}`);
    }
  });

  test('the security section promises only what the codebase can back', () => {
    const points = landing.SECURITY_POINTS.map((point) => `${point.title} ${point.copy}`).join(' ').toLowerCase();

    for (const fabricable of ['ISO 27001', 'SOC 2', 'HIPAA', 'GDPR certified', 'bank-grade', 'military-grade']) {
      assert.equal(
        points.includes(fabricable.toLowerCase()),
        false,
        `"${fabricable}" is a claim with no evidence in this repo`,
      );
    }

    assert.ok(points.includes('tenant'), 'the tenancy promise is stated');
  });
});
