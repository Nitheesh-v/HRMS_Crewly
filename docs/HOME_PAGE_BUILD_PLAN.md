# HOME PAGE — HEADER, MORE SECTIONS, FOOTER (build plan)

Owner request: *"MAKE HOME PAGE WITH MORE SECTIONS WITH HEADER AND FOOTER — WITH GOOD
DESIGN AND UI/UX."* This is a presentation unit on the public marketing surface
(`/`), not a new phase. No auth, API or data-model change.

---

## A. REPOSITORY FINDINGS

| # | Finding | Evidence |
|---|---|---|
| A1 | `/` renders `pages/landing/LandingPage.jsx` — **94 lines**: a hero and a 9-card module grid. **No header, no footer**, no nav, no anchors, no sections below the fold. | `routes/AppRoutes.jsx:232`; file read |
| A2 | It is a **light** page (`bg-slate-50`, emerald) while every other public surface is **dark**: `AuthLayout` uses `#0b1120` with emerald/teal accents and the `logo-crewly.png` wordmark, and the careers portal uses `slate-800` borders with indigo/emerald radial gradients. Clicking "Sign in" from the light page lands on a dark page — the visual seam is one click wide. | `layout/AuthLayout.jsx`, `pages/careers/CareerLandingPage.jsx` |
| A3 | The brand block is duplicated, not shared: the logo + "Crewly" wordmark is re-declared inside `AuthLayout` and twice inside `SidebarNav`. There is no `Logo` component to reuse. | grep `logo-crewly` |
| A4 | **No legal routes exist** — `/privacy`, `/terms`, `/about`, `/contact`, `/pricing` are all absent. `AuthLayout`'s footer therefore renders "Terms & Conditions" and "Privacy Policy" as **`<span>` dead text**, not links. | route list; `AuthLayout.jsx` footer |
| A5 | **Real plan data exists server-side**: `Backend/src/utils/platformPlans.js` — Free ₹0, Trial ₹0, Basic ₹999/₹9,990, Professional ₹2,499/₹24,990, Enterprise ₹4,999/₹49,990 (INR, monthly/yearly). There is **no public plans endpoint**, and the yearly price is exactly 10 months for all three paid tiers (**"2 months free"** is arithmetically true, not a marketing guess). | plans file, computed |
| A6 | The trial claim on the current page ("14-day free trial · No credit card required") is **true**: `TRIAL_DAYS = 14` in `Backend/src/utils/constants.js`, and `RegisterCompanyPage` collects company + admin name + email + password only — no payment step. Razorpay is a backend dependency used for BGV orders and platform billing, not for signup. | constants; register form |
| A7 | What happens when a subscription lapses is defined and worth stating publicly: writes return **403 `SUBSCRIPTION_READ_ONLY`** and reads continue — the workspace is not deleted. | `subscriptionAccess.checkWriteAccess`, `subscriptionEngine.canWrite` |
| A8 | Security claims the product can honestly make today: HttpOnly-cookie sessions with a CSRF header (33.14), per-tenant `companyId` scoping everywhere, an RBAC permission catalogue at version 38 with role permissions **and** per-user overrides, an `AuditLog` model with a UI (`/app/audit-logs`), active-session control (`/app/security/sessions`), and email 2FA for platform staff. | api.js header comment; `permissionService.js` (`SYSTEM_PERMISSION_VERSION = 38`); `models/AuditLog.js`; route list |
| A9 | **No social proof exists anywhere in the repo** — no customers, logos, testimonials or usage numbers. Inventing them is the one thing a landing page must not do. | grep for testimonial/customer/proof |
| A10 | No test touches the landing page; it is also unmeasured by any pin (unlike chat, presence, profile changes). | `Frontend/test` listing |
| A11 | Real, shippable module inventory (from the sidebar + permission registry): Attendance, Leave, Payroll, Recruitment/ATS, BGV, Onboarding, Documents, Performance, Expenses, Assets, Projects & Tasks, Chat Hub, Meetings, Announcements, Holidays & Shifts, Reports & Analytics, AI Assistant, Presence, Lifecycle/Exit, Support tickets. Stats/role names for the page come from this list, not from imagination. | `SidebarNav.jsx`, `permissionRegistry.js` |

## B. SECURITY / DATA BOUNDARIES

* **Public surface, zero data.** The page renders **only static content** — no API
  call, no token read beyond the existing Redux `auth.user` display profile (which
  the store already hydrates from `localStorage`) to decide whether the header CTA
  says "Sign in" or "Open dashboard". Nothing new is stored, sent or logged.
* **No dead links.** Every `to=` in the header/footer must resolve to a route that
  exists in `AppRoutes.jsx` or to an in-page anchor — A4's dead `<span>` legal text
  is **not** copied. Instead of fake Privacy/Terms links, the footer says where
  each company's own support channel lives and links only to real pages.
* **Truthful copy only.** Pricing and the trial length are read from the backend
  catalogue by test (D2/D3), so a price change or a trial change **fails the
  frontend suite** instead of shipping a lie. No customers, logos, testimonials or
  usage counts are invented (A9).
* **No new dependencies.** `lucide-react` and Tailwind v4 are already present;
  animation is CSS-only.
* **Accessibility is a boundary too:** semantic landmarks, a skip link, labelled
  nav, `aria-expanded` on the mobile menu and FAQ, visible focus rings, and a
  `prefers-reduced-motion` guard for every transition this page adds.

## C. IMPLEMENTATION

