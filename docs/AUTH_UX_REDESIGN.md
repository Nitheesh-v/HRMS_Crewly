# Auth & Onboarding UX Redesign (Figma reference)

**Status:** implemented, frontend gates green, **owner localhost acceptance not yet run.**
**Scope:** the four auth screens (login, register, forgot, reset) rebuilt around the
Figma "Authentication & Onboarding" export — dark and light — without touching the
backend, adding packages, or introducing app-wide theming.

Phase numbering is deferred to the owner (38 and 39 are already implemented phases;
the next free number is 40). The Helpdesk unit follows in a later batch.

---

## 1. What the Figma showed and what shipped

| Figma element | Decision | Why |
| --- | --- | --- |
| Centered single column: logo → headline → labelled fields → remember/forgot row → full-width primary → accent link → footer | **KEPT** | Directly supports the auth flow; matches Crewly's `max-w-md` conventions |
| Accent focus ring, green check on valid email, red border + inline icon message on error | **KEPT** | Real, useful states; the check is a client-side format hint only |
| Dim-disabled primary until the form is valid | **KEPT** | Matches existing `canSubmit` gating |
| Password eye toggle | **KEPT** | Reuses `PasswordField` (also Caps-Lock hint) |
| Dark palette (phones) + light palette (light strip) | **KEPT, adapted** | Token layer: `.auth-root` defines dark custom properties by default; `[data-theme="light"]` redefines them. Toggle (Sun/Moon) persists `crewly.theme`. Scoped to the auth subtree — the other 140+ files are untouched |
| "HRDashboard" brand, "© 2025 … Alrights reserved" | **REMOVED** | Truthful branding: Crewly logo + wordmark, dynamic year, correct spelling |
| Google / Apple buttons + "Or login/register with" dividers | **KEPT, DISABLED** | Owner asked for image parity; no OAuth exists in the backend, so the buttons render disabled with a "soon" chip and an explanatory tooltip — never faked (§20 option B) |
| "Remember Me" | **ADAPTED** | Existing identifier-only remember (company code + email in `localStorage`, never the password) |
| Email-only login form | **ADAPTED** | Backend `POST /auth/login` requires **company code + email + password** — the company code field stays |
| Error copy "The email you entered is not registered…" | **REMOVED** | Backend deliberately returns a generic 401 to prevent account enumeration. The screen renders the backend message verbatim in the Figma red presentation |
| Sign-up: Name / Work Email / Password | **ADAPTED** | Real contract is company name + your name + work email + password — the backend has no confirm-password field, so v2 dropped it; truthful "Get started for free today!" copy (`TRIAL_DAYS = 14`) |
| Figma typos ("Iinput", "employess", "Alrights") | **REMOVED** | Truthful copy rule |

### 1.1 V2 — image-faithful pass (owner: "i want same like in the images")

- Copy verbatim from the art, typos corrected: "Login first to your account", "Remember Me",
  "Forgot Password", "You're new in here? Create Account", "Manage employees easily starting
  from now!", "Get started for free today!", placeholder "Input your registered email".
- Login logo centered (the art centers it); signup logo left as in the art.
- Disabled Login / Create Account renders as the art's muted slab with dim text
  (`--auth-btn-disabled-*`), not a faded white button.
- Login field order follows the art (Email Address, Password, Remember Me / Forgot Password
  row, Login button); the backend-mandatory Company code sits above them as the single
  extra field the API requires.
- Confirm-password dropped from signup (backend `register-company` takes exactly
  `{ companyName, adminName, email, password }`).

### 1.2 V3 — security screens batch (forgot / reset / success)

- **Forgot** (`/forgot-password`): centered themed column; Company Code + Registered
  Email (backend contract — the Figma shows email only); generic anti-enumeration
  success line in a green `role="status"` banner; single "Back to Login" (the Figma's
  duplicate button pair removed); 30-minute expiry note kept.
- **Reset** (`/reset-password`): Figma's requirements-checklist pattern kept, but the
  items are the real `PLATFORM_MINIMUMS` — 10 characters, upper, lower, number,
  special (`Backend/src/utils/securityPolicy.js`) — not the artwork's 8-char list.
  The same shared checklist (`components/auth/PasswordRules.jsx`) now also renders on
  signup, which previously suggested a wrong "6 characters" minimum the server
  rejects. Submit stays gated on token + all rules + confirmation.
- **Success card**: Figma's celebration rebuilt with lucide icons (Sparkles + Check in
  a green ring/white core) — the old emoji confetti (🎉✨) is gone (§8). Copy grammar
  fixed: "You've successfully changed your password".
