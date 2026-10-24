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

## G. REDESIGN — Keka-shape, Crewly-brand (2026-10-24)

Owner request: *“analyze repo … based on that build a public home page like keka.com.”*
A presentation unit on the public marketing surface (`/`) only. No auth, API, data-model
or backend change. The previous version (§F) was a dark, single-column page; this one is
a **light marketing surface** and the structure follows the way keka.com sells the
category, section by section.

### G1. What was taken from keka.com, and what was not

| Keka section | This page | Why |
|---|---|---|
| Announcement bar | **Yes** — the AI assistant + language facts, dismissible for the session | something that genuinely ships |
| Mega-menu header | **Yes** — a six-item “Platform” panel that opens the matching tab | real product areas |
| Hero + product screenshot | **Yes** — CSS-built dashboard mock (no image asset, no client data) | Keka’s hero is a screenshot |
| “Chosen by 12,500+ companies” logo wall | **No** | **no customers exist in this repo**; inventing them is the one thing a marketing page must not do. Replaced by an honest capability strip + a facts marquee (browser, QR, kiosk, CSV import, PDFs, AI). |
| “One platform” tabbed deep-dive | **Yes** — 6 ARIA tabs, each with copy + a product mock | the centrepiece of the page |
| AI layer (3 behaviours) | **Yes** — violet→teal band, illustrative conversation labelled as such | assistant, languages, guardrails are all implemented |
| Integrations wall (100+ tools) | **No** | no integration catalogue exists in the codebase |
| SOC2 / ISO / GDPR badges | **No** — explicit “we do not claim certifications we have not been audited for” | no audit exists |
| Testimonials / customer quotes | **No** | none exist |
| Pricing | **Yes** — the four real tiers, monthly/yearly, arithmetic “2 months free” | pinned to `platformPlans.js` |
| FAQ | **Yes** — 8 questions incl. trial, tenancy, roles, languages, CSV import | |
| Deep footer | **Yes** — 4 columns + support panel + honest legal note | no dead legal links |

Sections in order: announcement → header → hero (badge, h1, sub, 2 CTAs, assurances,
dashboard mock, floating cards, facts marquee) → capability strip → **Platform** tabs →
**Modules** (20, five groups) → **AI** → **How it works** (3 alternating rows) →
**Roles** (the five shipped roles) → **Security** (6 implemented controls) → **Pricing**
→ **FAQ** → CTA → footer.

### G2. Design system (new, page-scoped)

The logo is a violet→indigo mark around a deep-navy wordmark, so the marketing surface
uses the brand’s own colours instead of the app’s dark slate/emerald shell:

* tokens in `src/style.css` `@theme`: `crewly-ink`, `crewly-ink-soft`, `crewly-violet`,
  `crewly-lilac`, `crewly-lilac-line`, `crewly-mint` (+ the existing ones untouched);
* page-scoped classes: `.landing-shell`, `.landing-grid`, `.landing-aurora`,
  `.landing-card`, `.landing-preview`, `.landing-hairline`, `.landing-marquee-track`,
  `.landing-wordmark`, `.landing-mark`;
* paper-white canvas, violet primary CTA (`from-violet-700 to-[#4c1d95]`), mint tick
  colour, `rounded-2xl`/`rounded-3xl`, hairline borders, one soft shadow per card;
* motion is opt-in (`prefers-reduced-motion: no-preference`) and the marquee pauses on
  hover.

Two global CSS facts had to be handled, both are recorded in `style.css`:

1. the unlayered `h1/h2/h3` responsive scale **outranks Tailwind’s `text-*` utilities**,
   so it now excludes `.landing-shell` — otherwise every marketing headline was clamped
   to 1.875rem;
2. the unlayered `img { max-width:100%; height:auto }` reset outranks Tailwind’s height
   utilities, so the logo crops are sized by `.landing-wordmark` / `.landing-mark`.

### G3. Files

| File | Change |
|---|---|
| `src/pages/landing/landingData.js` | **rewritten** — every section’s content in one JSX-free module (announcement, nav, hero, facts, trust chips, 6 platform tabs, 20 modules, AI layer, 3 workflow blocks, 5 roles, 6 security points, 4 plans, 8 FAQs, 4 footer columns, legal note) |
| `src/pages/landing/LandingHeader.jsx` | **rewritten** — announcement bar (session-dismissible) + sticky header with a real mega-menu (anchored to the nav so a 56rem panel always fits), auth-aware CTA, mobile menu with a nested Platform disclosure |
| `src/pages/landing/LandingFooter.jsx` | restyled for the light surface; 4 columns + support panel + legal note + back-to-top |
| `src/pages/landing/DashboardPreview.jsx` | **rewritten** — light product mock: sidebar, stat tiles, 7-day attendance chart, approvals, chips |
| `src/pages/landing/PlatformPreview.jsx` | **new** — the six tab mocks (payroll, people, hiring, attendance, performance, collaboration) |
| `src/pages/landing/landingTabs.js` | **new** — one DOM CustomEvent so the header menu can open a tab without a context or a query param |
| `src/pages/landing/LandingIcon.jsx` | extended registry (26 keys) |
| `src/pages/landing/sections/*.jsx` | Hero, **CapabilityStrip**, **Platform** (ARIA tablist), Modules, **AI**, Workflow, **Roles**, Security, Pricing, FAQ, CTA |
| `src/pages/landing/LandingPage.jsx` | composes 11 sections; sets `document.title` and restores it on unmount |
| `src/routes/AppRoutes.jsx` | `/` moved **out of** `PublicLayout` — nesting it rendered two headers and two footers on the marketing page |
| `public/logo-crewly-wordmark.png`, `public/logo-crewly-mark.png` | **new** — the square logo (with its baked-in wordmark) trimmed into a lockup and a mark for the light header/footer |
| `src/style.css` | light landing layer + the two global-CSS carve-outs above |
| `Frontend/test/landingPage.test.js` | **rewritten** — 29 pins (see G5) |