**Design language (locked to the existing public surfaces, A2/A3):** `#0b1120`
canvas with layered emerald/indigo radial glows, `border-white/10` glass cards,
emerald→teal primary CTA, indigo secondary accents, `text-slate-300/400` body,
`logo-crewly.png` + "Crewly" wordmark, `rounded-2xl`, hover lift, `scroll-mt-24`
on every anchor target so the sticky header never covers a heading.

| File | Purpose |
|---|---|
| `src/pages/landing/landingData.js` | **one source of truth** for nav anchors, modules, workflow blocks, security points, plans, FAQs, footer columns. JSX-free so tests can import it directly. |
| `src/pages/landing/LandingHeader.jsx` | sticky header: logo, anchored nav, auth-aware CTA, mobile menu, skip link |
| `src/pages/landing/LandingFooter.jsx` | 4-column footer + bottom bar with the current year |
| `src/pages/landing/sections/*.jsx` | `HeroSection`, `TrustStrip`, `ModulesSection`, `WorkflowSection`, `SecuritySection`, `PricingSection`, `FaqSection`, `CtaSection` |
| `src/pages/landing/LandingPage.jsx` | composes header + `main` + footer, sets `document.title` |
| `src/pages/landing/DashboardPreview.jsx` | the CSS-built product mock for the hero (no image asset, no client data) |
| `src/style.css` | namespaced landing additions: smooth scroll + `prefers-reduced-motion` guard |

Sections in order: **Header** → Hero (badge, headline, sub, 2 CTAs, trial note,
product preview) → Trust strip (6 honest capability chips) → Modules (grouped,
all real) → Workflow (3 alternating deep-dives: hire→onboard, time→payroll,
presence→team) → Security & compliance (6 points from A8) → Pricing (4 tiers +
monthly/yearly toggle, "2 months free") → FAQ (6, accordion) → Final CTA →
**Footer**.

## D. TEST PLAN

`Frontend/test/landingPage.test.js` (hermetic, `node --test`):

1. **Structure** — header + `main` + footer landmarks exist; a skip link exists;
   `document.title` is set.
2. **Pricing truth** — every plan in `landingData.js` is compared against
   `Backend/src/utils/platformPlans.js` (read + parsed in the test). A drifted
   price fails.
3. **Trial truth** — the "14-day" claim is compared against `TRIAL_DAYS` in
   `Backend/src/utils/constants.js`; the "no credit card" claim is pinned to the
   absence of a payment field in the register page.
4. **"2 months free"** — computed from the plan data (yearly === monthly × 10) for
   every paid tier.
5. **Anchors** — every nav/footer anchor has a matching section id in the page,
   and every id is unique.
6. **No dead links** — every `to=` in the landing files exists as a route in
   `AppRoutes.jsx`; the only permitted external scheme is `mailto:`.
7. **No fabricated social proof** — no testimonial/customer-count keys in the data
   file, no "Lorem ipsum", no digits-suffixed "+ users/companies" pattern.
8. **Accessibility pins** — mobile menu button has `aria-expanded`, FAQ buttons
   have `aria-expanded` + `aria-controls`, decorative visuals are `aria-hidden`,
   and the reduced-motion guard exists in `style.css`.
9. **Route intact** — `/` still lazy-loads `LandingPage` (the app bundle must not
   absorb ~10 new components).

Then: `npm test`, `npm run build`, and the backend suite untouched but re-run once
to prove nothing else moved.

## E. ENVIRONMENT / DEPENDENCIES

No new packages, no env vars, no backend change. Build with Vite as today; the page
stays inside the lazy `LandingPage` chunk. Preview is the normal `npm run dev`.

**Honest limits:** no legal pages exist, so the footer cannot link to Privacy/Terms
(flagged as a follow-up needing real legal text, not invented copy). Owner
acceptance is unrun, as always.


---

## F. RESULTS

### Files

| File | Change |
|---|---|
| `src/pages/landing/landingData.js` | **new** — every section's content in one JSX-free module (nav, trust chips, 20 modules in 5 groups, 3 workflow blocks, 6 security points, 4 plans, 6 FAQs, footer columns) |
| `src/pages/landing/LandingHeader.jsx` | **new** — sticky header that gains its background on scroll, anchored nav, auth-aware CTA, real mobile disclosure (Escape closes it) |
| `src/pages/landing/LandingFooter.jsx` | **new** — 4 columns + support panel + bottom bar; no dead legal links, no invented contact details |
| `src/pages/landing/DashboardPreview.jsx` | **new** — the hero's product mock, pure markup, `aria-hidden` |
| `src/pages/landing/LandingIcon.jsx` | **new** — key→icon registry (keeps the data file JSX-free) |
| `src/pages/landing/sections/*.jsx` | **new** — Hero, Modules, Workflow, Security, Pricing (monthly/yearly toggle), FAQ (accordion), CTA |
| `src/pages/landing/LandingPage.jsx` | **rewritten** — 94 lines of hero + grid became header → main (7 sections) → footer, with a skip link |
| `src/style.css` | smooth scroll for the landing shell only, with the reduced-motion opt-out |
| `Frontend/test/landingPage.test.js` | **new** — 20 pins |

### Evidence

* **It renders.** Loaded through Vite's transform pipeline and rendered with
  `react-dom/server`: 82.8 kB of markup, all 16 structure/section/price checks
  pass, and the header CTA swaps from "Sign in" to "Open dashboard" for a
  signed-in visitor (verified both ways).
* **Tests:** frontend `npm test` → **417 / 0 fail** (397 + 20). Backend untouched.
* **Build:** the page is its own lazy chunk (`LandingPage-*.js` 41.2 kB / 10.7 kB
  gzip) and `index-*.js` is unchanged at 433 kB — the app shell did not grow.
