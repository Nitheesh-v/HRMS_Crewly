# Phase 30.9 — BGV Additional Information Requests & Controlled Resubmission

Status: **IMPLEMENTED, awaiting manual localhost acceptance.** Phase 30.10 (QA / final report) is **NOT** implemented.

## Purpose

A verifier who hits an evidence gap (unreadable experience letter, missing enrollment number, wrong dates) can request
a correction from the candidate **instead of** prematurely concluding `UNABLE_TO_VERIFY`. Crewly notifies the candidate;
the candidate responds through the existing secure 30.4/30.5 portal; the verifier reviews the response and resolves —
the response is **evidence, never auto-truth**.

## State machine

`BgvCheckVerification.state` gains `AWAITING_CANDIDATE`:

```
IN_PROGRESS / AWAITING_THIRD_PARTY
   └─(verifier creates request)→ AWAITING_CANDIDATE
         └─(candidate submits response)→ IN_PROGRESS  (request: CANDIDATE_RESPONDED)
         └─(verifier cancels request)  → IN_PROGRESS  (request: CANCELLED)
SUBMITTED checks REFUSE new requests (409) — no silent reopen; 30.10 controls QA.
```

Request statuses: `OPEN → CANDIDATE_RESPONDED → RESOLVED`, or `OPEN → CANCELLED`. History is append-only — nothing is
ever overwritten or deleted. Multiple requests per check are allowed.

## API

Verifier (`/api/bgv-verifier/work`, session = 30.6 verifier auth, **current assignment only**):

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/:orderId/:checkType/info-requests` | history + response metadata |
| POST | `/:orderId/:checkType/info-requests` | create (idempotent per OPEN check+category) |
| POST | `/info-requests/:requestId/resolve` | review → RESOLVED (responded only) |
| POST | `/info-requests/:requestId/cancel` | withdraw (OPEN only) |

Candidate (public, token-authorized, same posture as 30.5 — GET never submits):

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/:secureToken/info-requests` | list own requests |
| POST | `/:secureToken/info-requests/:requestId/file` | replacement document (hardened 30.5 uploader) |
| POST | `/:secureToken/info-requests/:requestId/reference` | alternate referee (validated) |
| POST | `/:secureToken/info-requests/:requestId/response` | **explicit submit** → CANDIDATE_RESPONDED |

Tenant HR: no new endpoints. `bgv-assignment-status` surfaces `AWAITING_CANDIDATE` → UI copy **“Waiting for
candidate”** — safe progress only; no tokens, no verifier notes, no conclusions. HR cannot upload for a candidate.

## Categories (backend allowlist, per check)

`bgvInfoRequestRules.INFO_REQUEST_CATEGORIES` — IDENTITY / ADDRESS / EDUCATION / EMPLOYMENT / REFERENCE lists exactly as
spec’d. No category anywhere asks for passwords, OTPs, DigiLocker logins, or banking credentials; minimized documents
only (never full Aadhaar/PAN when a masked doc suffices). Cross-check categories → 400. Unpurchased checks → 409.
Each category maps to a `responseKind` (`FILE` / `TEXT` / `REFERENCE_RECORD`) and, for FILE kinds, the single
`evidenceCategory` it unlocks.

## Controlled resubmission (the ONLY exception to the 30.5 lock)

- The submitted case stays locked everywhere else — `assertEditable` is unchanged.
- An **OPEN** request unlocks only its own `evidenceCategory` through the 30.9 response endpoints. Unrelated
  Identity/Address/Education/References remain locked (enforced server-side; candidate A can never touch candidate
  B’s case — requests are resolved through the case token, and request↔case mismatch → 404).
- Uploads reuse 30.5 versioning: previous ACTIVE file → `REPLACED` (kept forever), new file `version+1`,
  `bgvInfoRequest` ref stamped, `scanStatus: 'NOT_CONFIGURED'` (never fake `CLEAN`), private storage, no public URLs,
  same multer allowlist (no executables).

## Notification

- Crewly is always the sender (`bgvInfoRequestedEmail` in `mailer.js`): tenant context, safe check/category names,
  optional bounded verifier message (≤500 chars, escaped), portal link, expiry, “never asked to pay” reassurance.
- Delivery is synchronous + sensitive (same posture as the 30.4 invitation): the **raw token is never queued, logged,
  persisted, or audited** — only the SHA-256 hash is stored. Queue payloads elsewhere stay refs-only.
