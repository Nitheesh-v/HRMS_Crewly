# Phase 38.5 — Helpdesk SLA Policies and Durable Clocks

**Status:** Backend implementation and hermetic tests are complete; localhost acceptance remains pending.
**Scope:** Phase 38.5 only. Tenant/queue-specific SLA configuration, ticket clock state, authorized read APIs, and restart-safe reconciliation for the existing `HELPDESK` discriminator. No frontend, notifications/realtime delivery, AI, or HR-domain mutation.

## What changed

Every newly created Helpdesk ticket snapshots its enabled queue policy and server-derived effective priority. It receives independent first-response and resolution clocks. The snapshot (schedule, timezone, holiday context, targets and policy version) is stored on the Mongo ticket; warning eligibility, pause/completion/breach state, next due action and escalation eligibility are also durable Mongo fields.

**Legacy behavior is intentionally safe:** existing tickets without an `sla` snapshot are not backfilled, backdated, or silently started when a policy is added. A queue policy update affects future ticket creation. Existing tickets keep their frozen schedule/targets until an explicit supported priority or queue transfer change. A priority change rebases only active, unbreached clocks using elapsed active time and the ticket's frozen target table. A transfer to a queue with an enabled SLA policy rebases remaining active clocks to that destination policy; transfer to a queue without an enabled SLA policy keeps the ticket's prior snapshot. Breach/warning history is sticky. No existing ticket is bulk-rewritten.

## API

All paths are relative to `/api/helpdesk`, and retain the existing authenticated tenant, subscription, RBAC, queue membership, requester ownership, and confidentiality checks.

| Method | Path | Authorization / behavior |
|---|---|---|
| `GET` | `/admin/queues/:queueId/sla-policy` | `HELPDESK_QUEUE_MANAGE`; reads one queue policy under `req.companyId`. A missing policy returns `{ configured: false, policy: null }`. |
| `PUT` | `/admin/queues/:queueId/sla-policy` | `HELPDESK_QUEUE_MANAGE` plus write access; full policy replacement. Service validation rejects unknown fields, invalid enums, non-number durations, invalid IANA zones, malformed/overlapping windows and out-of-range values. Policy version uses compare-and-set. |
| `GET` | `/tickets/:ticketNumber/sla` | Existing requester-self or authorized queue read path. Ticket authorization/confidentiality is checked before returning the safe clock summary. Requesters do not receive escalation routing details; authorized staff can. Legacy tickets return `{ configured: false }`. |

Policy fields:

- `enabled`: new-ticket snapshot creation on/off; disabling does not erase existing ticket snapshots.
- `clockMode`: `CALENDAR` or `BUSINESS_HOURS`.
- `timeZone`: valid IANA timezone (for example `Asia/Kolkata`); arithmetic never uses the API host's local timezone.
- `excludeHolidays`: only valid for `BUSINESS_HOURS`; reuses `scheduleEngine.getHolidaysForUser` and its requester department/branch/optional-holiday context. Calendar read failure returns a safe unavailable error rather than guessing a deadline.
- `weeklyHours`: exactly one `SUN`…`SAT` entry, up to four sorted, non-overlapping, same-day `HH:mm` windows per weekday. Business schedules need at least 60 minutes per week. DST gaps move forward deterministically; fall-back openings use the first instant and closings use the last.
- `targets`: `low`, `normal`, `high`, and `urgent`, each with integer `firstResponseMinutes` and `resolutionMinutes` from 1 through 10,080 (7 days).
- `warningPercent`: integer 1–99; each independent clock gets its own warning threshold.
- `pauseStatuses`: per-clock subset of `waiting_for_employee` and `waiting_for_department`; defaults pause resolution for `waiting_for_employee` and do not pause first response.

## Clock and workflow rules

