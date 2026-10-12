# HOME DASHBOARD — DESIGN-FIDELITY REBUILD (audit + one plan)

Owner request: *"there is figma dark and figma light built both mode, and some pages are
not built yet, so build whatever we have built and put UI for that, and also i want
exactly what is in this."* — i.e. rebuild the frontend UI layer to match the supplied
Figma, **both themes**, starting with the **Home dashboard**.

Reference set: Google Drive → `figma hrms` (4 sub-folders of PNG exports,
≈90 screens × 2 themes). This is a **presentation unit**: no API, model, route or
permission change.

Status: **AUDIT COMPLETE — implementation blocked on getting the reference PNGs into
the repository** (see §F).

---

## A. REPOSITORY FINDINGS (verified, with evidence)

| # | Finding | Evidence |
|---|---|---|
| A1 | **The design assets are not in the repo.** No `figma`/`design` asset of any kind exists. `Frontend/public/` = `favicon.png`, `favicon.svg`, `icons.svg`, `logo-crewly.png`; `Frontend/src/assets/` = `login-hero.jpg` only. The reference screens live only in Drive. | `find . -iname '*figma*'` → empty |
| A2 | **The app is dark-only.** `Frontend/src/style.css` `@theme` declares 9 **static** `--color-crewly-*` values — bg `#0d1117`, card `#161b22`, border `#30363d`, text `#e6edf3`, dim `#8b949e`, green `#3fb950`, orange `#f0a35e`, red `#f85149`. There is no `.dark` variant, no theme toggle, no theme context/slice, and `index.html` `<html>` carries no theme class. | `style.css:1-13`; grep for `dark`/`theme` in `App.jsx`, `main.jsx`, `AppLayout.jsx` → none |
| A3 | **The theme is already fully tokenised.** 3,560 `crewly-*` usages across **145 files**; only **12** hardcoded `bg-[#…]` literals in the whole app. | `grep -ro 'crewly-[a-z]*' src \| wc -l`; `grep -ro 'bg-\[#…\]' src \| wc -l` |
| A4 | **A3 is the decisive fact.** Because every screen already styles through semantic token names, light mode is a **token-layer change + per-screen corrections**, *not* a 145-file rewrite. The edit surface is `style.css`, a theme controller, and the handful of screens with palette literals. | A2 + A3 |
| A5 | **Home today**: `pages/dashboard/DashboardPage.jsx` (628 lines) with local `StatCard`/`Panel` helpers, a `WORK_LOCATION_STYLE` map, `SENIORS` role gate. Data comes from `dashboardService` (selfService), `attendanceWeeklyTargetService`, and the presence slice — **no new data is required** to redraw this page. | file read |
| A6 | Route/shell: `/app` → `AppLayout.jsx` (684 lines) + `SidebarNav.jsx` (835 lines). Both are token-styled, so both repaint for free once tokens become themeable. | `routes/AppRoutes.jsx`, layout files |
| A7 | **Conventions to keep**: hermetic `node:test` suites in `Frontend/test/*.test.js`, `npm run build` (vite), `npm run lint`; docs ship in the same commit as the behaviour change. | `package.json`, README |
| A8 | Repo working tree is 20 MB; `.gitignore` does not exclude a `design/` folder. ~40 MB of reference PNGs is acceptable to version once. | `du -sh`, `.gitignore` |

## B. WHAT THE FIGMA DEFINES FOR HOME

| Screen | Light-mode file id | Dark-mode file id |
|---|---|---|
| 14. Home — V1 — Skeleton Loading | `1X1hqcjCyfNTBkhnUhR4YrMpDGf3wwqEG` | `1gHlHdxc1MjywRFq8mrk8vYK9_q6_pS_I` |
| 15. Home — V1 | `1qtKWv7t3d6bDcgXixZjdA59JvoKWTpLH` | `1Ic8QMSjVleKYyieywptXYafG3xDw_7XI` |
| 16. Home — V2 — Skeleton Loading | `15oLlmjk_d14NJtaAnjlg0ynFuDJFQMxi` | `1H_xoxX-HKyrn_oo7v14VjVVvGkqYXk8H` |
| 17. Home — V2 | `1z9yIXWp8TkdW4eMpmiXNiBAJrF0cyjJZ` | `10lqcFpEG5pFMZWnGNwnBpbnBtRbQK29D` |
| 18. Home — V2 — Popup — Welcome App | `1wOUO7xm1nsAoYqF5QbQeUe8I9V27j47F` | `1tvoAPu_mcR1ECSLlFmruRbEnRWZzFWoo` |