* **The checks are against sources of truth, not restated strings:** prices vs
  `platformPlans.js`, the trial length vs `TRIAL_DAYS`, "2 months free" vs the
  arithmetic of the data, anchors vs rendered section ids, and links vs the routes
  declared in `AppRoutes.jsx`.
* **The accessibility pin earned its place immediately** — it caught four real
  gaps I had written: the header logo link and all four mobile-menu links had no
  visible focus ring. Fixed.

### Deliberately not invented

* **No customers, logos, testimonials or usage numbers.** None exist in the
  repository, so none appear on the page (pinned by test).
* **No compliance badges.** The security section states the tenancy, session,
  RBAC and audit facts that are implemented, with an explicit line saying Crewly
  does not claim certifications it has not been audited for.
* **No legal pages.** `AuthLayout` renders "Terms & Conditions" and "Privacy
  Policy" as dead text; this footer does not repeat that. Real Privacy/Terms pages
  need real legal copy — a separate unit if you want them.
* **No support email.** There is none in the codebase, so the footer points at the
  in-app support desk instead of inventing an address.
* The old page's "Learning" module was removed: it is not a module in this
  product, and the test now asserts the sidebar and the page agree.

### Owner look (already live)

```powershell
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly
git pull origin arena/379846ae-hrms-crewly
cd Frontend
npm run dev
```

Then open `http://localhost:5173/` and check: the sticky header, the mobile menu at
a narrow width, the pricing toggle (Monthly ⇄ Yearly — "2 months free" appears),
the FAQ accordion with the keyboard (Tab + Enter/Escape-free, `aria-expanded`
reported), and the footer columns.

**Not owner-accepted.** The render checks above are automated; the design judgement
is yours.

---

## G. REDESIGN — Keka's information architecture, Crewly's identity (2026-10-24)

Owner request: *“analyze repo … build a public home page like keka.com.”* Follow-up: *“colors
and designs are the same like keka — lets make it as crewly's original.”*

Two units on the public marketing surface (`/`) only. No auth, API, data-model or backend
change. The first pass copied Keka too literally (paper-white canvas, violet SaaS buttons);
the second keeps the **section order and interaction model** that make keka.com work, and
throws away its palette in favour of Crewly's own:

| | Keka | Crewly (final) |
|---|---|---|
| Canvas | white | **night** — `#070b16`, the app's own darkness |
| Primary | violet / indigo | **emerald 500 → 400**, with dark text — the colour the product uses for “done” |
| Accent | violet everywhere | **violet is reserved**: AI section, logo mark, secondary labels only |
| Cards | white, soft shadow | **glass**: `white/[0.03]`, hairline `white/10`, lit top edge |
| Depth | flat, airy | layered emerald/violet radial glows + a fading graph grid |
| Product shots | light screenshots | **dark product mocks** that look like the real app |
| Typography rhythm | big bold display | same — that part was right |

### G1. What was taken from keka.com, and what was not

| Keka section | This page | Why |
|---|---|---|
| Announcement bar | **Yes** — the AI assistant + language facts, dismissible for the session | something that genuinely ships |
| Mega-menu header | **Yes** — a six-item “Platform” panel that opens the matching tab | real product areas |
| Hero + product screenshot | **Yes** — CSS-built dark dashboard mock (no image asset, no client data) | Keka's hero is a screenshot |
| “Chosen by 12,500+ companies” logo wall | **No** | **no customers exist in this repo**; inventing them is the one thing a marketing page must not do. Replaced by a capability panel + a shipped-facts marquee. |
| “One platform” tabbed deep-dive | **Yes** — 6 ARIA tabs, each with copy + a product mock | the centrepiece of the page |
| AI layer (3 behaviours) | **Yes** — the one violet-led band, illustrative conversation labelled as such | assistant, languages, guardrails are all implemented |
| Integrations wall (100+ tools) | **No** | no integration catalogue exists in the codebase |
| SOC2 / ISO / GDPR badges | **No** — explicit “we do not claim certifications we have not been audited for” | no audit exists |
| Testimonials / customer quotes | **No** | none exist |
| Pricing | **Yes** — the four real tiers, monthly/yearly, arithmetic “2 months free” | pinned to `platformPlans.js` |
| FAQ | **Yes** — 8 questions incl. trial, tenancy, roles, languages, CSV import | |
| Deep footer | **Yes** — 4 columns + support panel + honest legal note | no dead legal links |

Sections in order: announcement → header → hero (badge, h1, sub, 2 CTAs, assurances,
dashboard mock, floating cards, facts marquee) → capability panel → **Platform** tabs →
**Modules** (20, five groups) → **AI** → **How it works** (3 alternating rows) → **Roles**
(one owner card + four scoped roles) → **Security** (6 implemented controls) → **Pricing**
→ **FAQ** → CTA → footer.

### G2. The design system, and why each decision is Crewly's

Everything lives in `src/pages/landing/landingStyles.js` (shared class strings) and
`src/style.css` (tokens + page-scoped CSS):

* tokens: `--color-crewly-night #070b16`, `--color-crewly-night-soft #0b1120`,
  `--color-crewly-panel #0e1526`, `--color-crewly-mint #34d399`, `--color-crewly-violet #8b5cf6`
  — the same values the authenticated app paints, so the marketing page and the product
  cannot drift apart;
* `.landing-shell` (night canvas), `.landing-grid` (fading graph paper), `.landing-aurora`
  (emerald + violet halo), `.landing-card` (glass with a lit top edge), `.landing-preview`
  (the dark product mock), `.landing-hairline` (emerald→violet rule), `.landing-dots`,
  `.landing-mark` (logo sizing);
