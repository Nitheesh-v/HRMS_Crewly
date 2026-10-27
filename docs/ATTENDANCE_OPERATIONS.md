# The three attendance Operations pages — what changed

Pushed as `e0cda0f`. `npm test` **648/648**, `npm run build` ✓, eslint unchanged at the
105 errors / 16 warnings baseline (all pre-existing; none in these files).

## Which pages, from which export

| export | page | route | file |
| --- | --- | --- | --- |
| `screen.png` + `code.html` | **Enterprise attendance policy** | `/app/attendance/policy` | `src/pages/attendance/AttendancePolicyPage.jsx` |
| `screen (2).png` + `code (1).html` | **Overtime, comp-off & attendance exceptions** | `/app/attendance/overtime` | `src/pages/attendance/AttendanceOvertimePage.jsx` |
| `screen (4).png` + `code (3).html` | **Who's working today** | `/app/attendance/team` | `src/pages/attendance/AttendanceTeamPage.jsx` |

All three are inside the Warm Organic scope (`AppLayout` carries it), so the rail,
header and page canvas match the mocks without touching the shell.

---

## 1. Enterprise attendance policy

Built: hero (governance pill, version, name) → base zone / last published /
enforcement chip → `Version history (n)` + `Save draft` + `Publish policy update`
→ six anchor tabs → six rule-group cards, each with its `Rule group 0N` pill →
right rail (coverage dial, who it applies to, labour-law note, "not configured
here").

| mock | rendered | why |
| --- | --- | --- |
| `1,842 employees across 4 regions` | the policy's own name + version | no headcount is attached to a policy |
| `Policy Health Score 98.4% / A+ / 1,784 on-track / 42 open exceptions` | **coverage** dial: rules decided ÷ fields the policy owns, with the field list in code | a compliance score with no scoring engine behind it is the one number I will not draw |
| `Monthly Grace Occurrences: 3 / 4 / 5 incidents` | block kept, `Not configured` + "the policy has no occurrence cap" | no such field; late marks accumulate instead |
| `Paid Meal Window (45 mins)`, `Biometric Break Validation` | paid-meal toggle is real (`breaks.includeInWorkedTime`); biometric block is dashed with "turnstile terminals are not wired" | no biometric break flag exists |
| `Monthly Regularization Limit` | block kept, `Not configured` | no per-month cap field |
| `Comp-Off Validity Window (60 Days)` | block kept, `Not configured — earned days do not expire here` | no expiry enforcement |
| `Active Check-ins Today` per site | site card with coordinates, radius, state, address | that count lives on the presence board, not in the location doc |
| `Wi-Fi BSSID Enforced`, `Mock GPS Blocking` | `Not configured` / `Server-side only` | the schema stores a site, not router identities |
| `Assigned Business Units (820 / 540 / 482 staff)` | "Who this applies to": work modes, approvals, flexi target, weekend rules | no segment→staff mapping exists |
| `Labour Law Reference — Factories Act 1948 …` | same block, copy that says Crewly records what the policy enforces and does not adjudicate a statute | I will not cite a section the product does not implement |
| `Automated gentle cues via Slack, WhatsApp, Crewly Mobile` | the four **real** notification toggles (shift start, missing in, missing out, incomplete break) and a line saying Slack/WhatsApp are not wired | in-app + email only |
| `Version 4.2 / 4.1 / 3.8 / 1.0` | the real history endpoint: version, status, timestamps, and the edited values | real |

**Kept though the mock omits it:** the *Weekly hours target (flexi week)* editor —
it is a real policy field, and deleting a capability to match a drawing is worse
than one extra card. It sits between overtime and geofence.

## 2. Overtime, comp-off & attendance exceptions

Built: hero (eyebrow, title, subtitle, `View guidelines`, `Claim overtime`) →
claim / review tabs + links to the real regularization and work-mode surfaces +
billing cycle → three metric tiles → eligible-day cards → request table with
decide/decline → rail (how it is decided, month at a glance, "time not money",
"not configured").

| mock | rendered | why |
| --- | --- | --- |
| `Comp-Off Bank 2.0 days (960 mins active)` | `compOff.available` from `leaveService.my()` — one owner for the number | real |
| `1 Day expires in 28 days` | dropped from the tile; the rail states no expiry is enforced | no expiry field |
| `Total Approved This Quarter 14.5 h +3.2h vs Q3` | sum of approved claims in the current quarter; the Q-on-Q delta is dropped | comparing to a quarter we do not aggregate would be invented |
| `Quarterly Overtime Quota Cap 14.5 / 24 hrs` | not drawn; rail says "the policy has no cap field" | no cap exists |
| `1.5x Comp-Off (3.75h) or OT Pay`, `2.0x Comp / 1.0 D`, `60-Day Validity Rule`, rate estimator | replaced by what the engine actually returns per day: recorded → eligible minutes, and comp-off days earned | multipliers are benefit enums, not factors; the estimator would be fiction |
| `Punch Regularizations (1 Pending)`, `Work Mode Requests` tabs | tabs that **link** to those two surfaces, which exist as their own pages | one tab cannot mutate another page's queue |
| `OT-8821` refs | `OT-` + the attendance date, from the row | the model's id is not that ref |
| `Payroll Allowance / Disbursed to Oct Pay` | `Overtime minutes` / `Comp-off credit` — the two benefits that exist | the engine never pays out here |
| `Approver: Marcus Vance` | the approver/requester name on the row, or `—` | real |

Unchanged guarantees: time only (no currency symbol anywhere), one request per
day, approve/reject/cancel all hit the real endpoints.

## 3. Who's working today

Built: presence hero (privacy pill, title, scope line, live-sync stamp, export
[disabled], roster-audit link) → seven counters → filter bar (search by name /
employee code / role, department, status, page size, work-mode chips with counts)
→ person cards → presence-by-modality donut → floor capacity → operational
attention → ethical footer.

| mock | rendered | why |
| --- | --- | --- |
| `14 / 2 / 5 / 3 / 2 / 4 / 3` across seven counters | the seven real buckets from `counts` | real |
| `Work Mode: All Locations (28) • In Office (16) • Remote (8) • Field (4)` | same chips, same arithmetic over `counts.modes` | real |
| `All Departments (48)`, `Shift: Day General` | real department select; no shift filter (the board has none) | — |
| `Synced with Biometric Gateway #03` | dropped: `Live sync <time>` reports the actual fetch | the gateway id is not exposed |
| `Export Presence Log`, `Manual Roster Roll Call` | export disabled with a reason; roll call replaced by a link to the roster audit | no endpoint for either |
| `Encrypted SSO Session ✓ Verified`, `GPS Match ±12m`, `Geofence: OMR Tech Park` | the real site name only — `GPS Match` would imply a geofence check the backend explicitly disclaims ("NOT browser-GPS geofence evidence") | the model comment is explicit |
| `Floor 3F capacity 12/18 desks, AQI 34` | card kept, `Not configured`, with the three things it would need | no desk register |
| `Presence Ratio 57% in office` | computed share over people currently on the clock | real |
| `Operational Attention` | rows carrying exceptions or a review flag, linking to regularizations | real |
| `Privacy Guaranteed / Transparency Log` | the same statement, pointing at the audit log rather than a policy page that does not exist | — |

Presence-only guarantees kept: no coordinates, no reasons, no payroll figures,
no activity inference, no productivity score.

---

## Verification

- `npm test` 648/648 — including a new `test/attendanceOperations.test.js` (19
  pins) that holds the mock's blocks *and* the unconfigured-state substitutions.
- `npm run build` ✓ 1.39s.
- `npx eslint src` 105 errors / 16 warnings — identical to the pre-change
  baseline; the two `set-state-in-effect` errors in each of these files were
  already there.
- **No screenshots.** There is still no browser in this sandbox, so this is
  verified by build, tests and token checks rather than by looking at pixels.