Full-resolution masters of the same screens live in `FIGMA DESIGN/` (`17. Home — V2.png`
= `1BRLmIEWHkn-OU4PKP-rxWXE1BSI-XR1d`) and `figma dark/` (= `102R40V9lfAPuR_05NX1NeaaRwmYcF-ps`).
The two `res` folders are the lighter-weight exports and are the ones to read for layout.
**V1 and V2 are two distinct dashboard compositions, not two breakpoints** — both ship.

## C. THE PLAN (one)

**Phase 0 — reference set into the repo.**
`design/figma/{light,dark}/…` containing the PNG exports. This becomes the visual source
of truth the work is checked against, and it is reusable for the remaining ~85 screens.

**Phase 1 — theming foundation (makes "both modes" one job, not two).**
* Rewrite the `@theme` block as **semantic tokens backed by CSS variables**: `:root`
  holds the light values, `.dark` overrides with the dark values, and the `crewly-*`
  names stay identical — so all 145 files keep compiling untouched (A3/A4).
* `ThemeProvider` + `useTheme`: `light | dark | system`, persisted at
  `crewly.theme`, defaulting to `prefers-color-scheme`, with an inline pre-paint script
  in `index.html` so there is no flash of the wrong theme.
* Toggle in the app header (and on the auth layout, which sits outside `AppLayout`).
* Colour-scheme meta + `color-scheme` CSS so native controls/scrollbars follow the theme.

**Phase 2 — Home rebuilt to spec**, screen 15/17 exactly, in both modes: shell, greeting
header, stat cards, panels (today's attendance, weekly target, presence, announcements),
lists/tables, empty and error states.

**Phase 3 — skeleton states**, screens 14/16, as reusable `Skeleton` primitives — not
spinners — driven by the same loading flags the page already has.

**Phase 4 — the Welcome popup**, screen 18.

**Phase 5 — tests + docs.** Home renders both themes (asserting the token contract, not
pixel colours); toggle persistence; skeleton→loaded transition; `DashboardPage` data
wiring unchanged. Update `docs/DESIGN_FIDELITY_HOME.md` and the current capsule.

## D. BOUNDARIES

* **No API, model, route or permission changes.** The page redraws onto the exact data
  contract `dashboardService` already returns (A5).
* **No new dependencies** — Tailwind v4 + `lucide-react` only.
* **Do not lose functionality to match a mock.** Where a live feature has no Figma
  frame, it keeps working and inherits the new tokens rather than being deleted.
* Both themes are verified for every screen, not just the one that "looks right".

## E. RISK

| Risk | Mitigation |
|---|---|
| Token change repaints all 145 files at once | Land Phase 1 as its own commit with a build + lint + full frontend suite before any page work; the 12 hex literals are audited by hand |
| Design and live data disagree (a card in Figma has no real source) | §D — functionality wins, styling follows; flagged per screen in the close-out report |
| Screens in Figma that have no route today | They are the "not built yet" list in the request; built after the existing surfaces are matched |

## F. THE ONE BLOCKER

The reference PNGs are in Drive; the agent sandbox has **no network route to Google**
(verified: `drive.google.com`, `googleapis.com` and even `example.com` all fail from the
shell — only GitHub/npm/PyPI are reachable). The Drive connector can return a file's
bytes, but inline to the model, which is not a workable path for ~90 screens.

**Unblock — either of these:**
1. Drive → download `figma hrms` as ZIP → drag the PNGs into `design/figma/{light,dark}/`
   in this repo (GitHub web upload). Best: the whole design set is then versioned with
   the project and every remaining screen is a local file read.
2. Attach the Home screens (15/17 light+dark, plus 14/16/18) to the chat — they land in
   the workspace directly and Phase 0–2 can start immediately.
