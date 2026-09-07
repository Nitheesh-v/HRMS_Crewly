# Phase 30.5 — Candidate BGV Information & Secure Document Collection

Crewly HRMS — Recruitment / Background Verification track.
Builds on 30.1 (optional BGV decision), 30.2 (catalogue/pricing), 30.3 (paid
order), 30.4 (Crewly-sent consent portal). **Verification itself is NOT
implemented** — no verifier accounts, assignment, workbench, or reports
(those are 30.6+).

## 1. Responsibility & roles
- Tenant HR = requester: buys checks (30.3) and sees **collection status
  only** (`AWAITING_CANDIDATE / CANDIDATE_DRAFT / CANDIDATE_SUBMITTED`) —
  never raw evidence files in 30.5 (minimum-necessary access).
- Crewly/Infolexus = platform: hosts the portal, stores evidence privately,
  records the submission.
- Candidate = provides information/documents **only for purchased checks**,
  drafts freely, then explicitly submits.

## 2. Entry rule (backend-enforced, every request)
1. Valid, unrevoked, unexpired 30.4 portal token (`BgvConsentAccessToken`,
   purpose-isolated, hash-only storage — the SAME token continues to work
   after consent; the decision stays immutable).
2. Commercially authorized order via the single boundary helper
   `isCommerciallyAuthorized(order)` (30.3 PAID today; future billing modes
   map into the same helper — no Razorpay field is read in 30.5 code).
3. `finalDecision === 'CONSENTED'` — **payment alone or opening the portal
   is NOT sufficient**.
4. Order not cancelled/terminal.

## 3. Purchased-checks-only
Forms/uploads/submission exist only for the immutable order snapshot checks
(IDENTITY / ADDRESS / EDUCATION / EMPLOYMENT / REFERENCE). Unpurchased
checks are rejected server-side (409), not merely hidden.

## 4. Data model
- `BgvCollectionCase` — one per PAID order (unique): structured identity
  subdoc (masked identifier + `select:false` sha256 fingerprint — **the
  full number is never persisted**), address subdoc, repeatable
  education/employment/reference subdocument arrays, status
  `NOT_STARTED → DRAFT → SUBMITTED`, `submittedAt`.
- `BgvEvidenceFile` — one row per uploaded file version: category →
  checkType map, `storageKey`/`checksumSha256` `select:false`, `version`,
  `isActive`, `status ACTIVE/REPLACED/REMOVED`, honest `scanStatus`.

## 5. Privacy boundaries
- **Masking:** APIs/UI show `******234F` / `XXXX XXXX 9012` style masks
  only. No full identity value in Mongo, responses, logs, audit, or queue.
- **Aadhaar:** an uploaded Aadhaar copy is *candidate-provided evidence* —
  the UI labels it "uploaded copy — not e-KYC". No UIDAI/e-KYC claims, no
  Aadhaar OTP is ever requested.
- **DigiLocker:** no integration in Phase 30. A candidate may upload a
  document they obtained from DigiLocker; it is recorded as
  candidate-provided evidence, NOT `DIGILOCKER_VERIFIED`. DigiLocker
  credentials/OTP are never requested.
- **Selfie:** optional, image-only (JPEG/PNG/WEBP), private storage, never
  a public URL, never in any queue payload. No biometric face recognition —
  collection only.
- No passwords/OTPs/credentials for external services are collected
  anywhere; bank statements are never required (payslip evidence is
  optional and flagged highly sensitive).

## 6. Files & storage
- Uploads reuse the pre-onboarding hardened middleware + inspector:
  allowlist MIME (PDF/JPG/JPEG/PNG/WEBP), extension↔MIME match, magic-byte
  structure validation, PDF active-content rejection, 5 MB cap, sanitized
  filenames, sha256.
- Storage: Cloudinary **authenticated** raw uploads, or a 0700/0600
  `private_storage/bgv-evidence` directory outside production. There is
  **no public URL** and no `/uploads/bgv/...` path; downloads go through
  `GET /api/public/candidate/bgv-collection/:secureToken/files/:fileId`
  after server-side token → case → file resolution (ids alone never
  authorize; cross-candidate/cross-case reads return the generic 404).
- Malware status stays honest: no scanner configured → `NOT_CONFIGURED`,
  never faked to `CLEAN`.
- **Versioning:** replacing a draft file deactivates the previous version
  (`REPLACED`, bytes retained) and creates version N+1. After SUBMITTED,
  ordinary edits/replacements/removals are blocked (30.9 will add
  controlled additional-information requests).

## 7. Draft / submission lifecycle
- Any save/upload flips `NOT_STARTED → DRAFT`; drafts persist in MongoDB
  (never localStorage) so candidates can close and return.
- Backend readiness (`computeCollectionReadiness`) evaluates **purchased
  checks only** and returns safe missing-requirement messages.
- Final submission is an explicit `POST /submit` (GET/refresh never
  submits), idempotent on repeat, records `submittedAt`, freezes the case,
  and starts **no** verification, **no** verifier assignment, **no**
  pipeline change, **no** BGV CLEAR.

## 8. Endpoints
Public (token authority; rate-limited; mounted before tenant middleware):
`GET /:secureToken` (summary), `POST identity|address`, `POST/DELETE
education|employment|reference(+:recordId)`, `POST files` (multipart),
`GET|DELETE files/:fileId`, `POST submit` — all under
`/api/public/candidate/bgv-collection`.
Tenant: `GET /api/recruitment/candidates/:candidateId/bgv-collection-status`
(`BACKGROUND_VERIFICATION_READ`) — status + per-check completion only.

## 9. Audit
`BGV_COLLECTION_SAVED`, `BGV_COLLECTION_RECORD_REMOVED`,
`BGV_EVIDENCE_UPLOADED/_REPLACED/_REMOVED/_DOWNLOADED`,
`BGV_PACKAGE_SUBMITTED` — metadata carries ids, check types, categories,
versions, scan status, order code only. Never identifiers, filenames,
contents, storage keys, or tokens.

## 10. Queues
30.5 uses **no queue** — file inspection is synchronous (same posture as
the 30.4 sensitive mailer). The existing DOCUMENTS worker is bound to
pre-onboarding `CandidateDocumentVersion`; nothing is faked into it. Any
future async processing must carry references only (companyId, case id,
file id, version, correlation id).

## 11. Automated tests
`Backend/test/bgvCollection.test.js` — 27 hermetic tests (no
Mongo/Redis/SMTP/Cloudinary; the real pure file-inspection code runs).
Covers: consent gate (save/upload/submit), commercial-readiness gate,
revoked/expired/unknown tokens, cross-candidate isolation, purchased-check
enforcement (+frontend data contract), identity masking & no-persistence,
selfie privacy, address validation, repeatable records (add/edit/remove,
date validation), MIME/size/executable rejection, version history,
NOT_CONFIGURED honesty, draft persistence, readiness scope, submission
lock + idempotency + POST-only, raw-token/queue/provider/pipeline/verifier
coupling scans, audit redaction, HR status transitions.
Run: `npm run test:bgv-collection` (included in `npm run test:all`).

## 12. Known limitations
- No verifier access of any kind (30.6+).
- No institution/employer/reference contacting — collection only.
- No phone/field/geolocation address verification.
- No async malware re-scan for BGV evidence (honest NOT_CONFIGURED).
- No resubmission after final submission (30.9).
- Selfie is optional evidence; no verification method requires it yet.
