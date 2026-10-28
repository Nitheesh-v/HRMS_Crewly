# Theme

The tenant app ships two palettes and one switch between them. Both are the
owner's palette, used as named: nothing is `#ffffff` and nothing is black.

| Theme | Canvas | Card | Sidebar | Selected | Action | Ink |
| --- | --- | --- | --- | --- | --- | --- |
| `dark` (default) | `#1a2b27` | `#21332c` | `#152420` | olive at 16% | `#c97f42` clay | `#edefd9` |
| `light` | `#eef3e6` | `#f8fbf1` | `#2a322b` | `#f2f7a0` in content, `#db9558` on the rail | `#db9558` clay | `#1e2c24` |

The light theme is **sage paper**, not butter-cream: the page is the day side of
the pine rail, so the two themes read as one brand at two exposures. The palette
card in `docs/assets/theme-light-sage-paper.png` shows the surfaces, ink and
action colours with their measured ratios.

| Named | Where it goes | Why |
| --- | --- | --- |
| `#EEF3E6` | the canvas, in every surface | green-tinted paper: 238/243/230, so blue is the lowest channel and it is never a grey |
| `#F8FBF1` | cards, header, modals, input wells | the lightest surface; never `#ffffff` |
| `#F2F7A0` | the active tab, the selected option, the MANAGER chip | "where you are" on paper — the rail's own selected row is clay (below) |
| `#2a322b` | the rail, in both themes | the reference's pine: navigation is the fixed spine, the page is the lit surface |
| `#97A87A` / `#A8BBA3` | sage fills, chart halves, illustration accents | 2.3:1 and 1.8:1 on paper, so **fills only** |
| `#DB9558` | the one primary action per screen | 2.4:1 on paper and 2.5:1 against white type: fills only, with pine type on top |
| `#1a2b27` `#8E9162` `#B2BD7E` `#D9D28B` | night surfaces, dim text, olive type, gold type | 7.4:1 and 9.5:1 on pine; `#8E9162` is 4.5:1 — dim text only |

Two of those rules are the whole point of the scheme: **a page of white cards is
not a light theme**, and **a mid-tone is a surface, not a text colour**. Where a
named colour could not carry type it became a fill with dark pine ink on it, and
the label colour moved to its own darker token (`#8f5a1f` clay-brown, `#4f6a37`
olive, `#a8492f` red). Every contrast number below is computed, not guessed, and
`test/theme.test.js` re-computes them from these hexes.

## How it works

One attribute on `<html>`:

```html
<html data-theme="light">
```

`dark` is the default and is written as *no attribute* — `<html>` with nothing on
it is the night theme. Everything else is CSS custom properties that Tailwind
v4's utilities already read, so no component knows which theme is on:

```
src/style.css  @theme                  dark values (the source of the tokens)
src/style.css  12b) App light theme    html[data-theme='light'] { …overrides }
```

| File | Role |
| --- | --- |
| `index.html` | Inline `<head>` script: reads `localStorage["crewly-theme"]` and sets the attribute **before the first paint**, so a light-mode reload never flashes dark. |
| `src/utils/theme.js` | Storage key, the two names, `getTheme`/`setTheme`, the `storage` listener that keeps tabs in sync. |
| `src/hooks/useTheme.js` | `useSyncExternalStore` over that module: `{ theme, isLight, setTheme, toggleTheme }`. |
| `src/components/common/ThemeToggle.jsx` | The header button. Shows the theme you are in; its label names the action. |

Nothing else stores theme state — one module, one attribute, one control.

## Using the palette in a component

Use the tokens. `bg-crewly-bg|card|sidebar`, `text-crewly-text|dim`,
`border-crewly-border`, `bg-crewly-inset`, `border-crewly-hairline`,
`bg-crewly-selected` + `text-crewly-selected-text`,
`bg-crewly-accent` + `text-crewly-accent-ink`,
`text-crewly-green|orange|red` — every one of them changes with the theme.

The rail is its own surface (`bg-crewly-sidebar`) and it is **dark in both
themes** — `#152420` at night, `#2a322b` against the sage page, the owner's own
value from the reference. A pale rail on a pale page reads as one undivided
sheet; keeping the rail pine gives the product its spine back, and the content
the room to be paper.

Selection on the rail is the clay fill (`#db9558`) with dark ink on it, exactly
as the reference shows it. Inside the content, selection stays the `#f2f7a0`
lime, so "where you are" and "what to do" never look alike.

The rail cannot use the page's ink or field colours, so `.crewly-rail`
(`SidebarNav.jsx`, both the desktop aside and the mobile drawer) re-declares the
tokens for its own subtree: text, dim, border, the inset washes, the status
greens, and `slate-400` for the HRMS wordmark. The logo PNG is screened instead
of multiplied there, and the search field is a lifted dark surface rather than a
paper well punched through the pine. Nested panels inside the rail inherit those
values, which is what you want — nothing inside it should be paper.

