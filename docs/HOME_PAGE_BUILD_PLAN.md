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
