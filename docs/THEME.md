# Theme

The tenant app ships two palettes and one switch between them.

| Theme | Canvas | Ink | What it is |
| --- | --- | --- | --- |
| `dark` (default) | `#0d1117` | `#e6edf3` | The product's night look: near-black panels, GitHub-ish slate, brand green. |
| `light` | `#f6efe4` | `#2b211a` | Warm paper. Cards at `#fffbf4`, borders at `#e4d6c1`, accents darkened to hold contrast. |

Brown, not white. The public home is cream, the auth screens are a warm charcoal;
a neutral white app would read as a third product wedged between them.

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

Use the tokens. `bg-crewly-card`, `text-crewly-text`, `text-crewly-dim`,
`border-crewly-border`, `bg-crewly-inset`, `border-crewly-hairline`,
`text-crewly-green|orange|red|accent` — every one of them changes with the theme.

Two rules that exist because the dark theme used to be the only theme:

- **No `bg-white/5` / `border-white/10`.** White at low alpha is a dark-theme
  trick; on paper it disappears. Use `bg-crewly-inset(-strong|-heavy)` and
  `border-crewly-hairline(-strong)` — the light theme swaps in warm brown at the
  same alpha.
- **No `text-white` on an uncoloured surface.** Use `text-slate-50`: it inverts
  with the ramp and is white in practice in the dark theme. `text-white` is only
  correct on a saturated fill (`bg-indigo-600`, `bg-crewly-red`, …).

`slate` is inverted wholesale in the light theme: `slate-950` becomes the
lightest paper, `slate-50` the darkest ink, and every step in between keeps the
relationship it had. That is why the app's ~117 files that predate the tokens
follow the switch without being touched. Each step is pulled toward brown, and
every step used for text clears 4.5:1 on the canvas.

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

Charts and illustrations read `--chart-track`, `--art-ink-rgb`, `--art-dim-rgb`,
`--art-plate` instead of literals, for the same reason.

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

## Motion

The switch is instant — no cross-fade, no transition on `body`. A theme flip is
a re-render of colour, and animating it makes the app feel like it is loading.
Rule 10 of `style.css` collapses transitions for reduced-motion users anyway.

## Tests

`test/theme.test.js` pins the mechanism (pre-paint script, storage key, default,
one control in the header), the palette (every token re-declared, the slate ramp
inverted *and* warm, WCAG AA computed from the hexes rather than eyeballed), the
status-hue flip (each rewritten step must darken sharply, and 500 must stay put),
the carve-outs, and the "no dark-only white alphas / no inverting paper chip"
rules.