- First response completes only from the earliest persisted **public** message authored by non-requester Helpdesk staff. Requester replies, internal notes, assignments, status changes and automation do not count. The service re-queries immutable tenant/ticket-scoped message history, orders by `createdAt` and `_id`, and conditionally persists the earliest timestamp. If message history cannot be read, it leaves the clock unchanged for worker recovery rather than guessing from the latest in-memory reply.
- Resolution completes only when the existing authorized ticket workflow validly moves the ticket to `resolved`. Reopening from `resolved` resumes remaining active time; completion history is retained. Closing/cancellation stops unfinished clocks without fabricating completion. Due warning/breach events are applied before a status transition.
- The first-response and resolution clocks are independent. Pausing one does not pause the other unless its own policy says so.
- Warnings, breaches, escalation eligibility and prior breach history are durable. Escalation is operational attention only: the ticket stores `ELIGIBLE`, the current queue ID, timestamp and trigger names. It does not assign a person, resolve the ticket, approve/reject an HR request, change Payroll/access, or deliver an alert. The authorized queue view/detail/SLA summary is the available attention surface; notification/realtime delivery is deferred to Phase 38.6.
- Requester DTOs contain only clock status/targets/deadlines and omit escalation. Agent/queue-manager DTOs include the escalation state only after existing ticket/queue/confidentiality authorization succeeds.

## Persistence, recovery, and deployment impact

Mongo is the authority for policy versions, ticket clock state and reconciliation eligibility. Ticket/message timestamps are server-generated and persisted; browser-provided time/tenant identity is not used. Service transitions use version/next-action conditional writes, and the worker re-reads each candidate with its tenant and `HELPDESK` discriminator before applying a compare-and-set. Duplicate worker instances/retries may inspect the same due row, but only one matching version transition wins. This is idempotent recovery, **not** an exactly-once guarantee. Queries are bounded and due work is indexed. Logs contain aggregate counts only—no message bodies, ticket descriptions, or raw queue payloads.

The existing `node src/workers/index.js` process remains separate from the API. Phase 38.5 adds a startup sweep and a non-overlapping 60-second periodic sweep, capped at 100 ticket candidates per pass (service hard cap: 250). The sweep updates warnings, breach markers and escalation eligibility; it sends no notifications. **Starting the API alone does not start SLA reconciliation.** The existing worker requires the repository's configured Redis and MongoDB because it also serves the other worker queues. Time arithmetic reuses the already-installed Luxon 3.7.2 and `scheduleEngine`; no new worker command, environment variable, package, `.env` edit, or service dependency was added.

Before enabling SLA policies in production:

1. Review/deploy indexes through the repository's normal Mongo index process; do not assume Mongoose auto-indexing is enabled in production.
2. Deploy Phase 38.5 API code to all API instances and deploy/restart the existing worker process with the new code. Keep policies disabled until both are ready; an API-only deployment does not persist due warnings/breaches/escalation transitions.
3. Enable policies queue by queue after verifying tenant queue IDs, timezone, business windows, target durations, holiday sources and worker health. If business-hour holiday data is unavailable at ticket creation or a required rebase, the service fails closed; ticket creation/status/priority/transfer may return an unavailable/validation error rather than store a guessed clock.
4. Verify index health and test on a non-production tenant before release. Existing Helpdesk tickets remain untracked unless they already have an SLA snapshot; no backfill or migration job is included.

Declared index impact:

- New `HelpdeskSlaPolicy` collection: unique `{ companyId: 1, queueId: 1 }` policy index.
- Existing `SupportTicket` Helpdesk discriminator: partial due-sweep index `{ 'sla.nextActionAt': 1, companyId: 1, _id: 1 }`, only where `ticketKind: 'HELPDESK'` and `sla.nextActionAt` is a date.
- Existing `HelpdeskMessage` collection: partial public-message chronological index `{ companyId: 1, ticketId: 1, createdAt: 1, _id: 1 }`, only where `messageType: 'PUBLIC'`.

No index build, live migration, production worker, MongoDB, Redis, SMTP, Cloudinary, or notification delivery was run during hermetic verification.

## Hermetic verification

Run from `Backend`:

```powershell
npm run test:helpdesk
npm run test:helpdesk-lifecycle
npm run test:helpdesk-agents
npm run test:helpdesk-conversations
npm run test:helpdesk-sla
```

`helpdeskSla.test.js` uses injected in-memory models and covers strict policy validation, tenant isolation, timezone/business-hours/holiday/DST math, independent pause/resume, first qualifying public staff reply and earliest timestamp recovery, resolution/reopen, priority/queue changes, warnings/breaches/escalation, bounded worker retries/CAS, authorized routes/validators and safe DTOs. The suite does not connect to MongoDB or Redis and does not start production workers.

Verification completed for this change (all suites used injected/fake models; no live MongoDB or Redis connection was made):