* primitives: `primaryCta` (emerald), `secondaryCta`, `ghostLink`, `navLink`, `eyebrow`,
  `sectionTitle`, `sectionCopy`, `focusRing`, `transition`;
* **violet is a semantic colour here, not decoration**: it belongs to the AI surface and
  the logo. Every action on the page is emerald. That single rule is what stops the page
  looking like a template;
* motion is opt-in (`prefers-reduced-motion: no-preference`) and the marquee pauses on hover.

Two global CSS facts had to be handled, both recorded in `style.css`:

1. the unlayered `h1/h2/h3` responsive scale **outranks Tailwind's `text-*` utilities**, so
   it now excludes `.landing-shell` — otherwise every marketing headline was clamped to
   1.875rem (measured: the hero `h1` now computes at 67px on desktop, 41.6px at 390px);
2. the unlayered `img { max-width:100%; height:auto }` reset outranks Tailwind's height
   utilities, so the logo mark is sized by `.landing-mark`.

The square `logo-crewly.png` has its wordmark baked in, so it is invisible on a night
canvas at 36px. The header and footer therefore pair the **trimmed mark**
(`public/logo-crewly-mark.png`, generated by cropping the alpha bounding box of the original
— the source file is untouched) with live text. No light wordmark asset was invented.

### G3. Files

| File | Change |
|---|---|
| `src/pages/landing/landingData.js` | **rewritten** — every section's content in one JSX-free module (announcement, nav, hero, facts, trust chips, 6 platform tabs, 20 modules, AI layer, 3 workflow blocks, 5 roles, 6 security points, 4 plans, 8 FAQs, 4 footer columns, legal note) |
| `src/pages/landing/landingStyles.js` | **new** — the page's design primitives (see G2) |
| `src/pages/landing/LandingHeader.jsx` | **rewritten** — night glass header, announcement bar (session-dismissible), platform mega-menu anchored to the nav so a 54rem panel always fits, auth-aware CTA, mobile menu with a nested Platform disclosure |
| `src/pages/landing/LandingFooter.jsx` | restyled for the night surface; 4 columns + support panel + legal note + back-to-top |
| `src/pages/landing/DashboardPreview.jsx` | **rewritten** — dark product mock: sidebar, stat tiles, emerald 7-day attendance chart, approvals, chips |
| `src/pages/landing/PlatformPreview.jsx` | **new** — the six dark tab mocks (payroll, people, hiring, attendance, performance, collaboration) |
| `src/pages/landing/landingTabs.js` | **new** — one DOM CustomEvent so the header menu can open a tab without a context or a query param |
| `src/pages/landing/LandingIcon.jsx` | extended registry (32 keys) |
| `src/pages/landing/sections/*.jsx` | Hero, **CapabilityStrip** (instrument panel), **Platform** (ARIA tablist), Modules, **AI**, Workflow, **Roles** (owner card + four), Security, Pricing, FAQ, CTA |
| `src/pages/landing/LandingPage.jsx` | composes 11 sections; sets `document.title` and restores it on unmount |
| `src/routes/AppRoutes.jsx` | `/` moved **out of** `PublicLayout` — nesting it rendered two headers and two footers |
| `public/logo-crewly-mark.png` | **new** — the mark cropped out of the original for use on the night canvas |
| `src/style.css` | night landing layer, tokens, and the two global-CSS carve-outs |
| `Frontend/test/landingPage.test.js` | **rewritten** — 31 pins (see G5) |

### G4. Bugs found by rendering it in a real browser

None of these would have failed a test, and all were caught in Chromium screenshots:

1. **`transition-all` killed every focus ring.** Tailwind's `transition-all` animates
   `outline-width`/`outline-offset`, and the app's global `prefers-reduced-motion` rule
   collapses durations to `0.01ms` — measured: the ring stayed at `outline-width: 0px`. Every
   landing control now lists its properties, and a test forbids a bare `transition`/`transition-all`.
2. **The hero accent underline was absolutely positioned** — on a phone the accent wrapped,
   so the bar drew under the last line only and the full stop sat alone on its own row.
3. **The mock's sparkline rendered empty** — percentage heights inside a flex column have no
   definite parent; they are pixel heights now.
4. **The roles grid left a dead column** (`row-span-2` admin card beside two stacked cards);
   it is now an owner card + four scoped roles in a 3-column ladder.
5. **The platform panel needed `mt-10` when it stacks** on mobile.
6. **`aria-controls` pointed at unmounted panels** — the desktop menu and both mobile panels
   are now always mounted and toggled with `hidden`, so the attribute always resolves.

### G5. Test plan — 31 pins, mostly against sources of truth

Prices vs `platformPlans.js`; trial vs `TRIAL_DAYS` (and the digits `14` may not be typed
into markup); “2 months free” vs the arithmetic; “no credit card” vs the register form;
**roles vs `ROLE_LABELS`** (all five, both directions); **AI language counts vs
`chatLanguages.js`** (14 platform / 5 default); module inventory 20 across 5 groups; every
anchor resolves to a rendered section id; every link resolves to a route in `AppRoutes.jsx`;
the landing route is **not** nested in `PublicLayout`; **the page wears Crewly's own surface**
(night token, no light-theme leftovers, `--color-crewly-mint` declared); **the primary action
is emerald and comes from one shared class** (five section files must import it); **no control
animates `all`**; no fabricated social proof (incl. “Chosen by”); no compliance badges; ARIA
tablist keyboard contract (arrows, Home, End, `aria-selected`, roving `tabIndex`); mega-menu
and mobile menu `aria-expanded`; FAQ disclosure; pricing toggle; announcement dismiss label;
reduced-motion guard; visible focus style on **every** `Link`/`a`/`button` in the landing
files — shared class constants *and* `${…}` interpolations are resolved, including imports
from `landingStyles.js`, so the pin cannot be satisfied by an unreadable expression.

