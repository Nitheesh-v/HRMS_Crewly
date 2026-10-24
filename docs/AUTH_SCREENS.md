# AUTH SCREENS — the signed-out surface

Login, register, forgot-password, reset-password and setup-account. Four routes,
one shell (`src/layout/AuthLayout.jsx`), one set of controls (`style.css` §Auth).

## 1. The reference, and what was taken from it

The owner pointed at a dark sign-up screen: a warm charcoal canvas, a serif
`Create Account` headline, a clay-coloured inline link under it, near-black
inputs with a faint hairline, one high-contrast button, and — on the other half
of the screen — a hand-drawn scene of a chunky monitor on a paint-spattered lily
pad with two little winged houses floating above it.

| The reference | Crewly |
| --- | --- |
| Warm charcoal `#232120`, not blue-black | Same, with two faint radial washes (clay top-left, lilac top-right) |
| Serif display headline | The same system serif as the marketing page (`Iowan → Palatino → Georgia`), no webfont |
| Clay/terracotta for every link | `#e8a487`, the only warm accent on the screen |
| Dark fields, thin borders | `.auth-input`: cream at 3.5% fill, 16% border, lilac focus ring |
| A white primary button | `.auth-primary`: cream fill, ink label |
| A sketch on the right half | `AuthArt.jsx` — inline SVG, cream strokes, the palette's paint dots |
| Two winged houses | Two winged *cards*: a leave approval and a payslip, because those are what an HR desk actually sends |

Everything is drawn with paths: no image request, no font fetch, nothing to fail.

## 2. Three things the reference has that this product cannot

These are deliberate omissions, and `Frontend/test/authScreens.test.js` pins them:

1. **“Sign up with Google.”** There is no OAuth provider anywhere in
   `Backend/src` — no controller, no route, no client id. The button would be the
   most prominent control on the page and it could not work. The test fails if
   the string `google` appears in any auth page, and it also fails if a Google
   controller is ever added to the backend without this pin being revisited.
2. **The testimonial panel.** The old split layout quoted “Katie Waters, Head
   Resource Management · Fintech Company”. No such customer exists in this
   repository. The panel is gone; the sketch took its place.
3. **A consent line naming Terms and a Privacy Policy.** The register screen used
   to say you agree to documents that were never published. It now says what the
   trial actually is: `14-day trial · no card at signup · cancel into read-only,
   nothing deleted`. The footer states plainly that the legal pages are not
   published yet, and links nothing.

## 3. What changed structurally

* **`PublicLayout` no longer draws chrome.** It used to wrap the auth routes in a
  dark app bar (“Crewly HRMS” + green buttons) and a footer, so every sign-in
  form had a second header above it. It is now a pass-through; `AuthLayout` owns
  the whole viewport. The landing route already lived outside it for the same
  reason.
* **One shell for all four screens.** `variant="split"` (login/register) or
  `variant="centered"` (forgot/reset/setup). `visualSide` still flips the scene
  for a future layout experiment.
* **The dashboard-preview illustration and the marketing photo are gone**
  (`src/assets/login-hero.jpg` was deleted; the mock dashboard carried invented
  numbers — “3,540 employees” — on a page that otherwise refuses to invent any).

## 4. Bugs found while building it

1. **Headlines were silently capped at 30px.** The app's unlayered
   `h1:not(.landing-shell h1) { @apply text-3xl }` outranks Tailwind utilities, so
   `text-[44px]` never applied. `.auth-shell h1` is now excluded the same way the
   landing surface is.
2. **The “keep me signed in” checkbox painted as a white square.** Native
   controls follow the OS theme; `.auth-shell` now declares `color-scheme: dark`.
3. **The illustration's wings pointed into their own cards.** The flipped wing was
   rooted on the wrong edge, so both fans hid under the card. Wings are now rooted
   *outside* the card edge and drawn as two feathers.
4. **The disabled primary was a grey slab.** It is now a 14% cream ghost, which
   reads as “not yet” instead of “broken”.

## 5. Evidence

* `npm test` → **462 / 0 fail** (7 new pins in `test/authScreens.test.js`).
* eslint clean on every touched file; `npm run build` → 1.08 s.
  `LoginPage` 4.89 kB, `RegisterCompanyPage` 5.33 kB (lazy chunks).
* Chromium at 1440 / 1024 / 768 / 390: `scrollWidth === innerWidth`, zero console
  errors. Heading measured at **44 px in Iowan Old Style**; input focus border
  `rgba(230,204,255,0.75)`; the three floating groups animate as `auth-float` and
  become `none` under `prefers-reduced-motion: reduce`.