| Command | Result |
|---|---:|
| `npm run test:helpdesk` | 15 passed, 0 failed |
| `npm run test:helpdesk-lifecycle` | 15 passed, 0 failed |
| `npm run test:helpdesk-agents` | 19 passed, 0 failed |
| `npm run test:helpdesk-conversations` | 16 passed, 0 failed |
| `npm run test:helpdesk-sla` | 25 passed, 0 failed |
| `npm run test:rbac-bootstrap` | 17 passed, 0 failed |
| `npm run test:profile-changes` | 31 passed, 0 failed |
| `npm run test:phase36-closeout` | 49 passed, 0 failed |
| `npm run test:presence` | 217 passed, 0 failed |
| `npm run test:query-hygiene` | 3 passed, 0 failed |
| `npm run test:schema-hygiene` | 8 passed, 0 failed |
| `MONGO_URI='mongodb://127.0.0.1:27017/crewly_hermetic_phase38_5' REDIS_ENABLED=false NODE_ENV=test npm run test:all` | 3,478 passed, 0 failed, 0 skipped across 178 suites |
| `node --check` on all changed JavaScript modules/test files | passed |
| Runtime import smoke for SLA rules/service/model/controller/routes | passed |
| `git diff --check` | passed |

The `MONGO_URI` above is a process-local test placeholder; tests do not connect to it. Exact commands and results do not replace localhost acceptance or deployed index/worker verification.

## Windows PowerShell localhost acceptance

Use only a disposable local tenant/database and local development accounts. Keep real local tokens in the PowerShell session only; do not print, paste, export, or commit them. Do not use production/staging tenant IDs, tokens, MongoDB URIs, or Redis URLs.

### 1. Start the API with local MongoDB

Use the repository's normal local development setup. This command-line setup is session-local and does not edit `.env`:

```powershell
Set-Location .\Backend
$env:NODE_ENV = 'development'
$env:PORT = '5000'
$env:MONGO_URI = 'mongodb://127.0.0.1:27017/crewly_phase38_5_local'
$env:REDIS_ENABLED = 'false'
npm run dev
```

Keep the Backend window running. In another PowerShell window, set the same local Mongo environment variables for commands below. The tenant must have Helpdesk enabled, an enabled queue/category, a queue manager with `HELPDESK_QUEUE_MANAGE`, and an explicit active queue agent with ticket read/manage permissions.

```powershell
$BaseUrl = 'http://localhost:5000/api/helpdesk'
$ManagerToken = '<LOCAL_DEVELOPMENT_QUEUE_MANAGER_TOKEN>'
$AgentToken = '<LOCAL_DEVELOPMENT_QUEUE_AGENT_TOKEN>'
$EmployeeToken = '<LOCAL_DEVELOPMENT_EMPLOYEE_TOKEN>'
$QueueId = '<LOCAL_ENABLED_QUEUE_ID>'
$CategoryId = '<LOCAL_ENABLED_CATEGORY_ID>'
$ManagerHeaders = @{ Authorization = "Bearer $ManagerToken" }
$AgentHeaders = @{ Authorization = "Bearer $AgentToken" }
$EmployeeHeaders = @{ Authorization = "Bearer $EmployeeToken" }
```

### 2. Configure a short calendar policy for the disposable queue

```powershell
$WeeklyHours = @(
  @{ weekday = 'SUN'; windows = @() },
  @{ weekday = 'MON'; windows = @(@{ start = '09:00'; end = '17:00' }) },
  @{ weekday = 'TUE'; windows = @(@{ start = '09:00'; end = '17:00' }) },
  @{ weekday = 'WED'; windows = @(@{ start = '09:00'; end = '17:00' }) },
  @{ weekday = 'THU'; windows = @(@{ start = '09:00'; end = '17:00' }) },
  @{ weekday = 'FRI'; windows = @(@{ start = '09:00'; end = '17:00' }) },
  @{ weekday = 'SAT'; windows = @() }
)
$Targets = @{
  low = @{ firstResponseMinutes = 1; resolutionMinutes = 2 }
  normal = @{ firstResponseMinutes = 1; resolutionMinutes = 2 }
  high = @{ firstResponseMinutes = 1; resolutionMinutes = 2 }
  urgent = @{ firstResponseMinutes = 1; resolutionMinutes = 2 }
}
$Policy = @{
  enabled = $true
  clockMode = 'CALENDAR'
  timeZone = 'Asia/Kolkata'
  excludeHolidays = $false
  weeklyHours = $WeeklyHours
  targets = $Targets
  warningPercent = 80
  pauseStatuses = @{ firstResponse = @(); resolution = @('waiting_for_employee') }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod -Method Put `
  -Uri "$BaseUrl/admin/queues/$QueueId/sla-policy" `
  -Headers $ManagerHeaders -ContentType 'application/json' -Body $Policy
```