### G6. Evidence

* `npm test` (Frontend) → **451 / 0 fail**. Backend untouched.
* `npm run build` → the page is still its own lazy chunk; `index-*.js` unchanged at ≈ 434 kB,
  so the app shell did not absorb it.
* `npx eslint src/pages/landing src/routes/AppRoutes.jsx test/landingPage.test.js` → clean.
* Headless Chromium at 1440, 1024 and 390: no console/page errors, no horizontal overflow;
  mega-menu inside the viewport and opening the chosen tab; the primary CTA focus ring paints
  at 2px emerald; the FAQ, pricing toggle and announcement dismissal all behave.
* `document.title` = “Crewly — HR, payroll and attendance in one workspace”; hero `h1`
  computes at 67.2px desktop / 41.6px mobile.

### G7. Deliberately not built

Customers, logos, testimonials, usage counts, certification badges, an integrations wall, and
Privacy/Terms pages. None of them exist in this repository; the footer states that the legal
pages are unpublished instead of linking to nothing. Adding any of them is a content decision
that needs a real source, not a design change.

**Not owner-accepted.** The render and interaction checks above are automated; the design
judgement remains the owner's.

---

## H. THE CINEMATIC PASS — Uncle Rudy as the reference, Crewly as the identity (2026-10-24)

The owner's third direction was a single line: **“https://www.unclerudy.app/ make like this”**.
The reference is a one-page, near-black app site with one giant headline, glass panels, a
floating product image and a repeated CTA. What was asked for was that *confidence*, not that
site: the brief settled on **a full reimagining** (not a re-skin) in a **bolder but still honest
voice** — “Bolder headlines, same honest facts”.

Nothing was copied. Every claim on the page is still pinned to code, and every price, role,
language count and module name still comes from the same source of truth as pass #2.

### H1. What the reference does, and what was taken

| The reference | What Crewly does instead |
| --- | --- |
| One oversized headline stating the product's promise and personality | One oversized headline stating the problem the product removes: *“The HRMS that stops arguing with itself.”* |
| An eyebrow pill above it (“BUILT FOR iOS 27”) | An eyebrow pill with a live dot: **Built for Indian payroll** · INR billing · trial |
| A single large feature image per proof point | A **live-rendered product window** (`ProductWindow.jsx`) that drifts on a perspective — no screenshot to go stale, no invented data beyond the mock |
| Dense capability *list*, not nested cards | Six capability cards, then the honest inventory: all 20 modules as chips, grouped the way the sidebar groups them |
| Repeated badge-style CTA after each band | One sticky glass bar that appears past the hero and stands down at the footer |
| No pricing, no FAQ, no nav | Both kept — an HR/payroll buyer needs the trial terms and the plan table — but folded into two bands instead of five |
| Saturated teal→blue gradient field | Near-black canvas with **one** emerald light source, violet only where the assistant lives |

### H2. The seven bands

`hero → the product moment → capabilities + inventory → the AI layer → trust (security + roles)
→ pricing + FAQ → closing CTA`, then the footer. Pass #2's eleven bands (tabbed platform tour,
workflow, roles, standalone FAQ, modules) were merged or deleted; their files were deleted too,
so nothing can quietly re-render old classes.

### H3. The visual system

* **Tokens** (`style.css` `@theme`): `crewly-void #05060b`, `crewly-void-soft #080a12`,
  `crewly-panel #0b0e18`, `crewly-mint #34d399`, `crewly-mint-deep #10b981`,
  `crewly-violet #8b5cf6`. Emerald is the only action colour; violet is the assistant's.
* **The cinematic layer** (`style.css` §12): `.landing-shell`, `.landing-glow`,
  `.landing-glow-soft`, `.landing-grid`, `.landing-glass`, `.landing-window`, `.landing-beam`,
  `.landing-dots`, `.landing-mark`. Retired and deleted: `.landing-aurora`, `.landing-card`,
  `.landing-preview`, `.landing-hairline(s)`.
