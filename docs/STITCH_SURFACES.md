# The `st-` surfaces — the Warm Organic token contract

Five Operations pages are drawn to the Stitch exports rather than to the app's
own palette. They are the only places in the product that use the `st-` family;
everything else keeps the Crewly pine/olive tokens. This file is the contract so
the next person does not fork the palette a third time.

Read alongside `docs/THEME.md` (the Crewly palette) and the PRD, §4.

---

## 1. Where it applies

A page opts in with one wrapper:

```jsx
<div className="st-surface min-h-screen">
```

The class does four things: switches the font family to `--font-st` (Plus Jakarta
Sans), turns on `tabular-nums` so figures do not shimmy between renders, paints
`--color-st-surface`, and sets the heading tracking. It does not touch the shell —
the sidebar, header and page padding stay exactly as they are.

Opted in today: `pages/schedule/{SchedulesPage,ShiftsPage,HolidaysPage}.jsx` and
`pages/leaves/LeavesPage.jsx`. `LeaveApprovalsPage.jsx` has no mock yet and is
still on the Crewly tokens.

---

## 2. The palette, and why these exact values

The tokens are the YAML block in the supplied `DESIGN.md`, not the PRD's prose
table. That is not a preference: the exported mocks were sampled pixel-by-pixel
and they render the YAML values.

| role | token | value | measured in the mocks |
| --- | --- | --- | --- |
| canvas | `st-surface` | `#f3fcf1` | `image-3.png` at (40 %, 5.5 %) → `#f3fcf1` |
| card | `st-lowest` | `#ffffff` | `image-3.png` card interior → `#ffffff` |
| inset panel | `st-container` | `#e8f0e5` | `image-3.png` inset → `#e8f0e5` |
| rail | (existing) light sidebar | `#2a322b` | `image-5.png` rail → `#2a322b` |
| active nav pill | (existing) `crewly-accent` | `#db9558` | `image-5.png` pill → `#db9558` |
| primary action | `st-primary` | `#89511a` | copper on white, AA |
| copper fill | `st-primary-container` | `#db9558` | PRD primary accent |
| sage | `st-secondary` | `#54643c` | PRD `#97A87A` is the *fill*; text needs the darker one for contrast |
| chartreuse tag | `st-tertiary-fixed` | `#e3e893` | optional / floating days |
| statutory / declined | `st-error` | `#ba1a1a` | mandated holidays, rejections |
| alert highlight | `st-alert` | `#f2f7a0` | PRD §4.1, for system-notice pills |
| sage fill | `st-sage` / `st-sage-dim` | `#97a87a` / `#a8bba3` | PRD secondary / tertiary accents |
| nav chrome | `st-chrome` | `#222823` | PRD §4.1 |
| ink | `st-ink` | `#1c1f1b` | PRD §4.1 |

### The one unresolved conflict

The PRD's table says the canvas is **`#FCF9EA`** (ivory). The mocks render
**`#f3fcf1`** (mint). `DESIGN.md` contains both — cream in prose, mint in its
YAML. We follow the pixels, because the mocks are the fidelity target. If the
cream is the intended destination, change exactly one line:

```css
--color-st-surface: #f3fcf1;   /* → #fcf9ea */
```

Nothing else references the canvas colour, so that is the whole migration.

---

## 3. Rules

1. **Never hard-code a hex on an `st-` page.** `test/leaveScheduleSurfaces.test.js`
   fails on `#[0-9a-f]{6}` in any of these files.
2. **Never use `bg-white/5|10|20`.** `test/theme.test.js` fails on it — those
   alphas only read correctly on the dark palette. Use `st-highest`,
   `st-container` or `st-tertiary-fixed/10`.
3. **No Material Symbols, no new icon set.** Lucide, 2 px stroke, `rounded`
   terminals — the PRD §4.2 asks for exactly what the app already ships.
4. **One colour role per concept.** Copper = the primary action. Sage = healthy /
   configured. Chartreuse = optional, floating, temporary. Terracotta-red =
   mandated, declined, blocking. A type keeps its colour in the card, the legend
   and the table row.
5. **A colour is never the only carrier.** Every tinted chip also carries text.

---

## 4. Unconfigured states

A block that the mock draws but the database cannot fill stays on the page and
says so. Three accepted shapes:

- **A stated value** — derived from a real query, e.g. `Active patterns 4` from
  `schedules.length`, or the grace range from the patterns' own `graceMinutes`.
- **`Not configured`** — the field exists in the schema but nobody has set it,
  e.g. a shift's night allowance, or the rotation card's overlap window.
- **A disabled control with a reason** — `Request shift change`, `iCal`, `Feed
  URL`. `title` carries why. The block is visible, the affordance is honest.

What is never acceptable: inventing a number, inventing a data source, or deleting
the block so the page lines up with the mock.