Anything that draws in SVG attributes reads CSS variables instead:
`--chart-present|late|half|absent|muted|series-1…6`, `--art-green|blue|purple|
orange|pink|teal|yellow`, `--art-ink-rgb`, `--art-dim-rgb`, `--art-plate`.
`var()` is not valid in a presentation attribute, so a token colour travels
through `style={{ stroke: … }}`.

Two rules that exist because the dark theme used to be the only theme:

- **No `bg-white/5` / `border-white/10`.** White at low alpha is a dark-theme
  trick; on paper it disappears. Use `bg-crewly-inset(-strong|-heavy)` and
  `border-crewly-hairline(-strong)` — the light theme swaps in warm brown at the
  same alpha.
- **No `text-white` on an uncoloured surface.** Use `text-slate-50`: it inverts
  with the ramp and is white in practice in the dark theme. `text-white` is only
  correct on a saturated fill (`bg-indigo-600`, `bg-crewly-red`, …).

`slate` is re-cut in the app's greens in *both* themes: blue-grey next to pine
reads as two unrelated products. In the light theme the ramp is inverted as
well — `slate-950` is the card (`#f8fbf1`), `slate-900` the canvas
(`#eef3e6`), `slate-50` the darkest ink — so every border, divider and hover in
the ~117 files that predate the tokens keeps the relationship it had. Every step
used for text clears 4.5:1 on the canvas (checked in `test/theme.test.js`).

Status hues follow the same logic, one rung at a time. The app's badge
vocabulary is `text-emerald-300`, `text-rose-200`, `text-indigo-300` — pastels
picked to glow on a near-black panel, which sit at 2:1 on paper. In the light
theme steps 100–300 map to the family's 700 and step 400 to its 600, so the same
markup clears 4.5:1. The 500/600 steps are *not* touched: those fill buttons
(`bg-indigo-600`, `bg-emerald-500`) and already carry light type in both themes.
Only the steps this codebase actually uses are listed in block 12b.

The one pattern that cannot survive the flip is a chip that is already pale
paper — `bg-emerald-100 text-emerald-700`. Light surface plus dark label becomes
ink on ink once 100 darkens. Those few chips (task/project status pills, the
payslip's net-salary tile) carry literal hexes instead, with a comment saying so.

Charts follow the palette rather than a generic series ramp: present olive,
late gold, half-day sage, absent clay-red, "not marked" a muted sage wash. The
six leave-type series are `--chart-series-1…6`. Nothing is assigned by hand at a
call site.

Status and role chips were the last cold colours in the app — `text-blue-300`,
`text-purple-400`, `bg-indigo-500` in the role badges and the org chart. Roles
now use the same heat as everything else: gold, olive, clay, pale lime, sage
(`utils/roles.js`, `ROLE_BADGE` in the org chart). Some feature panels (BGV,
ATS, task modals) still carry their own semantic indicator hues; recolouring
those is a follow-up, not part of the surface scheme.

## Surfaces that opt out

Three subtrees keep their own palette no matter what the switch says, via
`html[data-theme='light'] :is(.landing-shell, .auth-shell, .theme-fixed-dark)`:

- `.landing-shell` — the public home is paper all the time; it *is* the light look.
- `.auth-shell` — signing in is the moment the lights go down.
- `.theme-fixed-dark` — the provider console (`SuperAdminLayout`), an internal
  dark-only tool.

The auth and landing shells do not mount the toggle. Neither does the provider
console.

One more exception lives in `PayslipDocument.jsx`: a payslip is a white document
in every theme, so its greys are literal values, not theme tokens.

## Card headings are labels, not page titles

`style.css` gives bare `h1`/`h2`/`h3` a responsive display scale. That scale is
right for a page title and wrong for a card header: "Goals & KPIs", "Team
board", "Documents on file" are written at `text-sm` on purpose, and the base
rule was promoting each one to 24px — the whole page then read as a stack of
page headers, with nothing left louder than anything else.

The fix is an opt-out rather than a new scale: mark the heading `card-title`
and the base rule skips it.

```jsx
<h2 className="card-title flex items-center gap-2 text-sm font-bold">
  <Users className="h-4 w-4" />Team board
</h2>
```

The selector is `h2:not(.landing-shell h2):not(.auth-shell h2):not(.card-title)`,
so a card inside a shell still behaves. Only the page's own `<h1>` keeps the
display size.

## Motion

The switch is instant — no cross-fade, no transition on `body`. A theme flip is
a re-render of colour, and animating it makes the app feel like it is loading.
Rule 10 of `style.css` collapses transitions for reduced-motion users anyway.

## Tests

`test/theme.test.js` pins the mechanism (pre-paint script, storage key, default,
one control in the header), the palette (the owner's hexes verbatim, every token
re-declared, the slate ramp inverted and tinted, WCAG AA computed from the hexes
rather than eyeballed, white *forbidden* on the clay fill), the status-hue flip,
the carve-outs, and the "no dark-only white alphas / no inverting paper chip"
rules. `test/emptyStates.test.js` pins the illustration palette; the landing
test pins the app tokens it expects to stay night.