* **Motion** is opt-in: `landing-rise` (entrances with 3 stagger steps), `landing-float`,
  `landing-drift` (the hero window's perspective sway), `landing-breathe` (the live dot) and
  `landing-marquee-track` (the fact strip, paused on hover) all live inside
  `@media (prefers-reduced-motion: no-preference)`.
* **Type**: one clamped display scale (`displayXl` / `displayLg` in `landingStyles.js`), so the
  headline is 84px at 1440, 67.6px at 1024 and 41.6px at 390 without per-breakpoint sizes.
* **Buttons** are still one shared emerald string; no section is allowed to invent its own.

### H4. Six bugs only a browser found

1. **The glow painted behind the canvas.** The `.landing-glow` / `.landing-grid` layers are
   `-z-10` children of their sections; the sections are not stacking contexts, so they painted
   *behind* `.landing-shell`'s opaque background and the page was flat black. Fixed with
   `isolation: isolate` on `.landing-shell` — measured as 0 glow before, visible after.
2. **A hard horizontal seam across the top of the glow.** The radial started exactly at the
   section's top edge. The layer is now pulled up (`-top-48`) and its centre moved off-screen,
   so only the falloff is visible.
3. **Every module chip was 58px tall.** The chips' `<ul>` is a grid item, so it was stretched to
   the row height, and `align-content: stretch` blew the single flex line up to fill it. Fixed
   with `content-start items-start`; the chips are 26px again.
4. **Floating glass cards sat on top of the numbers they were meant to frame.** They are now
   anchored to the window's vertical extremes, and only render from `xl` where there is gutter
   to float in.
5. **The sticky bar parked on the footer**, covering the links the visitor came for. It now
   stands down when the footer enters the viewport, and is `inert` whenever it is hidden.
6. **The eyebrow pill became a three-line block at 390px.** The “INR billing · trial” note is a
   desktop-only second thought.

### H5. Test plan — still 31 pins, a new contract

Kept unchanged: prices vs `platformPlans.js`; trial vs `TRIAL_DAYS` (the digits `14` may not be
typed into markup); “2 months free” vs the arithmetic; “no credit card” vs the register form;
roles vs `ROLE_LABELS`; language counts vs `chatLanguages.js`; 20 modules vs the sidebar; no
fabricated social proof; no compliance badges; anchors vs rendered sections; links vs real
routes; the route outside `PublicLayout`; no control animating `all`; reduced motion; a visible
focus style on **every** `Link`/`a`/`button`.

New or adapted: the **seven-band composition and its order**; the seven section files and the
eight retired ones that must stay deleted; `bg-crewly-void` + the `--color-crewly-void` /
`--color-crewly-mint` / `--color-crewly-violet` tokens; the cinematic class names exist in CSS
and the retired ones appear nowhere; the hero renders `ProductWindow` with `landing-drift` and
a hidden duplicate marquee row; the sticky bar is inert while hidden and points at the same
destination as the hero CTA; roles are rendered **by the trust section**; the FAQ is a real
disclosure inside pricing. The focus scanner now reads only the `className` attribute (an
`href={…}` interpolation is data, not classes) and resolves ternaries of shared primitives.

### H6. Evidence

* `npm test` (Frontend) → **451 / 0 fail**; `landingPage.test.js` alone → 31 / 0.
* `npx eslint src/pages/landing src/routes/AppRoutes.jsx test/landingPage.test.js` → clean.
* `npm run build` → 1.35 s; `LandingPage` **68.18 kB / 16.98 kB gzip** (the page got *smaller*
  than pass #2's 95.89 kB by dropping six sections), `index-*.js` unchanged at 433.72 kB.
* Headless Chromium at **1440 / 1024 / 390**: `document.scrollWidth === window.innerWidth` at all
  three; zero console or page errors; hero `h1` at 84.0 / 67.6 / 41.6px; the primary CTA's focus
  ring measures `outline-width: 2px` in emerald; the mobile menu opens with 7 items, closes on
  Escape; `#pricing` lands under the sticky header with the right offset; the sign-up bar is
  `inert` at the footer; `landing-rise` / `landing-drift` compute their animations.

### H7. Deliberately not carried over

The reference's mascot, its cheeky voice, its gradient field, its “as seen on the App Store”
badge — and, from pass #2, the tabbed platform tour, the workflow band, the standalone roles band
and the standalone FAQ. Adding any of them back is a design decision, not a bug fix.

**Still not owner-accepted on taste.** Everything above is measured; whether the page looks right
to the owner is theirs to say.

---

## I. THE BLACK-COLLAGE PASS — the reference, seen properly (2026-10-24)

Pass H was built from a text description of `unclerudy.app` plus an image search. The owner
then sent two real screenshots of the live page, which showed what the description had missed:

* the canvas is **pure black**, not near-black;
* the product's **own name is the page's texture** — letters the size of a wall, cropped by the
  viewport, barely above the black;
* **stickers** — white-outlined badges, rotated a degree or two — scattered around the fold;
* a **stack of notification cards** overlapping the product shot;
* one **heavy pill CTA**, repeated;
* the page **closes on the giant wordmark** with a small credit line above it.

That is what pass I implements. The layout grammar is the reference's; the accent, the copy and
every fact remain Crewly's.

### I1. What changed

| | Before (pass H) | Now |
| --- | --- | --- |
| Canvas | `#05060b` near-black | **`#000000`** — the reference's defining choice |
| Name as texture | — | `.landing-wordmark`, `clamp(5rem, 26vw, 22rem)`, 5.5% white, deliberately wider than the viewport |
| Collage | two glass cards on the window's edge | four `.landing-sticker` badges in the section margins + a rotated stack of three notification cards at `xl` |
| CTA | `px-6 py-3.5 text-sm` | `sm:px-7 sm:py-4 sm:text-[15px]`, bold — it reads as an object |
| Footer | links, legal note, back to top | the same, then a credit line and the wordmark cropped by the page edge |

New data: `HERO_WATERMARK`, `HERO_STICKERS` (4 badges, each naming a shipped fact),
`HERO_NOTIFICATIONS` (3 rows the product actually sends), `FOOTER_CREDIT`.

### I2. What was deliberately not taken from the reference

The **App Store badge** (there is no iOS build of this product), the **mascot** (no character
exists, and inventing one is inventing a brand), the **studio credit** (“Conscious Engines” is
their studio, not this project's), the **social icons** (no accounts), and the comic speech
bubbles. The stickers carry facts instead of jokes. A test now bans those borrowed strings from
ever appearing in the landing files.

### I3. Four things only the browser showed

1. **The watermark behind the headline fought the headline.** At `top-24` the giant letters sat
   straight through “stops”, turning a 84px headline into a legibility problem. It is the
   footer's layer now; the hero stays black.
2. **Stickers placed inside the `max-w-4xl` text column landed on the words** (“ONE LOGIN” over
   “stops”, “GEO-FENCED” over “that”). They live in a `pointer-events-none` layer over the whole
   section now, positioned in percentages near the gutters.
3. **The notification stack buried the mock's data.** Moved up and left (`-left-28 -top-4`,
   `w-56`), so it overlaps the window's corner rather than its numbers.
4. **A 1456px-wide wordmark grew the document.** `document.scrollWidth` went past 1440 until the
   footer took `overflow-hidden`; the letters are meant to be cropped, not to scroll.

### I4. Evidence

* `npm test` (Frontend) → **452 / 0 fail**; `landingPage.test.js` → 32 pins (a wordmark/sticker/
  notification pin was added, and it asserts the borrowed strings are absent).
* `npx eslint src/pages/landing src/routes/AppRoutes.jsx test/landingPage.test.js` → clean.
* `npm run build` → 1.46 s; `LandingPage` **71.08 kB / 17.67 kB gzip**; `index-*.js` unchanged
  at 433.72 kB.
* Headless Chromium at **1440 / 1024 / 390**: `scrollWidth === innerWidth` at all three (the
  wordmark is cropped, not overflowing), zero console errors, the wordmark computes at 352px on
  desktop and is cropped at both edges, stickers render only from `lg`, the notification stack
  only from `xl`.

**Still not owner-accepted on taste.** The structure and the measurements are settled; whether
this is the page is the owner's call.

---

## J. MOTION — the page moves like the reference (2026-10-24)

The reference is not a static poster: its stickers drift, its cards land in sequence, its product
shot leans under the pointer, its glow breathes. Pass J adds that, under two rules:

1. **Every moving thing lives inside `@media (prefers-reduced-motion: no-preference)`.** With
   `reduce` set, every animation computes to `none` and the scroll reveals are at `opacity: 1` —
   measured, not assumed.
2. **Motion never carries information.** Nothing is revealed *only* by an animation; the still
   page is the complete page, and the ornaments stay `aria-hidden`.

### J1. What moves

| Where | What |
| --- | --- |
| Hero glow | `landing-glow-breathe` — 11s opacity breath, so the black does not look like a screenshot |
| Stickers | `landing-wobble` — ±1.6° on the `rotate` property (so the Tailwind rotation still applies), each with a negative, staggered delay |
| Notification stack | `landing-pop` then `landing-float` on one element, staggered 140ms apart, so the cards land one after another and then hover |
| Product window | Pointer tilt: ≤3.5° on X and ≤4.5° on Y, `perspective(1600px)`, 500ms ease-out, returns to rest on leave |
| Section content | `landing-scroll-in` via the native **view timeline** (`animation-timeline: view()`, range `entry 0% → entry 45%`), `@supports`-guarded |
| Primary CTA | `landing-sheen` — one white sweep across the pill on hover, 0.9s |
| Fact strip | `landing-marquee` (from pass H), pauses on hover |

### J2. Why CSS view timelines instead of an IntersectionObserver

No observer, no scroll listener, no `requestAnimationFrame`, no flash of hidden content, and no
extra JavaScript in a lazy chunk. Because the whole reveal lives behind
`@supports (animation-timeline: view())`, a browser without support does not run it as a one-shot
time animation — the CSS simply does not apply and the page is fully visible. A
`MutationObserver`-based reveal tends to leave sections at `opacity: 0` when the observer is
skipped; this cannot.

### J3. The bug that shaped the tilt

The first version gated the tilt on `matchMedia('(pointer: fine)')`. In the test browser that
query reports **false** (headless Chromium has no fine pointer), so the handler never armed — and
the same query is unreliable in embedded browsers. The gate is now per event
(`event.pointerType !== 'mouse'` → bail), which is both more accurate and verifiable: with the
pointer inside the window the transform reads
`perspective(1600px) rotateX(0.15deg) rotateY(1.26deg)`, and it resets to
`rotateX(0deg) rotateY(0deg)` on leave.

### J4. Evidence

* `npm test` (Frontend) → **453 / 0 fail**; `landingPage.test.js` → 33 pins, including
  “the page moves, and the still page is the whole page”.
* `npx eslint src/pages/landing src/routes/AppRoutes.jsx test/landingPage.test.js` → clean
  (the tilt flag is a `ref`, because setting state synchronously in an effect is a cascading
  render — the lint rule caught it).
* `npm run build` → `LandingPage` **72.27 kB / 18.08 kB gzip**, still its own chunk; `index-*`
  unchanged.
* Computed in Chromium: `landing-glow-breathe`, `landing-wobble`, `landing-pop, landing-float`,
  `landing-drift`, `landing-marquee`, `landing-scroll-in` with `animation-timeline: view()`;
  every reveal measures `opacity: 1.00` once in view; under `prefers-reduced-motion: reduce`
  every one of them measures `none`; `scrollWidth === innerWidth`; zero console errors.

**Still not owner-accepted on taste** — this is the part that is most a matter of taste, and the
timings are the easiest thing to change: the numbers all live in `style.css` §13.

---

## K. THE PAPER PASS — the reference changed to wisprflow.ai (2026-10-24)

The owner sent a fourth reference: `https://wisprflow.ai/`. It is the opposite of the previous
one in every dimension that matters — **warm cream paper instead of black**, an **editorial serif**
instead of a geometric sans, **hand-drawn energy** instead of a product-lit void. So this is not a
re-skin of pass J: the palette, the type system and the hero's signature move were all replaced.

### K1. What the reference actually does (from two live screenshots)

| The reference | Crewly now |
| --- | --- |
| Cream `#FCFAEC` canvas, near-black ink, warm shadows | Same paper and ink; the app's own night tokens are untouched, because the product is unchanged |
| A thin **forest-green strip** at the very top carrying one headline | A forest strip carrying a shipped fact: *“PF, ESI, professional tax and TDS are computed in the run.”* |
| A **floating white pill** nav with an ink-outlined lilac button | Same: white/60 pill, ink hairline, lilac CTA with a hard offset shadow |
| One **serif headline** where the first clause is greyed and the second is black italic | `Don't chase HR, *just close the month.*` — same construction, same two-tone |
| A **lilac pill** CTA, then one quiet line of availability under it | Same, and the line is `HERO.availability`, kept separate from the assurances |
| **Transcript ribbons** curving across the fold, raw beside cleaned-up, with a waveform pill where they cross | Two SVG `<textPath>` ribbons — the mess an HR desk receives (`…the payroll sheet says 9 days but HR said 11…`) beside the record it ends up with — and a 12-bar waveform pill between them |
| Small hand-placed chips | `.landing-sticker` badges, now paper-white with ink outlines |

New tokens: `crewly-ink #14110e`, `crewly-forest #0b3b2e`, `crewly-lilac #e6ccff`,
`crewly-lilac-deep #c9a6f0`; `crewly-void` is now `#fcfaec`. New primitives: `.landing-serif`,
`.landing-ribbon-raw`, `.landing-ribbon-clean`, `.landing-wave-bar`.

### K2. Two decisions worth recording

1. **No webfont.** The reference's serif is a licensed typeface and the sandbox cannot reach
   `fonts.googleapis.com` (verified: the request fails, and the page logged a network error while
   it was linked). The page therefore ships a **system editorial stack** — Iowan Old Style →
   Palatino → Georgia — and renders identically to its intent on macOS, Windows and Linux. A
   linked font would have meant a flash of fallback at best and a console error at worst.
2. **The product mock stays dark.** Every other pixel is paper, but `ProductWindow` is a drawing of
   the app, which ships a night theme. Re-skinning it cream would be a picture of a product that
   does not exist. The test now asserts exactly that: every landing file is paper *except* the
   mock, and the mock keeps the app's emerald/violet.

### K3. Bugs this pass produced, and the fixes

1. **Two stickers landed on the flowing text** at 1024px, where the hero has no gutter. Stickers are
   now `xl`-only, and the two ribbon chips are pinned to the ribbon block's own corners.
2. **`href="#crewly-ribbon-raw"` tripped the anchor pin.** It is an SVG `<textPath>` target, not a
   destination; the scanner now allows `crewly-*` ids.
3. **A too-long headline made four short lines** at 1440. The clamp's `vw` term was reduced
   (7.4 → 6.4) and the headline's measure widened to `max-w-5xl`; it is two lines again at 84px.
4. **The pricing badge became a lie.** “Most teams start here” is a popularity claim with no source
   in this repository; it now reads “Includes hiring & performance”, which is what the plan
   actually contains. The featured card's border and wash also stopped being emerald.

### K4. Evidence

* `npm test` (Frontend) → **454 / 0 fail**; `landingPage.test.js` → 34 pins (a ribbon/waveform pin
  was added, and the surface pin now asserts paper + ink + lilac + forest tokens, the serif scale,
  and that no emerald/violet/slate survives outside the app mock).
* `npx eslint src/pages/landing src/routes/AppRoutes.jsx test/landingPage.test.js` → clean.
* `npm run build` → 1.35 s; `LandingPage` **75.46 kB / 18.76 kB gzip**; `index-*` unchanged.
* Computed in Chromium: `h1` is 84px in **Iowan Old Style** at weight 400 (no synthetic bold);
  `landing-glow-breathe`, `landing-wobble`, `landing-pop, landing-float`, `landing-ribbon-drift`,
  `landing-wave` (bars reading scaleY 0.90 / 0.98 / 1.00, i.e. actually out of phase) and
  `landing-marquee` all run; under `prefers-reduced-motion: reduce` every one is `none` and the
  reveals are `opacity: 1`.
* 1440 / 1024 / 390: `scrollWidth === innerWidth` at all three, zero console errors.

**Still not owner-accepted on taste.** The palette and the type are the owner's call; everything
above is measured.

### K5. The footer was the longest thing on the page

The owner was right, and the screenshots showed why: five stacked blocks (brand, four link columns,
a full support panel, a legal row, a colophon row) above a **350px wordmark** came to **891px** —
taller than the hero's own summary and about as tall as the pricing band.

What changed:

* the five blocks became **three**: brand + columns, one support strip, one bottom bar
  (copyright · the honest legal note · back to top — the separate colophon row is gone, its
  credit line folded into the copyright line);
* the brand column lost its trial pill (the trial line now sits under the CTA as plain text);
* the support panel became a single-line strip with the link inline;
* **the wordmark is now the same face at `clamp(3rem, 11vw, 6.5rem)` and 8% ink, shown whole.**
  Cropping the giant version to a 68–108px band was the other half of the problem: it looked like
  a broken image. A smaller wordmark, fully visible, is both shorter *and* legible.

Measured: **891px → 512px at 1440**, 530px at 1024, and the mobile footer is now 1001px instead of
~1400px. Everything else on the page is untouched: `npm test` → 454 / 0, eslint clean, and
`scrollWidth === innerWidth` at 1440 / 1024 / 390.
