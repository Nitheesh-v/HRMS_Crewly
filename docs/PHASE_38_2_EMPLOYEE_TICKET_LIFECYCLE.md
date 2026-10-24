# Phase 38.2 — Employee Helpdesk Ticket Lifecycle

**Status:** Backend API and hermetic tests implemented. Localhost acceptance remains pending.

## Scope

Phase 38.2 extends the Phase 38.1 Helpdesk foundation with employee ticket creation, requester-owned ticket listing and details, and requester cancellation. It reuses the `HelpdeskTicket` discriminator, tenant configuration, tenant queues/categories, ticket number allocator, centralized enums, permission checks, confidentiality rules, and the existing mutation audit trail.

No Helpdesk frontend pages, forms, or routes were added. No Department records are created or inferred; employees choose only from enabled queues and their enabled local categories.

## API

All paths are relative to `/api/helpdesk` and require the existing authenticated tenant context and Helpdesk permission middleware.

- `GET /queues` — existing enabled tenant queue/category catalogue; unchanged and reused.
- `POST /tickets` — create a requester-owned ticket. Body allowlist: `queueId`, `categoryId`, `subject`, `description`, optional `confidential`, optional `requestedPriority`. Tenant and requester identities are derived from middleware, not body fields.
- `GET /tickets/mine` — own tickets only. Optional query allowlist: `status`, `priority`, `queueId`, `search`, `sort`, `page`, `limit`. `sort` is `newest`, `oldest`, or `recently_updated`; page defaults to 1, limit to 20, and limit is capped at 100. Search is trimmed, capped at 60 characters, escaped as a literal, and applied only to ticket number and subject.
- `GET /tickets/:ticketNumber` — existing public identifier route, now returns a minimized employee detail DTO for the authenticated requester. The selector is the generated `HD-...` ticket number, not a Mongo ObjectId. Existing authorized staff reads retain their existing DTO and confidentiality checks.
- `PATCH /tickets/mine/:ticketNumber/cancel` — existing requester cancel route. Only `open` and `assigned` tickets can be cancelled. This is an atomic conditional transition; missing or other-requester tickets return 404, while an ineligible/stale cancellation returns 409. A successful cancellation preserves the historical row.

The own-ticket list returns `data` as the ticket array and top-level `meta` with `page`, `limit`, `total`, and `pages`. List DTOs omit descriptions and requester/assignment fields. Detail DTOs include the requester's own description and requester ID (matching the Phase 38.1 DTO pattern), but never populate a User document or expose tenant/internal record fields.

## Boundary and data behavior

- Tenant identity: `req.companyId`. Requester identity: `req.user._id`.
- Existing authentication/tenant middleware verifies the active user and tenant; creation also requires `HELPDESK_TICKET_CREATE_SELF`. The service receives only server-derived requester and tenant IDs.
- Every own-list filter and count is anchored to company + authenticated requester + `HELPDESK` discriminator. Unknown filters and identity query parameters are rejected.
- Details/cancellation are tenant- and requester-scoped; unauthorized ticket identifiers are non-enumerating.
- Creation fails closed if tenant config cannot be read, employee intake is disabled, queue/category is missing or disabled, confidentiality is disallowed, or input violates Phase 38.1 limits.
- Subject: 2–120 characters; description: 1–5000 characters. The service rejects non-string values rather than coercing them.
- Effective priority is tenant-defaulted; requested priority remains a non-authoritative hint. New tickets are `open` and explicitly unassigned.
- Existing `auditTrail` records authenticated write-request metadata without request bodies. No duplicate Helpdesk audit writer or raw description logging was added.
- Requester-list indexes are discriminator-partial and include stable `_id` tie-breakers for creation-date and update-date sorts.

## Database indexes

Added to the existing Helpdesk discriminator schema:

- `helpdesk_requester_ticket_list_created`: `{ companyId: 1, user: 1, createdAt: -1, _id: -1 }`, partial to `ticketKind: 'HELPDESK'`.
- `helpdesk_requester_ticket_list_updated`: `{ companyId: 1, user: 1, updatedAt: -1, _id: -1 }`, partial to `ticketKind: 'HELPDESK'`.

Existing tenant ticket-number uniqueness and queue listing indexes remain unchanged. No live database migration or index build was run in this unit; deploy the schema indexes through the project's normal index-management process.

## Verification