- The rotated portal token carries `finalDecision: 'CONSENTED'` + copied `decidedAt`, so the existing consent gate
  still applies to the new link.
- SMTP failure **never** deletes the request or fabricates a response: request stays `OPEN`,
  `notificationSent: false`, audit records `delivered: false`.

## Authorization & reassignment

- Create/resolve/cancel require the **current** assignment (`loadOwnAssignment`); former verifiers, deactivated
  verifiers, specialization-only verifiers and tenant HR all get 404/403-equivalent outcomes.
- Requests belong to the **check**, not the verifier: they survive reassignment/deactivation; the new verifier gains
  full history; candidate responses are bound to the case token, never to a verifier ID.

## Human boundary & business safety

No auto reject/fail/clear; no conclusion is written by any 30.9 path; no candidate pipeline mutation; no new charge,
order, or Razorpay coupling (30.3 snapshot untouched); no DigiLocker API and no credential-shaped categories;
`UNABLE_TO_VERIFY` remains a human 30.8 conclusion.

## Audit (safe metadata only)

`BGV_INFO_REQUEST_CREATED` / `_NOTIFICATION` / `_RESOLVED` / `_CANCELLED`, `BGV_INFO_RESPONSE_SUBMITTED`,
`BGV_INFO_RESPONSE_FILE_ADDED`, `BGV_INFO_REFERENCE_ADDED` — ids, statuses, versions, delivery flag. Never tokens,
URLs, document content, response bodies, verifier notes, or masked identifiers.

## Frontend

- Verifier workbench: `InfoRequestPanel.jsx` — category select (backend list), bounded message, confirm step,
  request history with status chips, response view (text + response-file downloads via the 30.7 private route),
  Resolve / Cancel, “Waiting for candidate” badge (`StateBadgeRow`).
- Candidate portal: `InfoRequestSection` in `BgvCollectionPortal.jsx` — open request, instructions, upload / text /
  alternate reference, **explicit Submit response**, submitted/resolved states; every other section stays locked.
- HR: `BgvPurchasePanel.jsx` renders “Waiting for candidate”. All dark Crewly theme tokens (`.card/.input/.label/
  .btn-primary/.btn-ghost/.badge`), Lucide icons, no emoji-as-icon, no `dangerouslySetInnerHTML`.

## Tests

`test/bgvInfoRequest.test.js` — 10 tests covering the §35 behavior list (auth #1-6, scope #7-10, state #11-15,
notification #16-20, candidate portal #21-25, controlled edit #26-30, files #31-36, response/resolve #37-42,
reassignment #43-45, business+regression #46-60). Fully hermetic (injected deps incl. the real
`loadAuthorizedContext` gate through fakes). Full suite: **984/984 pass**; frontend `vite build` clean.

## Localhost acceptance (Windows PowerShell)

```powershell
cd C:\path\to\HRMS_Crewly\Backend
npm run dev
# second window:
cd C:\path\to\HRMS_Crewly\Frontend
npm run dev
```

A. Assign a check to a verifier (30.7 ops page) → verifier opens the check workbench.
B. Verifier: “Request additional information” → pick category → confirm → badge shows *Waiting for candidate*.
C. Candidate email (console log in dev) → open the **new** portal link (old link is rotated out).
D. Portal shows only the requested item unlocked; everything else stays locked; unrelated sections refuse saves.
E. Upload a replacement / type a clarification → explicit **Submit response**.
F. Verifier: sees “Candidate responded”, reviews text/files → **Resolve** → state returns to *In progress*.
G. Duplicate request while OPEN → idempotent, no second email.
H. Request on a SUBMITTED check → rejected with a clear message.
I. Reassign the check → old verifier gets 404; new verifier sees full history and can resolve.
J. HR purchase panel shows “Waiting for candidate” — nothing else new.
K. Kill SMTP (or use a bad SMTP host) → request still exists, `notificationSent:false`, audit `delivered:false`.
L. Ctrl+F reminder: search the diff for `password`, `otp`, `token` in queue/audit paths — must be absent.

## Out of scope (unchanged)

30.10 QA/final report, 30.11 ops/SLA, 30.12 hardening, DigiLocker API, billing, criminal checks, seeds/demo scripts.
