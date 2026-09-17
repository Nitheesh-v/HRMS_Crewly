# Company Branding & Document Branding

Post-Phase-31 small enhancement (NOT Phase 32). One centralized tenant
branding authority: each company configures its logo + document style once,
and appropriate NEW Crewly-generated company documents use it automatically.
Changing Company A never affects Company B; no code/deployment per tenant.

## 1. Architecture

```
Company.branding            ← ONE authority (logo + default layout)
Company.documentBranding    ← per-document settings (reference, never copy)
        │ generation-time capture
        ▼
brandingSnapshot            ← frozen into each immutable document
        │ render
        ▼
PDF (template + logo-or-initials)
```

- `Backend/src/services/companyBrandingRules.js` — pure rules: enums, bounds,
  clamps, PNG/JPEG dimension readers, initials, `snapshotBranding()`.
- `Backend/src/services/companyBrandingService.js` — injectable service:
  resolve/serialize/upload/replace/remove/settings/snapshot.
- `Backend/src/utils/companyLogo.js` — hardened byte resolver (allowlisted
  Crewly-controlled references only, fail-open, cached).
- `Backend/src/utils/payslipTemplates.js` — backend-controlled template
  registry + MINIMAL template + shared logo/watermark/sample helpers.

## 2. Model fields (Company — extended, no new collection)

- `logoUrl` (kept): service-maintained mirror of the current delivery URL
  for backwards compatibility (career portal, super-admin reads). Never
  written directly by tenants OR super-admin anymore.
- `branding.logo`: `provider` (CLOUDINARY|INLINE), `publicId`, `deliveryUrl`,
  `mimeType`, `bytes`, `width`, `height`, `version`, `uploadedAt`, `uploadedBy`.
- `branding.layout`: `width` (16–120, default 34), `maxHeight` (12–80,
  default 30), `fit` (CONTAIN|COVER, default CONTAIN), `alignment`
  (LEFT|CENTER|RIGHT, default LEFT).
- `documentBranding.payslip`: `templateId` (CLASSIC_CORPORATE|MINIMAL) +
  nullable `logo{width,maxHeight,fit,alignment}` overrides (null = inherit).
- `documentBranding.offer`: `useCompanyLogo` (default true).

## 3. Storage

Reuses the avatar-upload precedent: Cloudinary `crewly/logos/<companyId>/`
(public_id `company-<id>`, overwrite, `resource_type: image`, width capped
at 800px preserving aspect/ratio/format) when `cloudinaryReady`, else inline
`data:` URL dev fallback. One stable public_id per company → replacements
overwrite in place, never orphan assets. Only the logo asset may be
publicly delivered (it appears in tenant UI/documents); nothing else changes.

## 4. Permissions

Established company-settings pattern, no new permissions, no version bump:
mutations (`POST/DELETE /logo`, `PUT /`, `POST /payslip-preview`) are
`authorize(ROLES.COMPANY_ADMIN)` (same as `PUT /companies/my`); `GET /`
(safe serialization) is any member. Employees can never mutate branding.

## 5. Upload validation (backend, never trusting the client)

Multer memory 2MB pre-filter (PNG/JPEG mimetype) → service reuses the
`inspectPreOnboardingFile` abstraction (MIME allowlist, extension match,
magic-byte structure, active-content rejection, size cap, sha256) with
PNG/JPEG-only allowlist → dependency-free dimension read (≤2000px/side).
No SVG, no GIF/WEBP (PDFKit cannot render them), no HTML/PDF masquerade,
no remote URLs anywhere in the flow.

## 6. Fallback / replacement / removal

- No logo (or corrupt/unavailable bytes) → company-initials badge + name.
  Never a broken image, in UI or PDFs; bulk generation never fails on logos.
- Replace → new `version`, new delivery URL; old storage object destroyed
  best-effort only if orphaned (stable public_id normally overwrites).
- Remove → explicit empty logo state (version retained), `logoUrl` cleared.
- Audited: `COMPANY_LOGO_UPLOADED` / `COMPANY_LOGO_REPLACED` /
  `COMPANY_LOGO_REMOVED` / `COMPANY_BRANDING_UPDATED` (safe metadata only:
  version/mime/bytes/dimensions/changed fields — never bytes/URLs/secrets).

## 7. Document integration inventory

BRANDED WITH TENANT LOGO (+ template where listed):

- Payslip — logo + template selection (CLASSIC_CORPORATE default, MINIMAL).
  `snapshot.company.brandingSnapshot{logoVersion,hasLogo,layout,templateId}`
  captured by `buildPayslipSnapshot`; `renderPdf` passes bytes + capture.
- Offer Letter — logo only (no template selection; the `OfferTemplate`
  content system is untouched). Captured at APPROVAL into
  `companySnapshot{logoUrl,brandingSnapshot}` and persisted via the approval
  `$set`; the CREWLY product band is retained, the tenant mark sits beside it.
- Statutory PDFs — shared logo via existing `renderPdf` (full company doc).
- F&F statement — shared logo via existing `renderPdf` (full company doc).
- Tenant analytics report PDF — shared logo (company select extended with
  `branding documentBranding`; platform exports pass no branding).