- Phase 38.1 baseline/regression: `npm run test:helpdesk` — 15 passed, 0 failed.
- Phase 38.2: `npm run test:helpdesk-lifecycle` — 15 passed, 0 failed. Coverage includes injected-model creation/list/detail/cancel behavior, safe query/DTO boundaries, atomic cancellation races, route registration order, and model index declarations.
- RBAC bootstrap: `npm run test:rbac-bootstrap` — 17 passed, 0 failed.
- Phase 36 closeout: `npm run test:phase36-closeout` — 49 passed, 0 failed.
- Phase 37 presence: `npm run test:presence` — 217 passed, 0 failed.
- Profile Change Requests regression: `npm run test:profile-changes` — 31 passed, 0 failed.
- Mongoose query-option hygiene: `npm run test:query-hygiene` — 3 passed, 0 failed.
- Broad Backend suite: `MONGO_URI='mongodb://127.0.0.1:27017/crewly_full_test' NODE_ENV=test npm run test:all` — 3418 passed, 0 failed, 0 skipped across 178 suites. The temporary command-line environment satisfied test config validation; no `.env` or application environment file was changed.
- No live database acceptance, browser/UI, external service, or localhost acceptance was performed; localhost acceptance remains pending.

## Windows PowerShell localhost acceptance

This checklist is for a local operator after starting the Backend and MongoDB. It uses only placeholders: keep real access tokens local, do not print them, paste them into chat, or commit them. Replace placeholders in a private PowerShell session only. Before testing, ensure the tenant's Helpdesk intake is enabled, an enabled queue/category exists, and the employee has the existing self-service Helpdesk permissions.

```powershell
$BaseUrl = 'http://localhost:5000/api/helpdesk'
$EmployeeToken = '<EMPLOYEE_ACCESS_TOKEN>'
$QueueId = '<ENABLED_QUEUE_OBJECT_ID>'
$CategoryId = '<ENABLED_CATEGORY_OBJECT_ID>'
$Headers = @{
  Authorization = "Bearer $EmployeeToken"
  'Content-Type' = 'application/json'
}

# 1. Confirm the configured catalogue; choose QueueId/CategoryId from this response.
$Queues = Invoke-RestMethod -Method Get -Uri "$BaseUrl/queues" -Headers $Headers

# 2. Create an employee-owned ticket. Priority is tenant-controlled; assignment is not supplied.
$Body = @{
  queueId = $QueueId
  categoryId = $CategoryId
  subject = 'Local acceptance: access request'
  description = 'Temporary local acceptance text; do not include sensitive data.'
} | ConvertTo-Json
$Created = Invoke-RestMethod -Method Post -Uri "$BaseUrl/tickets" -Headers $Headers -Body $Body
$TicketNumber = $Created.data.ticketNumber

# 3. List own tickets with bounded filters/search/sort/page/limit metadata.
$Search = [uri]::EscapeDataString('Local acceptance')
$ListUri = "$BaseUrl/tickets/mine?status=open&queueId=$QueueId&search=$Search&sort=newest&page=1&limit=10"
$Mine = Invoke-RestMethod -Method Get -Uri $ListUri -Headers $Headers
$Mine.meta

# 4. Open details using the public HD ticket number (not a Mongo ObjectId).
$Details = Invoke-RestMethod -Method Get -Uri "$BaseUrl/tickets/$TicketNumber" -Headers $Headers

# 5. Cancel the eligible own ticket, then verify its history remains visible as cancelled.
$Cancelled = Invoke-RestMethod -Method Patch -Uri "$BaseUrl/tickets/mine/$TicketNumber/cancel" -Headers $Headers
$History = Invoke-RestMethod -Method Get -Uri "$BaseUrl/tickets/mine?status=cancelled&page=1&limit=10" -Headers $Headers
```

Optional authorization check: from a separate local session, use a different employee's own token placeholder and request `GET /tickets/$TicketNumber`; expect a non-enumerating 404. Do not print either token. A second/stale cancellation should return 409.

**Acceptance status:** Not performed by the hermetic unit tests; run the sequence locally after the Backend and tenant prerequisites are ready.

## Deferred scope

No UI; agent assignment/status/priority workflow; conversations/internal notes; attachments; SLA; notification/realtime; knowledge base; analytics; or cross-domain HR behavior. These remain subject to their own approved phase scope.
