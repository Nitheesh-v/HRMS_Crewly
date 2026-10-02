# Phase 37.2 — Self Presence Experience

> **Read this before touching** `Frontend/src/components/presence/`,
> `Frontend/src/layout/AppLayout.jsx`, `Frontend/src/services/presenceService.js`,
> or `Frontend/test/presenceWidget.test.js`.

Phase 37.2 layers the employee-facing presence menu on top of the
37.1 backend. It is the discoverable, accessible, responsive UI for
manual status / status message / work location. It deliberately does
**not** include realtime, team availability, WFH approval, leave/shift
derived state, or admin settings.

## What 37.2 adds

| File | Role |
|---|---|
| `Frontend/src/components/presence/presenceVisual.js` | The colour / label / icon dictionary (per status presence). Pure, no React. |
| `Frontend/src/components/presence/PresenceIndicator.jsx` | Small status pill (colour + text + icon + aria-label). Display-only. |
| `Frontend/src/components/presence/StatusExpirySelector.jsx` | Until cleared / 30 min / 1 h / 4 h / Today / Custom (datetime-local). |
| `Frontend/src/components/presence/StatusMessageEditor.jsx` | Plain textarea + 160-char counter. |
| `Frontend/src/components/presence/WorkLocationSelector.jsx` | Office / WFH / Remote with the three policy modes honoured. |
| `Frontend/src/components/presence/PresenceMenu.jsx` | The header popover: composes the four above + dispatches the redux thunks. |
| `Frontend/src/components/presence/index.js` | The barrel. |
| `Frontend/src/layout/AppLayout.jsx` | Mounts `<PresenceMenu />` next to the avatar (header). |
| `Frontend/test/presenceWidget.test.js` | 30+ source / behavioural assertions (37.2 §37). |

The backend contracts are the 37.1 endpoints. The frontend service
and slice are unchanged from 37.1; this unit only consumes them.

## The hard laws 37.2 honours

### 1. UNKNOWN is not OFFLINE (37.2 §6)
The widget renders `presence = 'unknown'` as **"Presence unavailable"**,
not Offline. The `EMPTY_PRESENCE` constant ships `unknown` and
`livePresenceAvailable: false`.

### 2. Manual-only set (37.2 §7)
The radio group iterates only over `available`, `busy`, `dnd`. Away /
Offline / On Leave / Outside Working Hours / Unknown are never
selectable. A source test pins it.

### 3. WFH policy is honoured without a fake activation (37.2 §12)
| `wfhMode` | UI |
|---|---|
| `self_declare` | WFH selectable |
| `approval_required` | WFH rendered disabled with copy "WFH requires approval for your company. (Request flow ships in a later update.)" |
| `disabled` | WFH rendered disabled with copy "WFH is disabled for your company." |

The widget does **not** invent a fake "Request" button. Phase 37.5
owns the request / approval flow.

### 4. Identity never sent by the client (37.2 §16, §19)
The presence mutations carry only `{status, expiresAt}` /
`{message, expiresAt}` / `{location, expiresAt}`. No `companyId`,
`company`, `userId`, `user`, `employeeId`, `employee`. Pinned by a
source test that refuses the property-style form (not bare words
that may appear in copy).

### 5. Loading is bounded (37.2 §20)
The mount effect dispatches `loadMyPresence` exactly once. A failed
load does **not** keep the controls disabled — `state.presence.loading`
goes `pending → fulfilled` exactly once and `state.presence.saving`
is distinct from `loading`.

### 6. UNKNOWN vs UNAVAILABLE — no fake Offline
A failed `loadMyPresence` keeps the last good state. The error is
stored on the slice and toasts via the existing `notify.error(...)`
seam. The popover never claims Offline.

### 7. LocalStorage / dangerouslySetInnerHTML / no heartbeats (37.2 §25–§27)
The presence slice and component never write to localStorage. Status
messages are rendered as plain text via React (no HTML injection).
No heartbeat / mousemove / keydown activity tracking.

### 8. Non-modal (37.2 §22)
No `aria-modal`, no `fixed inset-0`, no full-screen backdrop. The
popover is a `relative` panel anchored to its trigger.

### 9. Responsive + a11y
- Keyboard-openable (Enter/Space on the trigger).
- Escape closes the menu and returns focus to the opener.
- Focus is moved into the popover on open.
- Click-outside closes.
- Colour is NOT the only signal — text + icon + aria-label always
  carry the state.

## Files changed in 37.2

- **Added**:
  - `Frontend/src/components/presence/presenceVisual.js`
  - `Frontend/src/components/presence/PresenceIndicator.jsx`
  - `Frontend/src/components/presence/StatusExpirySelector.jsx`
  - `Frontend/src/components/presence/StatusMessageEditor.jsx`
  - `Frontend/src/components/presence/WorkLocationSelector.jsx`
  - `Frontend/src/components/presence/PresenceMenu.jsx`
  - `Frontend/src/components/presence/index.js`
  - `Frontend/test/presenceWidget.test.js`
  - `docs/PHASE_37_2_SELF_PRESENCE.md`

- **Modified**:
  - `Frontend/src/layout/AppLayout.jsx` (mounts `<PresenceMenu />` in the header)

## Verification

```powershell
cd Frontend
npm test
npm run build
npm run lint
```

Expected:
- `npm test` → 260 / 260
- `npm run build` → clean
- `npm run lint` → 128 problems (baseline held, delta = 0)

```powershell
cd Backend
npm run test:presence
node --test test/phase36Closeout.test.js
```

Expected: Phase 37.1 + Phase 36 closeout green.

## Localhost acceptance

See `docs/PHASE_37_RUNBOOKS.md` "Phase 37.2 Acceptance" (companion
to the 37.1 acceptance section).