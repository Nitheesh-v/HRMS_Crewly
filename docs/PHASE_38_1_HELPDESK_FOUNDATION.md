# Phase 38.1 — Employee Helpdesk Backend Foundation

**Status:** backend foundation implemented; awaiting localhost acceptance.
**Boundary:** employee-facing service queues and tickets only. This is separate from Phase 38 Profile Change Requests and from Crewly's legacy/platform `SUPPORT` tickets.

## Scope

Phase 38.1 provides tenant Helpdesk configuration, service queues and queue-local categories, explicit queue memberships, an employee ticket model and service layer, safe ticket numbering, validation, RBAC, confidentiality, and regression tests/documentation.

It does **not** add a frontend, replies/conversations, attachments, SLAs, notifications, analytics, Helpdesk realtime, AI/NATS, or changes to Attendance, Leave, Payroll, or Phase 37 presence/realtime.

## Storage boundary and historical records

Helpdesk tickets reuse the existing `SupportTicket` Mongo collection through the `HelpdeskTicket` Mongoose discriminator (`ticketKind: "HELPDESK"`). New legacy/platform support tickets use `ticketKind: "LEGACY_SUPPORT"`. Rows created before the discriminator existed and with no `ticketKind` are classified as legacy by `legacySupportTicketFilter`; no data migration or destructive backfill is required.

All tenant/platform support readers, aggregates, search results, and mutations now apply the legacy filter. Thus legacy Support routes cannot read, reply to, search, count, or update Helpdesk tickets. Historical Helpdesk records also remain tenant-scoped and readable by their authorized requester/queue members when their queue has later been disabled.

No Department records are created. Helpdesk queues and their categories are separate configuration records and are never inferred from an organizational Department or an employee's reporting hierarchy.

## Tenant configuration

`HelpdeskTenantConfig` stores explicit per-company defaults:

| Setting | Default | Phase 38.1 behavior |
|---|---:|---|
| `enabled` | `false` | Helpdesk is off until an authorized tenant administrator enables it. |
| `allowEmployeeTickets` | `true` | Effective only when Helpdesk itself is enabled. |
| `attachmentsEnabled` | `false` | Persisted for explicit policy; no attachment endpoint exists in 38.1. |
| `confidentialTicketsEnabled` | `false` | Required, with queue-level enablement, before a requester can mark a ticket confidential. |
| `defaultPriority` | `normal` | Effective priority is server-set from tenant policy. |

Configuration reads perform a tenant-scoped upsert so stored defaults are explicit. A database/config read failure returns `503`; it never substitutes permissive settings. Updates accept only the listed keys, are gated by `HELPDESK_QUEUE_MANAGE`, and take the tenant from `req.companyId` and the actor from `req.user._id`.

## Queue and membership policy

Queues and categories are company-scoped. Queue names are NFKC-normalized and case-insensitive unique within a tenant. Category names are normalized and unique within a queue. Categories live under their queue; a category ID from another queue is rejected. Disabled queues and disabled categories cannot receive new tickets. Historical ticket reads do not depend on the queue still being enabled.

Queue agent, manager, confidential-agent, and reviewer IDs are explicit memberships. Every referenced user must be active in the same tenant. Confidential agents must also be explicit queue agents. Organizational department membership, reporting-manager relationships, and role labels never assign queue rights. A user cannot self-assign through ordinary employee permissions; only RBAC-authorized queue administrators can configure membership, and only an explicit queue manager can assign a ticket to an already-listed active agent.

## Ticket contract

Helpdesk statuses are lowercase and centralized in `services/helpdesk/helpdeskRules.js`:

`open`, `assigned`, `in_progress`, `waiting_for_employee`, `waiting_for_department`, `resolved`, `closed`, `cancelled`.

The centralized transition graph disallows reopening closed/cancelled tickets. Priorities are `low`, `normal`, `high`, `urgent`; default is `normal`. A requester may store a `requestedPriority` hint, but it never changes effective priority. Only authorized, explicitly assigned queue staff can change the effective priority.

Employees may submit a subject and description only after the tenant config, enabled queue, and enabled queue-local category have all been verified. Tenant and requester identity are always server-derived. The body rejects `companyId`, `company`, `userId`, `user`, `employeeId`, `employee`, `requesterId`, and `requester`, as well as unsupported fields. Ticket output is a minimized DTO, uses the human-facing number, and never populates a User document.