- **Deferred with reasons:** OTP Verification screen (reset is token-link based; no
  OTP endpoint exists), the 4-step onboarding wizard (no backend fields for company
  size / industry / role / purpose — collecting and discarding them would be fake),
  and the Home V1/V2 dashboard + welcome popup (rebuilding the app shell would break
  Crewly's role-aware navigation and replace a real-data dashboard with the Figma's
  fabricated stats — §6/§19/§27).

### 1.3 V4 — desktop split composition (from the light + dark desktop art)

- Login (lg+): left panel = the repo's approved `login-hero.jpg` above a navy brand
  block (logo, "Let's empower your employees today.", truthful one-line feature
  summary). Navy stays fixed in both themes, per the art.
- Register (lg+): form left, emerald panel right with the CSS dashboard preview.
  The preview's values are ILLUSTRATIVE and the block is `aria-hidden` — the same
  convention as the landing page's `DashboardPreview`; the pre-redesign fabricated
  testimonial remains removed and the "👋" is gone.
- Mobile keeps the centered single column; the theme toggle is present at every
  breakpoint.

## 2. Removed from the OLD Crewly auth shell (truth rules)

- Fabricated testimonial ("Katie Waters, Head Resource Management · Fintech Company").
- Fake-stat dashboard ("Total Employees 3,540", "+28.5%", "Hi, Priya 👋") — invented
  usage numbers and an emoji.
- Hero stock photo side panel.
- Dead "Terms & Conditions / Privacy Policy" footer spans (pages do not exist).

## 3. Files changed

- **Modified** `Frontend/src/style.css` — auth token layer (dark default + light override),
  token-driven `.auth-input/.auth-primary/.auth-secondary`, label/required/checkbox/eye/
  banner/toggle classes. Old unused `.auth-wave-bg` removed.
- **Modified** `Frontend/src/layout/AuthLayout.jsx` — clean themed shell + toggle + footer;
  legacy `variant/headline/quote` props accepted and ignored so `ForgotPasswordPage` and
  `ResetPasswordPage` work unchanged with zero edits.
- **Modified** `Frontend/src/pages/login/LoginPage.jsx` — Figma shell, inline verbatim
  server error, valid-email check icon, remember row + forgot link.
- **Modified** `Frontend/src/pages/register/RegisterCompanyPage.jsx` — same treatment with
  the full register-company contract.
- **Modified** `Frontend/src/components/auth/PasswordField.jsx` — eye/caps/counter colours
  moved to theme tokens.
- **Added** `Frontend/test/authUxRedesign.test.js` — source pins (contract, no password in
  localStorage, no social login/fake proof/emoji, verbatim 401, theme palettes, gating, a11y).
- **Added** `docs/AUTH_UX_REDESIGN.md` — this record.

## 4. Deferred (needs backend work / later units)

- Social sign-in (Google/Apple) — no OAuth in the backend.
- Session-length "remember me" — needs backend support; current remember is identifier-only.
- App-wide light theme for the authenticated app (140+ files carry hardcoded surfaces).
- OTP verification screen — the reset flow is token-link based; no OTP endpoint.
- 4-step onboarding wizard (company size / industry / role / purpose) — no backend fields.
- Home/dashboard V1-V2 + welcome popup — Crewly keeps its role-aware shell and real-data dashboard.
- Helpdesk screens — next Figma batch.

## 5. Gates

- `npm test` (Frontend) — all source-pin suites incl. `authUxRedesign.test.js`.
- `npm run build` — vite production build.
- `npm run lint` — must not grow the repo baseline (139 problems at this branch tip).
- Backend unchanged — no backend gate needed.

## 6. Owner localhost acceptance (Windows PowerShell)

```powershell
cd C:\Users\megal\Desktop\HRMS
git fetch origin
git merge --no-edit arena/5990b69a-hrms-crewly   # or pull the session branch
cd Backend  ; npm run dev      # terminal 1 (port 5000)
cd Frontend ; npm run dev      # terminal 2 (port 5173)
# browser: Ctrl + Shift + R on http://localhost:5173
```

Walkthrough: `/login` (dark) → toggle Sun/Moon top-right → `/register` in light →
submit empty (button disabled) → type a valid email (green check) → submit with a wrong
company code (inline red banner with the backend's generic message) → "Forgot password?"
and "Create an account" navigate to the real routes; forgot/reset render in the new shell.