A successful response should show `configured = true`, version `1` (or a higher version if you updated an existing local policy), and the saved timezone/targets. Try an invalid timezone, unsupported priority, `companyId`, string duration, or overlapping schedule window; expect a validation error and no policy change.

### 3. Create a ticket and inspect its independent clocks

```powershell
$TicketBody = @{
  queueId = $QueueId
  categoryId = $CategoryId
  subject = 'Local SLA acceptance'
  description = 'Disposable local test ticket; do not include sensitive data.'
} | ConvertTo-Json -Depth 5
$Created = Invoke-RestMethod -Method Post `
  -Uri "$BaseUrl/tickets" `
  -Headers $EmployeeHeaders -ContentType 'application/json' -Body $TicketBody
$TicketNumber = $Created.data.ticketNumber

$Sla = Invoke-RestMethod -Method Get `
  -Uri "$BaseUrl/tickets/$TicketNumber/sla" `
  -Headers $EmployeeHeaders
$Sla.data.firstResponse
$Sla.data.resolution
```

The configured clocks should start from the stored ticket creation timestamp and show separate due/warning times. The employee must not see `escalation` in the response.

### 4. Verify warning/breach and queue-manager escalation visibility

Warnings/breach markers/escalation eligibility are persisted by the **separate existing worker**, not by API startup. If a local Redis service is already installed and running, use a second PowerShell window and the same disposable local Mongo database to start it. Never point this window at a shared or production Redis instance:

```powershell
Set-Location .\Backend
$env:NODE_ENV = 'development'
$env:MONGO_URI = 'mongodb://127.0.0.1:27017/crewly_phase38_5_local'
$env:REDIS_ENABLED = 'true'
$env:REDIS_URL = 'redis://127.0.0.1:6379'
npm run worker
```

The existing worker performs one startup reconciliation and then a bounded pass every 60 seconds. Leave the new ticket without a staff reply for at least 70 seconds, then query the ticket SLA as the queue agent. The first-response clock should be `BREACHED`; its escalation should be `ELIGIBLE` for the current queue. The employee SLA response should still omit escalation. If local Redis is unavailable, do not run the worker against another environment; the API/clock read can still be inspected, but persisted warning/breach reconciliation has not been localhost-accepted.

### 5. Verify first response, notes, pause/resume and resolution

Use a **second disposable ticket** for the response test so the first remains unreplied for the breach check. Create it and save its ticket number, then post a public reply as the authorized queue agent:

```powershell
$SecondTicketBody = @{
  queueId = $QueueId
  categoryId = $CategoryId
  subject = 'Local SLA response acceptance'
  description = 'Second disposable local SLA test ticket.'
} | ConvertTo-Json -Depth 5
$SecondTicket = Invoke-RestMethod -Method Post `
  -Uri "$BaseUrl/tickets" `
  -Headers $EmployeeHeaders -ContentType 'application/json' -Body $SecondTicketBody
$SecondTicketNumber = $SecondTicket.data.ticketNumber

$ReplyBody = @{ body = 'Public staff response for local acceptance'; messageType = 'public' } | ConvertTo-Json
Invoke-RestMethod -Method Post `
  -Uri "$BaseUrl/tickets/$SecondTicketNumber/messages" `
  -Headers $AgentHeaders -ContentType 'application/json' -Body $ReplyBody
Invoke-RestMethod -Method Get `
  -Uri "$BaseUrl/tickets/$SecondTicketNumber/sla" `
  -Headers $AgentHeaders
```

The response clock should complete; the resolution clock must remain independent. Use a **third fresh ticket** to confirm that neither a requester public reply nor an internal note completes first response:

```powershell
$ThirdTicketBody = @{
  queueId = $QueueId
  categoryId = $CategoryId
  subject = 'Local SLA non-qualifying reply test'
  description = 'Third disposable local SLA test ticket.'
} | ConvertTo-Json -Depth 5
$ThirdTicket = Invoke-RestMethod -Method Post `
  -Uri "$BaseUrl/tickets" `
  -Headers $EmployeeHeaders -ContentType 'application/json' -Body $ThirdTicketBody
$ThirdTicketNumber = $ThirdTicket.data.ticketNumber

$RequesterReply = @{ body = 'Requester follow-up'; messageType = 'public' } | ConvertTo-Json
Invoke-RestMethod -Method Post `
  -Uri "$BaseUrl/tickets/$ThirdTicketNumber/messages" `
  -Headers $EmployeeHeaders -ContentType 'application/json' -Body $RequesterReply
$InternalNote = @{ body = 'Internal-only acceptance note'; messageType = 'internal' } | ConvertTo-Json
Invoke-RestMethod -Method Post `
  -Uri "$BaseUrl/tickets/$ThirdTicketNumber/messages" `
  -Headers $AgentHeaders -ContentType 'application/json' -Body $InternalNote
$ThirdSla = Invoke-RestMethod -Method Get `
  -Uri "$BaseUrl/tickets/$ThirdTicketNumber/sla" `
  -Headers $AgentHeaders
$ThirdSla.data.firstResponse
```

Confirm `firstResponse.firstResponseAt` remains empty and it is not `COMPLETED` (it may become `WARNING` or `BREACHED` if the short test deadline passes). On the second ticket, move it into progress, pause resolution, resume it, then resolve it using the existing authorized status route:

```powershell
$InProgressBody = @{ status = 'in_progress' } | ConvertTo-Json
Invoke-RestMethod -Method Patch `
  -Uri "$BaseUrl/tickets/$SecondTicketNumber/status" `
  -Headers $AgentHeaders -ContentType 'application/json' -Body $InProgressBody
$WaitingBody = @{ status = 'waiting_for_employee' } | ConvertTo-Json
Invoke-RestMethod -Method Patch `
  -Uri "$BaseUrl/tickets/$SecondTicketNumber/status" `
  -Headers $AgentHeaders -ContentType 'application/json' -Body $WaitingBody
$PausedSla = Invoke-RestMethod -Method Get `
  -Uri "$BaseUrl/tickets/$SecondTicketNumber/sla" `
  -Headers $AgentHeaders
$PausedSla.data.resolution

$ResumeBody = @{ status = 'in_progress' } | ConvertTo-Json
Invoke-RestMethod -Method Patch `
  -Uri "$BaseUrl/tickets/$SecondTicketNumber/status" `
  -Headers $AgentHeaders -ContentType 'application/json' -Body $ResumeBody
$ResumedSla = Invoke-RestMethod -Method Get `
  -Uri "$BaseUrl/tickets/$SecondTicketNumber/sla" `
  -Headers $AgentHeaders
$ResumedSla.data.resolution

$ResolvedBody = @{ status = 'resolved' } | ConvertTo-Json
Invoke-RestMethod -Method Patch `
  -Uri "$BaseUrl/tickets/$SecondTicketNumber/status" `
  -Headers $AgentHeaders -ContentType 'application/json' -Body $ResolvedBody
```

The second ticket's resolution should complete only on that valid `resolved` workflow transition. Use fresh tickets or reset the local database between scenarios because resolved/closed/cancelled tickets are not message-write targets.

### 6. Security checks

- Attempt policy GET/PUT as a user without `HELPDESK_QUEUE_MANAGE`; expect denial.
- Attempt to read a foreign-tenant queue policy or a ticket the caller cannot read; expect a non-enumerating not-found response.
- Attempt to supply a body `companyId`, different queue ID, unsupported priority, or unsupported ticket fields; expect validation rejection. Tenant authority must remain the authenticated tenant.
- A requester must never receive escalation queue details. A queue agent/manager sees SLA/escalation only when existing explicit queue and confidentiality rules authorize the ticket.
- A public requester reply, an internal note, assignment, status change or automation must not become first response. A valid authorized public agent reply does.
- Confirm escalation changes only durable Helpdesk SLA state/queue eligibility. It must not assign, close, resolve, approve/reject an HR request, or write Attendance, Leave or Payroll.

Close the API/worker windows after testing; command-scoped environment changes then disappear. Do not drop or modify a database that is not dedicated to this disposable acceptance run.

## Deferred phases

Phase 38.6 owns notification/realtime delivery; 38.5 stores eligibility only. Knowledge base, Helpdesk analytics, AI, frontend UI, and later Phase 38.7–38.11 work remain outside this unit. No SLA endpoint sends notifications, and no automation resolves a ticket or makes an HR decision.
