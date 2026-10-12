# Weekly-hours flexi policy — "finish your week early, rest the remaining days" — build plan (2026-10-10)

Owner ask (paraphrased): if the policy sets weekly hours (e.g. 400 hrs), and an employee
finishes that target in 3 days, the remaining days of the week should be leave for them —
paid, not absent, not deducted from leave balance.

## A. Repository findings

**What exists and where this feature must plug in:**

- `AttendancePolicy` (versioned, one current row per company — the partial-unique index
  repaired in DUPLICATE_INDEX_FIX_PLAN) already has:
  - `thresholds.fullDayMinutes` (default 480) / `halfDayMinutes` (240) — the *daily*
    expectation used to judge a day's attendance today;
  - an `overtime` block with `normalDayBenefit`, `weeklyOffBenefit`
    (`NONE | OVERTIME | COMP_OFF`), `holidayBenefit`, `compOffMinutesPerDay` — a
    **comp-off concept already exists**, which is the closest cousin to this feature;
  - no weekly-hours notion anywhere. The week as a unit does not exist in policy.
- `Attendance` rows store `date` as a company-local `'YYYY-MM-DD'` string, `workMinutes`,
  `overtimeMinutes` (**approved OT only** — the Phase 31.8 contract: punch/regularization
  code must never write it), and `status` enum currently `['PRESENT', 'LATE', 'HALF_DAY']`.
  **There is no ABSENT row** — absence is *derived*: finalization rules read an unresolved
  past scheduled day as ABSENT (29.5 parity), and finalization computes day fractions
  (worked / leave / absent) with blocking issues (MISSING_PUNCH, PENDING_OT).
- **LOP flow into payroll:** `monthlyInputRules` builds each employee's `lopDays`
  (`lopSource: 'ATTENDANCE'`, or leave-based when a LOP leave type exists) and sums
  `summary.totalLopDays`; the engine's `computePayableDays({ working, lopDays })` turns
  that into paid days. So a rest day stays paid as long as (a) finalization does not read
  it as absent and (b) monthly inputs do not emit LOP for it.
- The realtime attendance channel exists for nudges; analytics/timesheet read the same
  day records.

**One honesty note on the example:** a week physically contains 168 hours, so the
configurable target will be stored in minutes with a hard cap of `10080` (7 × 24 h) and a
sane default of `2400` (40 h). Any target up to the cap works mechanically — "finish in
3 days, rest the rest" behaves identically whether the target is 40, 60 or 120 hours.

## B. Security / data boundaries

- All computation is tenant-scoped: week context reads only `companyId + user` rows;
  the policy is the company's current `AttendancePolicy` (existing RBAC:
  `ATTENDANCE_POLICY_*` permissions gate policy edits — **no new permission, therefore no
  SYSTEM_PERMISSION_VERSION bump**).
- Additive model change only: one new policy sub-block + one new Attendance status value
  + nullable marker fields. No data migration; legacy readers ignore unknowns.
- The Phase 31.8 OT contract stays untouched: this feature **reads**
  `overtimeMinutes` (behind an explicit flag) and never writes it.
- No cross-module rewrites: Attendance, Leave, Payroll keep their ownership; this feature
  only (a) adds a status and (b) makes the absence/LOP readers treat it as paid rest.

## C. Implementation

1. **Policy block** `weeklyTarget` on `AttendancePolicy`:
   - `enabled: Boolean` (default **false** — off for every existing company until switched on);
   - `targetMinutes: Number` (60–10080, default 2400) with a UI hint showing the h:mm form;
   - `restDayMode: 'AUTO_MARK' | 'SUGGEST_ONLY'` (default AUTO_MARK; SUGGEST_ONLY only
     nudges HR/employee and never rewrites a day);
   - `includeApprovedOvertime: Boolean` (default false — if true, approved `overtimeMinutes`
     count toward the target as well as `workMinutes`).
   Version bump of the policy document (configVersion) follows the existing 29.1 pattern.
2. **New Attendance status** `WEEKLY_TARGET_OFF` (additive enum value). Meaning: *paid
   earned rest day, granted because the weekly target was met*. Punching in on such a day
   converts it back to a normal worked day (existing OT rules then apply).
3. **New service** `attendanceWeeklyTargetService.js`:
   - `weekWindowFor(date)` — Monday→Sunday window in company-local date strings;
   - `getWeekContext({ companyId, user, date })` — sums `workMinutes` (+ approved OT per
     flag) across the week's Attendance rows, reads the current policy, returns
     `{ targetMinutes, achievedMinutes, remainingMinutes, qualified, restDates }`;
   - `recomputeAfterPunch(...)` — called on the punch/checkout seam after a day's
     `workMinutes` is final; on the crossing event it (a) fires the existing realtime
     attendance nudge ("Weekly target met — remaining days are earned rest") and
     (b) in AUTO_MARK mode marks the week's remaining *working* days as they resolve;
   - idempotent and safe to run repeatedly; never marks future-dated rows early —
     each rest day is written when that day resolves (absence-resolution time), so
     "3 days done → rest" survives server restarts and needs no timers.
4. **Absence-resolution + finalization seam** — the core rule:
   when a scheduled working day resolves with no punches and no approved leave, and the
   week is already qualified, the day becomes `WEEKLY_TARGET_OFF` instead of deriving as
   ABSENT. Finalization day-fractions treat the status with weekly-off parity (worked /
   paid, never the absent dimension), and finalization close-out does not flag it.