Ticket numbers use the existing `TenantSequence` collection and an atomic `findOneAndUpdate` increment under `{companyId, key: "HELPDESK_TICKET"}`. Numbers are tenant-scoped (`HD-000001`, …), protected by a tenant-unique partial index, and are not authorization credentials. There is no `countDocuments()+1` allocation and no user-facing ObjectId ticket identifier.

## Authorization and confidentiality

New permissions use Crewly's permission catalogue and versioned role bootstrap; no role-name checks grant access.

- `HELPDESK_QUEUE_READ`: enabled employee queue discovery.
- `HELPDESK_QUEUE_MANAGE`: tenant queue and Helpdesk configuration administration.
- `HELPDESK_TICKET_CREATE_SELF` / `HELPDESK_TICKET_READ_SELF`: requester ticket creation and own-ticket access.
- `HELPDESK_TICKET_READ` / `HELPDESK_TICKET_MANAGE`: queue-ticket operations, still restricted by explicit queue membership in the service.

Company Admin inherits the tenant-wide Helpdesk permissions from the existing all-company matrix; HR Manager receives queue administration and ticket read/manage grants. Employees receive queue discovery and self-service ticket permissions only. An agent/reviewer must also be explicitly listed on the corresponding queue; an RBAC grant alone cannot read a queue's ticket data.

Confidential tickets are readable only by the authenticated requester, a queue agent explicitly included in that queue's restricted-agent list, or a reviewer explicitly listed for that queue. Queue managers, reporting managers, company-wide HR access, and being the assigned agent do not independently bypass confidentiality. Reviewers can list confidential tickets only; they are not automatically queue agents or ticket mutators. Unauthorized lookups return the same not-found response as missing records, and ticket lists expose no counts that could reveal hidden confidential records.

## HTTP routes

All routes are under `/api/helpdesk`, protected by authentication, customer tenant context, subscription checks, and Crewly RBAC.

| Method | Path | Permission / behavior |
|---|---|---|
| `GET` | `/config` | `HELPDESK_QUEUE_READ`; returns tenant-safe configuration DTO. |
| `PATCH` | `/config` | `HELPDESK_QUEUE_MANAGE`; updates allowlisted settings. |
| `GET` | `/queues` | Lists only enabled queues/categories while employee ticket intake is enabled. |
| `GET` | `/queues/:queueId` | Returns an enabled queue and its enabled local categories. |
| `GET` | `/admin/queues` | `HELPDESK_QUEUE_MANAGE`; includes disabled queues/categories and opaque membership IDs. |
| `POST` | `/admin/queues` | `HELPDESK_QUEUE_MANAGE`; creates a tenant queue. |
| `PATCH` | `/admin/queues/:queueId` | `HELPDESK_QUEUE_MANAGE`; updates queue/category membership and policy. |
| `POST` | `/tickets` | `HELPDESK_TICKET_CREATE_SELF`; server-derived requester and tenant; atomic ticket number. |
| `GET` | `/tickets/mine` | `HELPDESK_TICKET_READ_SELF`; authenticated requester's tickets only. |
| `GET` | `/tickets/:ticketNumber` | Self read or `HELPDESK_TICKET_READ` plus queue/confidential membership. |
| `GET` | `/queues/:queueId/tickets` | `HELPDESK_TICKET_READ` plus explicit queue or reviewer membership; no counts. |
| `PATCH` | `/tickets/:ticketNumber/status` | `HELPDESK_TICKET_MANAGE`, queue membership, centralized transition. |
| `PATCH` | `/tickets/:ticketNumber/priority` | `HELPDESK_TICKET_MANAGE`, queue membership, valid priority. |
| `PATCH` | `/tickets/:ticketNumber/assignment` | `HELPDESK_TICKET_MANAGE`, queue-manager membership, active explicit agent target. |
| `PATCH` | `/tickets/mine/:ticketNumber/cancel` | `HELPDESK_TICKET_READ_SELF`; requester may cancel only `open`/`assigned`. |

There are no reply, attachment, SLA, notification, analytics, or realtime endpoints in this phase.

