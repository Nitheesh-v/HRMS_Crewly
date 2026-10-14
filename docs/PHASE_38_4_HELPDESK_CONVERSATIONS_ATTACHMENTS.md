# Phase 38.4 — Helpdesk conversations, internal notes & secure attachments

**Scope:** Backend-only extension of the existing Helpdesk ticket discriminator. This phase adds immutable conversation messages, bounded history, one private attachment per uploaded message, and authenticated attachment delivery. It does not add frontend work, SLA behavior, notifications/realtime, AI, or HR mutations.

## API surface

| Method | Endpoint | Body / behavior |
|---|---|---|
| `GET` | `/api/helpdesk/tickets/:ticketNumber/messages?limit=20&cursor=...` | Bounded history, `limit` 1–100, stable descending sequence cursor. Requesters and confidentiality reviewers receive public messages only. Queue agents/managers with the existing read and confidentiality access receive public messages and internal notes. |
| `POST` | `/api/helpdesk/tickets/:ticketNumber/messages` | JSON `{ "body": "...", "messageType": "public" }`; `messageType` defaults to `public`. Body is nonempty plain text, at most 4,000 characters. `internal` requires existing Helpdesk manage permission and queue-staff membership. |
| `POST` | `/api/helpdesk/tickets/:ticketNumber/attachments` | `multipart/form-data`: one `file` field and optional `body` / `messageType` text fields. Body may be omitted for an attachment-only message. |
| `GET` | `/api/helpdesk/tickets/:ticketNumber/attachments/:attachmentId/download` | Authenticated server-side byte proxy. Ticket, tenant, requester/queue membership, confidentiality, message visibility, and attachment ownership are verified before storage access. |

Tenant and author authority is derived from authenticated middleware (`req.companyId`, `req.user._id`). Client identity overrides and unsupported body/query fields are rejected. Replies and notes do not change the ticket status; only active workflow states accept a new message. Resolved, closed, and cancelled tickets are not reopened by a message or upload.

## Security and data boundaries

- Message and attachment records are immutable; there are no edit/delete endpoints.
- Total and public-only per-ticket sequence counters are incremented atomically on the Helpdesk ticket. Public history cursors do not reveal internal-note positions.
- Employee and confidentiality-reviewer reads use a public-only Mongo filter and DTO boundary. Internal notes are limited to actual authorized queue staff; reviewers are read-only and do not receive internal notes.
- Message history is bounded and explicitly projected. Author lookup is a single batched tenant-scoped query returning only `_id` and `name`; no populated User documents, email, or phone fields are returned.
- Uploads allow one file of at most 10 MiB with an extension/MIME allowlist (PDF, JPG/JPEG, PNG, WEBP) and server-side signature checks. Filenames are reduced to safe display names.
- Mongo stores metadata, checksum, storage key, and message references only—never file bytes. Storage keys/checksums are hidden from normal model projections and never appear in message DTOs.
- Production storage uses the existing authenticated Cloudinary private-asset adapter (`raw`, authenticated type); the signed provider URL is used only inside the server-side proxy and is not returned to clients. Provider errors and URLs are not included in responses/logs. The development-only local private path uses restrictive directory/file modes and is not served as a static resource; production refuses local storage.
- Downloads are bounded to the attachment size cap, time-limited, integrity-checked, marked `private, no-store`, and sent as attachments with `nosniff`.
- Public-reply, internal-note, attachment, and download audit events contain action/resource metadata only—no message body, file bytes, storage key, signed URL, or provider URL.

There is no malware scanner in the existing repository. `scanStatus` remains `NOT_CONFIGURED`; signature/MIME validation is not a malware scan and must not be represented as one.

## Storage/Mongo failure and recovery

Storage and MongoDB are separate systems and are not described as atomic. An attachment starts in a non-deliverable `UPLOADING` state with a tenant/ticket-scoped recovery record before provider I/O. After storage succeeds it becomes `PENDING`; only a confirmed immutable message promotes it to `ACTIVE`. Downloads/history only use active attachments.