5. **LOP exclusion** — `monthlyInputRules` skips `WEEKLY_TARGET_OFF` days exactly like
   weekly offs: no LOP emitted, so `computePayableDays` pays the week in full. The day is
   *not* deducted from leave balance — it is not a leave at all (that is the owner's ask).
6. **Analytics / timesheet / dashboards** — label the day "Earned off (weekly target)";
   employee dashboard gets a weekly-progress chip ("32h / 40h this week ✓"); manager team
   view shows the earned-off day distinctly from absent and from leave.
7. **Frontend policy UI** — new "Weekly hours target" section on the attendance policy
   page (enable, target, mode, include-OT toggle), following the existing policy-page
   patterns; validation mirrors the model bounds.

**Explicit interaction rules (v1):**
- Approved leave already taken in that week stays leave — no retro conversion, no double
  benefit (a rest day only replaces a would-be ABSENT day).
- Weekly offs and holidays do not consume or grant anything; only scheduled working days
  can become rest days.
- Qualification never crosses the week boundary — no carry-over of hours or rest days.
- Disabling the policy mid-week stops future marking; already-marked days stay.
- Working more after qualification is normal work (overtime rules apply as today).

## D. Test plan

- Hermetic rules suites (no DB): week-window math across month boundaries; qualification
  on exact hit and on crossing mid-day; multiple remaining days all rest; leave-day
  precedence; weekly-off/holiday non-participation; disable-mid-week; two tenants with
  different policies never see each other's rules.
- Finalization parity: a qualified week's rest day reads paid, not absent; close-out has
  no new issue types.
- Monthly inputs: no LOP rows for rest days; payroll `computePayableDays` unchanged
  arithmetic proven paid-full-week.
- Source pins: the 31.8 OT contract untouched; the status enum addition present; LOP
  exclusion present.
- Frontend pins: policy UI fields bound to the real config; progress chip reads the real
  service endpoint.
- Full backend `test:all` + frontend suites green; bite-proofs on the new suites.
- Owner localhost acceptance steps are written after the build (separate §F results, as
  with every prior unit) — never claimed from here.

## E. Environment / dependencies

- Zero new npm dependencies; no env vars; no permission-registry change (no version bump);
  additive model change only; the feature is OFF by default for every existing company.

## Open decisions for the owner (needed before implementation starts)

1. **Rest-day pay** — plan assumes 100% paid (that is the point of the ask). Confirm.
2. **Who counts hours** — only punch `workMinutes` (default), or also *approved* overtime
   minutes toward the target (flag provided)?
3. **Auto vs confirm** — should earned rest days be marked automatically (default), or
   should HR confirm each one (SUGGEST_ONLY mode)?

Say "go" (with any changes to the three decisions) and this becomes the active build unit.

## F. SHIPPED — commit `38ce41e` (2026-10-10)

All three locked decisions implemented as planned; nothing else changed.

- **Model:** `weeklyTarget` block on AttendancePolicy (`enabled:false`,
  `targetMinutes` 60–10080 default 2400, `restDayMode` AUTO_MARK|SUGGEST_ONLY,
  `includeApprovedOvertime:false`); additive Attendance status
  `WEEKLY_TARGET_OFF` + `weeklyTarget` why-subdoc (weekStart/targetMinutes/
  achievedMinutes). Policy save path (whitelist, serializer, validator)
  round-trips the block.
- **Rules/service:** `attendanceWeeklyTargetRules.js` (pure: Mon→Sun windows,
  strictly-before qualification, crossing, rest-day precedence) +
  `attendanceWeeklyTargetService.js` (`materializeRestDays` idempotent,
  `getWeekContext`, `onControlDayFinalized` one-time nudge keyed by the
  Notification `{companyId, eventKey}` unique index).
- **Seams:** punch checkout → fire-and-forget crossing check; payroll
  buildAutoSummary → materialize-before-read (fail-open); timesheet buildDay →
  earned rest reads as paid WEEKLY_OFF-equivalent (zero fractions, no
  MISSING_PUNCH); monthlyInputRules → WEEKLY_TARGET_OFF counts as paid so it
  can never become absent/LOP; finalization reuses the same buildDay parity.
- **API:** `GET /api/attendance/weekly-target` (self-read permissions).
- **Frontend:** policy editor section "Weekly hours target (flexi week)";
  dashboard weekly-goal chip (additive, silent on failure); timesheet
  labels "Earned off (weekly target)" + drawer why-row.
- **Gates:** backend `test:all` 3386 tests / 178 files / 0 fail (incl. new
  `attendanceWeeklyTarget.test.js` 15/15 and the two enum compat pins updated
  for the additive status); frontend 436/0 (incl. `weeklyHoursFlexi.test.js`
  4 pins); `vite build` OK.
- **V1 limits (unchanged, by design):** weekly offs/holidays don't
  participate; approved leave stays leave; no cross-week carry; disabling
  mid-week stops future marking but keeps already-written rest rows (paid);
  working on an earned-rest day makes it a normal worked day under normal OT
  rules; hours never carry into next week; SUGGEST_ONLY mode computes but
  writes nothing.
