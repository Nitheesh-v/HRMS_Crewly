# Phase 31.6 — Testing Checklist (localhost)

## Setup

- [ ] Start backend + frontend; log in as an employee with a day-shift
      assignment (09:00–18:00) and one with a night-shift assignment
      (22:00–06:00). Company timezone Asia/Kolkata.

## Today card — day shift

- [ ] Before clock-in the card shows the shift name + `09:00 – 18:00`.
- [ ] Clock in at 09:05 → status LATE, worked timer runs, `Shift …` line
      visible while WORKING.
- [ ] Clock out at 18:00 → `Scheduled 09:00 – 18:00` on the completion
      block; history row shows Scheduled `09:00–18:00`.

## Today card — night shift (overnight)

- [ ] At 22:20 clock in → record dates to the shift START date (today).
- [ ] At 00:30 (next calendar day) clock in as the second night employee →
      record anchors to YESTERDAY; today card at 01:00 shows
      `22:00 – 06:00 (+1 day)`.
- [ ] History row for the night shows Scheduled `22:00–06:00 +1`.

## Snapshot freeze

- [ ] After a 09:05 clock-in, edit the Shift to 10:00–19:00 (HR).
- [ ] Clock out at 18:00 → lateness stays 5 (snapshot), not 0 (new shift).

## Unresolved

- [ ] Employee with no assignment/shift/schedule clocks in → PRESENT,
      zeros, no Scheduled value; nothing errors.

## Regularization interplay

- [ ] Approve a missed clock-out on a legacy (snapshot-less) row → the
      control gains a RESOLVED snapshot and the LATE/5 verdict.
- [ ] Approve a correction on a snapshot row after editing the shift →
      the verdict still follows the snapshot.

## Regression

- [ ] Full OFFICE cycle + breaks + replay still passes (31.2 slice).
- [ ] WFH clock-in still requires cover; overnight WFH approval naming
      the shift date covers a 01:00 punch.
- [ ] `npm run test:all` green; `npm run build` (frontend) green.