If a later write fails, the service attempts provider deletion and metadata cleanup. Failed cleanup becomes `CLEANUP_REQUIRED`. If message persistence has an ambiguous outcome, bytes are deliberately retained but remain non-deliverable; the service does not delete a file that might belong to a committed message. The existing worker performs bounded per-tenant reconciliation of records older than 30 minutes: it activates a confirmed matching message or deletes an unattached private object; unsuccessful deletion remains queued for retry. Each sweep is capped at 25 tenant configs and 10 attachment records per tenant. The worker must be running for automatic recovery.

## Deployment impact

- **Packages/configuration:** No package was added and no `.env` value was introduced or changed. Production must already have the repository's valid Cloudinary configuration; if authenticated private storage is unavailable, new uploads fail closed with 503. No public-storage fallback exists.
- **MongoDB:** Deploy the new `HelpdeskMessage` and `HelpdeskAttachment` collections and their declared indexes: unique tenant/ticket total sequence, unique tenant/ticket public sequence, unique tenant/ticket/message attachment, and attachment recovery indexes. `HelpdeskTicket` gains `lastMessageSequence` and `lastPublicMessageSequence` numeric counters with zero defaults; the first atomic `$inc` initializes legacy Helpdesk tickets without a backfill. Verify index creation/health using the deployment's existing index policy before release.
- **Storage:** Continue using authenticated Cloudinary private assets; no provider migration. Development-only local files live under the process working directory's `private_storage/helpdesk-attachments` and must not be copied into a public static directory or used as production storage.
- **Failures:** Provider/database failure returns generic errors; ambiguous persistence can delay attachment availability until reconciliation. Cleanup failures remain private and retryable. No transaction spans Cloudinary and MongoDB.
- **Compatibility:** Existing ticket status transitions and legacy SupportTicket readers are unchanged. Replies are accepted only for active workflow statuses and do not reopen resolved/closed/cancelled tickets. No notification, SLA, or frontend behavior is introduced.

## Validation boundary

Hermetic tests mock storage and Mongo operations; they do not establish live Cloudinary credentials, deployed indexes, multi-instance behavior against production MongoDB, worker uptime, network policy, or the real HTTP acceptance path. Do not infer production readiness from unit tests. Before release, an authorized operator must run the localhost acceptance checklist with local development placeholders and a non-production tenant/provider configuration.

### PowerShell localhost setup for operator acceptance

Run from a PowerShell window with a local MongoDB instance already available. This does not edit `.env`, set credentials, or contact Cloudinary; clearing the existing Cloudinary variables deliberately selects the development-only private local-file adapter. Use a disposable local database and non-production test users/tickets only.

```powershell
Set-Location .\Backend
$env:NODE_ENV = 'development'
$env:PORT = '5000'
$env:MONGO_URI = 'mongodb://127.0.0.1:27017/crewly_phase38_4_local'
$env:REDIS_ENABLED = 'false'
$env:CLOUDINARY_CLOUD_NAME = ''
$env:CLOUDINARY_API_KEY = ''
$env:CLOUDINARY_API_SECRET = ''
npm run dev
```

For recovery-path checks, open a second PowerShell window, repeat the environment assignments above (omit `PORT` if it is already used), and run `npm run worker:dev` from `Backend`. With the server running, use the existing authenticated local application session and a disposable Helpdesk tenant to exercise: public reply/history; internal-note exclusion for requester and reviewer views; wrong-tenant, wrong-ticket, non-member, and confidential-ticket denial; an allowed signature-valid upload/download; invalid MIME/signature and over-10-MiB rejection; and a resolved/closed-ticket write conflict. Keep the local private directory under `Backend/private_storage/helpdesk-attachments` out of static serving and deployment artifacts. This local adapter check does **not** validate Cloudinary; if staging-provider acceptance is required, an authorized operator must use a dedicated non-production Cloudinary account/configuration and must not upload test files to production Cloudinary. Restore the PowerShell environment by closing those windows after the check.

## Follow-on phase

Phase 38.5 subsequently adds backend-only queue-specific SLA policies and durable ticket clocks. That later unit does not change Phase 38.4 conversation or attachment semantics; see [`PHASE_38_5_HELPDESK_SLA.md`](./PHASE_38_5_HELPDESK_SLA.md) for its APIs, deployment/worker impact, verification, and pending localhost acceptance.
