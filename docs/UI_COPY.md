# UI copy — the diet

The screens had grown a second voice: internal section markers, build
references, and a sentence or two of explanation under almost every heading.
None of it is a number or an action, so none of it helps the person using the
page. This pass removed it and left a rule behind, pinned by a test, so a new
screen cannot reintroduce it.

## The three rules

| rule | why |
| --- | --- |
| No section markers (`§16`, `§12 / §25`) in rendered copy | they are references to an internal spec nobody outside the build has read |
| No build references (`Phase 27.12`, `Phase 29.9`) in rendered copy | a screen should say what happened, not which phase shipped it |
| No `subtitle` / `note` / `hint` caption over **110 characters** | a caption longer than that is a paragraph, and paragraphs belong in docs |

Comments in the code are exempt — the next reader still deserves the context.

## What was cut

| what | count |
| --- | --- |
| Rendered `§` markers removed | 66 |
| Template-literal markers (`· §12 …`) also removed | 14 |
| Captions shortened or de-referenced | 58 |
| Captions still over 110 characters | **0** (was 59) |
| Build references removed from rendered copy | 9 |
| Footnote paragraphs collapsed to one line | 24 |
| Duplicate pills removed (the month repeated beside the month) | 2 |

## Where the rules bit hardest

- **Payroll analytics sub-reports** — every page carried `§n — …` in its
  subtitle (`§12 — bonus, incentive and commission detail`). Now it says the
  thing and nothing else.
- **Final settlement** — thirteen `SectionTitle note="… (§n)"` captions became
  the sentence alone; two long explainers on the create modal and the close
  panel became one line each.
- **Statutory compliance** — the same disclaimer appeared three times (readiness
  panel, rail footer, page footer). It is now stated once, where the checklist
  is: *“Filing is recorded after it happens on the portal — Crewly never files
  for you.”*
- **Salary payment** — two three-line footnotes about bank custody and the
  export's encryption badges became one line each.
- **Payroll setup** — “Nothing here is pre-filled from another system…” is gone;
  the four step cards already say what they hold.
- **Salary structures** — the detail modal said assignment “is 0 today”, which
  stopped being true when the counts moved to the pay profiles. Removed.
- **Recruitment** — four permission walls told the reader to *“pull Phase
  27.14, restart the backend, log out and back in”*, and one carried a branch
  name. They now say which permission is missing and who can grant it.
- **Attendance** — the QR hero, the three kiosk steps and two analytics notes
  were cut to one clause each; the compliance and uptime notes keep their point
  without the paragraph.

## What deliberately stayed

Every number, every action, every permission gate, and every honest “we cannot
show this” note. The diet is about *volume of words*, not about hiding a limit
behind a shorter sentence.

## The pin

`Frontend/test/uiCopy.test.js` walks every `.jsx` in `src` and fails on:

1. a `§` marker outside a comment,
2. a `Phase NN.N` reference outside a comment,
3. any `subtitle` / `note` / `hint` string over 110 characters.

Run it alone with `node --test test/uiCopy.test.js`.
