# Phase 31.5 — Testing Checklist (localhost)

Manual pass over Attendance Regularization & the Exception Center.
Automated proof: `test/attendanceRegularization.test.js` (48/48) +
`test:all` 995/1006 (11 pre-existing env blocks, none attendance).

## Setup

- [ ] Two users: employee Asha (reports to manager Mohan) + Mohan.
- [ ] Asha has a completed day (in 09:05, lunch, out 18:10) and an
      open day (in only). Company policy window ≥ 7 days.

## Employee — corrections

- [ ] Missed clock-out on the open day → PENDING; snapshot shows
      the recorded in-time and empty out-time.
- [ ] Same-fact second request refused (`already pending`).
- [ ] Future day refused; day older than the window refused.
- [ ] Missed clock-in on a day WITH a recorded in refused.
- [ ] Clock-in correction equal to the recorded time refused.
- [ ] Break correction with an empty list refused; overlapping
      breaks refused; breaks outside in→out refused.
- [ ] Work-mode correction to the recorded mode refused.
- [ ] Explanation carrying a proposed time refused.

## Employee — history

- [ ] History row shows effective times with `*` after approval;
      hovering reveals the recorded punch.
- [ ] `Regularized` badge appears on the corrected day.
- [ ] `Request correction` opens the form with the day prefilled.

## Manager — exception center

- [ ] Pending queue shows Asha's request with recorded-vs-proposed.
- [ ] Approve missed-out → day rebuilt (hours, status, overlay);
      recorded out stays empty; audit has APPROVED + APPLIED.
- [ ] Approve clock-in correction → lateness recomputed.
- [ ] Reject without a reason refused; with reason works.
- [ ] Own request cannot be self-approved.
- [ ] Out-of-team request invisible (pending) / 403 (direct).

## Mode guard

- [ ] WFH correction without 31.4 cover: manager gets 403.
- [ ] HR/Admin approves without cover → `HR override` chip +
      audited `authorizationOverride`.
- [ ] With covering 31.4 approval: manager approves cleanly.

## Boundaries

- [ ] APPROVED leave on the day blocks submit and approve.
- [ ] Payroll period LOCKED for the month blocks submit/approve.
- [ ] Approved request cannot be cancelled (terminal).
- [ ] Recorded punches never change; no new events appear.

## Regression

- [ ] Full OFFICE punch cycle + breaks still works; replay intact.
- [ ] Monthly report aggregates reflect corrected statuses.
- [ ] `npm run test:all` shows no attendance failures.