## Data/index notes

- `HelpdeskQueue`: unique `{companyId, nameKey}`; categories are embedded and service/model validation enforces queue-local normalized uniqueness.
- `HelpdeskTenantConfig`: unique `{companyId}`.
- `HelpdeskTicket` in shared `SupportTicket`: unique partial `{companyId, ticketNumber}` for `ticketKind: "HELPDESK"`; queue listing index `{companyId, queueId, createdAt}` for Helpdesk discriminator rows.
- `TenantSequence`: existing unique `{companyId, key}` index is reused for the atomic Helpdesk counter.
- Existing legacy `SupportTicket` indexes are preserved; historical records are not rewritten.

## Environment and packages

- No new environment variables.
- No new runtime or development packages.
- `.env` files are unchanged.

## Verification

Targeted hermetic suite:

```powershell
cd .\Backend
npm run test:helpdesk
```

RBAC, historical Profile Change Request, Phase 36, and Phase 37 regression suites should also pass before release; see the implementation handoff's exact commands/results.

## Windows PowerShell localhost acceptance

Run the backend as usual and use a real employee token for `$EmployeeHeaders` and an authorized tenant-admin token for `$AdminHeaders`. The token variables below are local PowerShell variables only; they are not application environment configuration.

```powershell
$Base = 'http://localhost:5000/api/helpdesk'
$EmployeeHeaders = @{ Authorization = "Bearer $EmployeeToken" }
$AdminHeaders = @{ Authorization = "Bearer $AdminToken" }

# A new tenant starts disabled; this must return enabled = false.
Invoke-RestMethod -Method Get -Uri "$Base/config" -Headers $EmployeeHeaders

# Enable Helpdesk (authorized Company Admin / HR Manager only).
$Settings = @{ enabled = $true; allowEmployeeTickets = $true; defaultPriority = 'normal' } | ConvertTo-Json
Invoke-RestMethod -Method Patch -Uri "$Base/config" -Headers $AdminHeaders -ContentType 'application/json' -Body $Settings

# Create a service queue. Use active same-tenant user IDs for explicit membership.
$QueueBody = @{
  name = 'People Operations'
  description = 'Employee service requests'
  agents = @('<active-agent-user-id>')
  managers = @('<active-queue-manager-user-id>')
  categories = @(@{ name = 'Access request'; description = 'Account and equipment access' })
  confidentiality = @{ enabled = $false; agentIds = @(); reviewerIds = @() }
} | ConvertTo-Json -Depth 8
$Queue = Invoke-RestMethod -Method Post -Uri "$Base/admin/queues" -Headers $AdminHeaders -ContentType 'application/json' -Body $QueueBody

# Open a ticket using the returned queue/category IDs. The response ticketNumber
# should look like HD-000001 and effective priority should follow tenant config.
$TicketBody = @{
  queueId = $Queue.data.id
  categoryId = $Queue.data.categories[0].id
  subject = 'Laptop access'
  description = 'Please provision a laptop account.'
  requestedPriority = 'urgent'
} | ConvertTo-Json
$Ticket = Invoke-RestMethod -Method Post -Uri "$Base/tickets" -Headers $EmployeeHeaders -ContentType 'application/json' -Body $TicketBody
$Ticket.data | Select-Object ticketNumber, status, priority

# Requester sees only their own ticket list.
Invoke-RestMethod -Method Get -Uri "$Base/tickets/mine" -Headers $EmployeeHeaders
```

Negative checks: an Employee token must receive `403` on `PATCH /config` and queue administration; a body containing `companyId`, `userId`, or `employeeId` must be rejected; a ticket creation with a disabled queue/category or a category from another queue must be rejected; a manager not listed as a restricted agent/reviewer must not retrieve a confidential ticket. Repeat with a second tenant to confirm queue/ticket IDs and ticket numbers never cross tenant boundaries.

## Deferred follow-on phases

Phase 38.2 adds only the employee ticket lifecycle API (creation, requester-scoped list/details, and atomic self-cancellation); it adds no frontend. Frontend pages/forms/routes, conversation/reply persistence, attachments and private storage, SLAs, notification delivery, analytics, and Helpdesk realtime remain outside Phase 38.2 and require separate approved scope.