- Public career portal — delivery URL (unchanged mechanism).

PLATFORM-BRANDED / INTENTIONALLY UNCHANGED:

- BGV final report (+ regression suite proving tenant branding is ignored).
- `PlatformSettings` branding, super-admin ops/platform-billing exports,
  legacy `streamPayslipPdf` (29.3 untouched-law, guarded by existing tests).

## 8. Immutable history behavior

- Payslip: stored rendered PDF untouched (29.9 law); regeneration re-renders
  the STORED snapshot incl. its branding capture. Snapshots lacking the
  capture render CLASSIC + default layout. Non-Crewly-host URLs in ancient
  snapshots now refuse → initials fallback (their stored PDFs unaffected).
- Offer: approval-time capture; stored checksummed PDF served for downloads;
  re-approval after edits captures fresh branding (correct: new artifact).
- Statutory/F&F/analytics stored exports immutable by stored bytes.
- No bulk regeneration exists, by design.

## 9. Template registry (backend-controlled)

`PAYSLIP_TEMPLATE = { CLASSIC_CORPORATE, MINIMAL }` — tenants select an ID;
no markup/styles/code upload exists. Resolution: explicit option → snapshot
capture → CLASSIC_CORPORATE. Only 2 templates are implemented and only 2
are shown (no fake options). Alignment positions the LOGO box; name/title
blocks stay anchored (documented in `payslipTemplates.js`). CONTAIN never
crops (default); COVER fills the box and may crop; aspect ratio preserved
always; display bounds enforced in rules AND clamped independently at render.

## 10. Preview

`POST /companies/my/branding/payslip-preview` (Company Admin): renders
backend-generated SAMPLE data (SAMPLE-0000 / Sample Employee, round figures)
through the chosen template+layout with a SAMPLE banner + diagonal watermark.
Creates no Payslip, consumes no number, sends no email, changes no payroll.

## 11. Worker behavior

No new queue. All document jobs stay references-only (no bytes/URLs in
payloads); workers re-fetch and resolve branding server-side at render time
from the document snapshot / authoritative Company. Payload contract unchanged.

## 12. Cache behavior

No new Redis cache. Logo bytes reuse the existing process-local 10-minute
fetch cache in `companyLogo.js` (bulk runs fetch once). Company reads are
per-request Mongo truth. No invalidation protocol needed.

## 13. Security review

Tenant isolation (`req.companyId` only; queries scoped `{_id: companyId}`);
admin-only mutations; magic-byte content validation; 2MB cap; 2000px source
bound; no SVG/remote-URL upload; SSRF closed (resolver allowlists `data:` +
`https://res.cloudinary.com` only; super-admin PATCH no longer accepts raw
`logoUrl`); no Cloudinary secrets to frontend; no path traversal (memory
uploads, fixed public_id); no giant-image DoS (caps at three layers);
cross-tenant writes impossible (no client companyId); history immutable.

## 14. APIs

- `GET /api/companies/my/branding` — safe branding (any member).
- `POST /api/companies/my/branding/logo` — multipart `logo` (admin).
- `DELETE /api/companies/my/branding/logo` — remove (admin).
- `PUT /api/companies/my/branding` — `{layout, documentBranding}` (admin).
- `POST /api/companies/my/branding/payslip-preview` — sample PDF (admin).

## 15. Frontend

`CompanyProfilePage.jsx` (`/app/company`, no new sidebar item): Branding
section (logo view/upload/replace/remove, requirements, layout controls,
2-template radio, save, SAMPLE-marked preview download) + live logo in the
payslip header mock. `companyService.js` extended. Dark Crewly tokens,
Lucide icons, no emojis in new UI.

## 16. Tests (26 hermetic, `npm run test:branding`)

- `companyBranding.test.js` (14): rules/clamps/dimensions/initials/snapshots,
  resolver allowlist + fail-open, upload/replace/remove/settings/audit,
  tenant scoping + A/B independence, safe serialization.
- `payslipBranding.test.js` (7): snapshot capture + defaults, template
  distinctness, MONEY LAW (identical rupee multisets across templates),
  snapshot-driven selection + unknown-id fallback, pre-branding default,
  logo/alignment/cover/corrupt-fallback, preview watermarking.
- `offerBranding.test.js` (3): text-only history, logo embed + fallback,
  model capture paths (+ no template selection on offers).
- `bgvUnbranded.test.js` (2): platform identity, injected-branding ignored
  byte-for-byte.

## 17. Known limitations

- Old arbitrary-URL `logoUrl` values (super-admin-set) no longer render in
  NEW renders (initials fallback); re-upload via Company Settings. Stored
  PDFs are unaffected.
- 2 payslip templates only (by design — quality over count).
- Inline `data:` logos bloat `GET /companies/my` in dev-no-Cloudinary mode
  (same pre-existing avatar pattern).
- App-shell (sidebar/header) logo integration deferred as a future extension.
- Reference UI/screenshot cited in the brief was never attached; UI follows
  the brief text + repo conventions.