### G4. Two bugs found by rendering it in a real browser

Neither would have failed a test, and both were only visible in a screenshot:

1. **`transition-all` killed the focus ring.** Tailwind’s `transition-all` animates
   `outline-width`/`outline-offset`, and the app’s global `prefers-reduced-motion` rule
   collapses durations to `0.01ms` — measured in Chromium, the ring stayed at
   `outline-width: 0px`. Every landing control now transitions an explicit list
   (`transition-[color,background-color,border-color,box-shadow,transform]`) and the ring
   paints at 2px violet.
2. **The hero accent underline was absolutely positioned.** On a phone the accent wrapped
   over two lines, so the bar drew under the last line only and the full stop sat alone on
   its own row. The accent is inline again; `.35`-style sizing is gone.

Also fixed while looking: percentage heights in the mock’s sparkline had no definite parent
(rendered as an empty box) — they are pixel heights now; the role cards go `3 → 5` columns
only at `xl` so names never break mid-word; the platform panel gets `mt-10` when it stacks
on mobile; hero halos are inside `isolate` stacking contexts so `-z-10` cannot paint under
the white shell.

### G5. Test plan — 29 pins, mostly against sources of truth

Kept from §D and extended: prices vs `platformPlans.js`; trial vs `TRIAL_DAYS` (and the
digits `14` may not be typed into markup — a length change must not leave a stale button);
“2 months free” vs the arithmetic; “no credit card” vs the register form; **roles vs
`ROLE_LABELS`** (all five, both directions); **AI language counts vs `chatLanguages.js`**
(14 platform / 5 default); module inventory unchanged at 20 across 5 groups; every anchor
resolves to a rendered section id; every link resolves to a route in `AppRoutes.jsx`; the
landing route is **not** nested in `PublicLayout`; no fabricated social proof (incl.
“Chosen by”); no compliance badges; ARIA tablist keyboard contract (arrows, Home, End,
`aria-selected`, roving `tabIndex`); mega-menu and mobile menu `aria-expanded`; FAQ
disclosure; pricing toggle; announcement dismiss label; reduced-motion guard; visible
focus style on **every** `Link`/`a`/`button` in the landing files (shared class constants and
`${…}` interpolations are resolved, not exempted); light-surface consistency (no
`#0b1120` left in the landing files).

### G6. ARIA detail worth keeping

`aria-controls` must name an element that exists, so the desktop Platform panel and both
mobile panels stay mounted and are toggled with the `hidden` attribute instead of being
conditionally rendered — a conditional panel left the trigger pointing at nothing for most
of the page's life. Verified in Chromium: `display:block` when open, `display:none` after
Escape, after an outside click, and after choosing an item.

### G7. Evidence

* `npm test` (Frontend) → **449 / 0 fail** (420 existing + 29 landing). Backend untouched.
* `npm run build` → the page is still its own lazy chunk (`LandingPage-*.js` ≈ 96 kB /
  22 kB gzip); `index-*.js` unchanged at ≈ 434 kB, so the app shell did not absorb it.
* `npx eslint src/pages/landing src/routes/AppRoutes.jsx test/landingPage.test.js` → clean.
* Rendered in headless Chromium at 1440×900 and 390×844: no console/page errors, no
  horizontal overflow at either width; mega-menu inside the viewport; choosing a menu item
  selects the matching tab **and** scrolls to it; ArrowRight moves the tab and keeps focus
  on a tab; Escape closes the menu; the pricing toggle swaps to ₹9,990 / ₹24,990 / ₹49,990
  with “2 months free”; the announcement stays dismissed after a reload in the same session.
* `document.title` = “Crewly — HR, payroll and attendance in one workspace”; `h1` computed
  at 65.6px on desktop and 36px on a 390px viewport (proving the global h1 carve-out).

### G8. Deliberately not built

Customers, logos, testimonials, usage counts, certification badges, an integrations wall,
and Privacy/Terms pages. None of them exist in this repository; the footer states that the
legal pages are unpublished instead of linking to nothing. Adding any of them is a content
decision that needs a real source, not a design change.

**Not owner-accepted.** The render and interaction checks above are automated; the design
judgement remains the owner’s.
