# Phase 38.3 — Helpdesk Queue-Agent Operations

**Status:** Backend implementation and hermetic regression tests are complete; local Windows/Postman acceptance is pending.
**Scope boundary:** Phase 38.3 only. This extends the existing Phase 38.1/38.2 Helpdesk APIs and shared `SupportTicket` discriminator. It adds no frontend, alternate ticket model/status/history system, or Phase 38.4 work.

## Scope and existing contracts

Phase 38.3 adds authorized queue views and operational mutations for Helpdesk agents/managers while preserving employee ticket creation, requester-owned lists/details, and atomic requester cancellation. Tickets continue to use `HelpdeskTicket` (`ticketKind: "HELPDESK"`) in the existing support-ticket collection. Legacy/platform support ticket routes remain isolated by their existing `LEGACY_SUPPORT` filter.

No replies/internal notes, attachments, SLA, notifications/realtime/NATS, auto-assignment, AI, analytics, reopening endpoint, or HR action is added. No organizational Department or manager hierarchy is used for Helpdesk access.

## Identity, authorization, tenancy, and confidentiality

- Tenant identity is derived only from authenticated middleware as `req.companyId`; actor/viewer identity is `req.user._id`. Tenant, requester, actor, assignee, and audit identity are not trusted from request bodies or filters.
- HTTP routes retain authentication, tenant context, subscription checks, RBAC, and write-access middleware. `HELPDESK_TICKET_READ` / `HELPDESK_TICKET_MANAGE` are necessary route permissions, not substitutes for queue membership.
- The service checks the queue's explicit `agents` and `managers` membership arrays. Claim requires an explicit queue agent. Assignment/reassignment requires a queue manager. Transfer requires manager membership in both source and destination queues. Organizational department, reporting relationships, and a generic `MANAGER` role do not grant queue access.
- Queue reads/details and mutations remain company- and `HELPDESK`-discriminator-scoped. Missing/unauthorized records are non-enumerating (`404`); invalid input is `400`; a stale/ineligible state or lost compare-and-set returns `409`.
- Confidential-ticket visibility stays narrow: the requester, a queue agent explicitly listed as a restricted confidential agent, or an explicitly listed reviewer can read. A reviewer can list confidential tickets but cannot mutate them by reviewer status alone. Managers, reporting managers, and assigned agents do not bypass the confidential-agent allowlist. Confidential transfer requires the tenant setting, destination queue policy, and restricted access in the destination queue; an assignee must be an active restricted agent there.
- Agent list DTOs are allowlisted and omit descriptions, requester identities, full User records, and unrelated HR/payroll/medical data. Authorized detail DTOs contain only Helpdesk ticket fields (including its description and opaque requester ID). Lists use bounded pagination and literal, capped search and return `hasMore`, not a total that could reveal hidden confidential rows.
- Mutations use conditional MongoDB updates anchored to tenant, discriminator, ticket number, queue, current status, current assignee, and priority snapshot where applicable. This prevents concurrent claim/assignment/transfer/status/priority operations from silently overwriting stale state.
- The existing global audit middleware records the authenticated actor, company, method/path, response status, IP, and a safe operation label. It does not log request bodies or ticket descriptions.

## Agent API

All paths are relative to `http://localhost:5000/api/helpdesk`. Successful responses use `{ success, message, data }`; paginated queue views also include a top-level `meta` object.

| Method | Path | Behavior and authorization |
|---|---|---|
| `GET` | `/queues/:queueId/tickets` | Queue view; requires `HELPDESK_TICKET_READ` and explicit queue agent/manager or reviewer membership. Optional query allowlist: `status`, `priority`, `search`, `sort`, `page`, `limit`. |
| `GET` | `/queues/:queueId/tickets/assigned-to-me` | Same queue authorization and filters, additionally pinned to the authenticated actor's `assignedTo` value. |
| `GET` | `/queues/:queueId/tickets/unassigned` | Same queue authorization and filters, pinned to unassigned tickets. |
| `GET` | `/tickets/:ticketNumber` | Existing route, reused. Requesters receive their own employee detail DTO; authorized queue staff/reviewers receive the minimized agent detail DTO subject to confidentiality. |
| `PATCH` | `/tickets/:ticketNumber/claim` | Body is `{}`. An explicit queue agent may claim only an `open`, unassigned ticket. Claim atomically sets assignee and `assigned` status. |
| `PATCH` | `/tickets/:ticketNumber/assignment` | Body `{ "assigneeId": "<active same-tenant queue-agent id>" }`. Queue-manager membership is required; assignment/reassignment is atomic. Confidential tickets require a restricted agent. |
| `PATCH` | `/tickets/:ticketNumber/priority` | Body `{ "priority": "low" | "normal" | "high" | "urgent" }`. Queue staff may change effective priority on non-terminal tickets. Requester `requestedPriority` remains a non-authoritative hint. |
| `PATCH` | `/tickets/:ticketNumber/status` | Body `{ "status": "<allowlisted next status>" }`. Queue staff can use only the centralized transition graph; terminal `closed`/`cancelled` tickets cannot reopen. |
| `PATCH` | `/tickets/:ticketNumber/transfer` | Body `{ "queueId": "<destination queue id>", "categoryId": "<enabled destination category id>", "assigneeId": "<optional active destination agent id>" }`. Actor must manage both queues. The destination queue/category and any assignee are revalidated within the tenant. |

Queue-list `sort` values are `newest`, `oldest`, and `recently_updated`; `page` defaults to 1 and is capped at 10,000; `limit` defaults to 20 and is capped at 100; `search` is trimmed, literal, and at most 60 characters. Unsupported filters, including `companyId`, `actorId`, `userId`, `assignedTo`, or client-selected queue identity, are rejected.

The existing state graph is reused, not replaced:

- `open` → `assigned`, `in_progress`, `cancelled`
- `assigned` → `open`, `in_progress`, `cancelled`
- `in_progress` → `waiting_for_employee`, `waiting_for_department`, `resolved`
- `waiting_for_employee` → `in_progress`, `resolved`, `cancelled`
- `waiting_for_department` → `in_progress`, `resolved`
- `resolved` → `in_progress`, `closed`
- `closed` and `cancelled` → no transitions

Marking a ticket `assigned` requires a currently active, explicit queue agent (and a restricted agent for confidential tickets). The allowed `assigned` → `open` transition clears `assignedTo` in the same atomic update so the ticket returns to the unassigned queue. Phase 38.3 adds no dedicated reopen operation; closed/cancelled tickets remain terminal.

## Database and compatibility notes

Phase 38.3 adds discriminator-partial indexes for queue lists and assignment views with deterministic `_id` tie-breakers. Existing tenant/ticket-number and requester indexes are retained. No migration, destructive backfill, live index build, or production database operation was run; deploy indexes through the repository's normal index-management process.

The Phase 38.1 queue/ticket contracts, Phase 38.2 employee routes, Phase 38.2 atomic requester cancellation, and legacy support-ticket isolation are unchanged. No environment variables or packages are required.

## Hermetic verification

Run from `Backend`:

```powershell
npm run test:helpdesk
npm run test:helpdesk-lifecycle
npm run test:helpdesk-agents
```

The Phase 38.3 agent suite uses injected models and in-memory query fakes; it does not connect to MongoDB, Redis, SMTP, Cloudinary, or NATS. Verification completed for this implementation:

| Command | Result |
|---|---:|
| `npm run test:helpdesk` | 15 passed, 0 failed |
| `npm run test:helpdesk-lifecycle` | 15 passed, 0 failed |
| `npm run test:helpdesk-agents` | 19 passed, 0 failed |
| `npm run test:rbac-bootstrap` | 17 passed, 0 failed |
| `npm run test:profile-changes` | 31 passed, 0 failed |
| `npm run test:phase36-closeout` | 49 passed, 0 failed |
| `npm run test:presence` | 217 passed, 0 failed |
| `npm run test:query-hygiene` | 3 passed, 0 failed |
| `npm run test:schema-hygiene` | 8 passed, 0 failed |
| `MONGO_URI='mongodb://127.0.0.1:27017/crewly_full_test' NODE_ENV=test npm run test:all` | 3,437 passed, 0 failed across 178 suites |

The `test:all` environment values are command-local and do not modify `.env`; the final run passed without production service connections. One earlier full-suite attempt transiently cancelled 47 subtests in the unrelated Chat Socket Foundation 20 ms timeout case (`Promise resolution is still pending but the event loop has already resolved`); `node --test test/chatSocketFoundation.test.js` passed 92/92 in isolation, and the subsequent full-suite rerun passed 3,437/3,437. Syntax checks also passed for the changed Helpdesk modules. Unit tests do not replace the localhost acceptance below.

## Windows PowerShell localhost acceptance

Use a **local development** tenant and accounts only. Start the Backend and its local MongoDB using the repository's normal development setup. Configure an enabled queue with at least two active explicit agents and an explicit queue manager; for transfer, configure a second enabled queue/category and make the test manager an explicit manager of both queues. Grant the existing Helpdesk permissions through Crewly RBAC. Use a non-confidential test ticket unless you are deliberately validating restricted-access behavior.

Keep development access tokens and employee IDs in a private local PowerShell session. Do not paste real tokens into chat, commit them, or write them into this document. Replace every angle-bracket placeholder privately:

```powershell
$BaseUrl = 'http://localhost:5000/api/helpdesk'
$AgentToken = '<LOCAL_DEVELOPMENT_AGENT_TOKEN>'
$ManagerToken = '<LOCAL_DEVELOPMENT_QUEUE_MANAGER_TOKEN>'
$QueueId = '<SOURCE_QUEUE_ID>'
$TargetQueueId = '<DESTINATION_QUEUE_ID>'
$TargetCategoryId = '<ENABLED_DESTINATION_CATEGORY_ID>'
$AgentUserId = '<ACTIVE_AGENT_ID_IN_SOURCE_QUEUE>'
$TargetAgentUserId = '<ACTIVE_AGENT_ID_IN_DESTINATION_QUEUE>'
$AgentHeaders = @{ Authorization = "Bearer $AgentToken" }
$ManagerHeaders = @{ Authorization = "Bearer $ManagerToken" }

# 1. Read the queue view. A normal queue agent sees no confidential rows.
$QueueView = Invoke-RestMethod -Method Get `
  -Uri "$BaseUrl/queues/$QueueId/tickets?page=1&limit=20&sort=newest" `
  -Headers $AgentHeaders
$QueueView.meta

# 2. Read the assigned-to-me and unassigned views. These selectors do not accept
#    an assignee or actor identity from the caller.
$AssignedToMe = Invoke-RestMethod -Method Get `
  -Uri "$BaseUrl/queues/$QueueId/tickets/assigned-to-me?page=1&limit=20" `
  -Headers $AgentHeaders
$Unassigned = Invoke-RestMethod -Method Get `
  -Uri "$BaseUrl/queues/$QueueId/tickets/unassigned?page=1&limit=20" `
  -Headers $AgentHeaders

# 3. Claim one open, unassigned test ticket as the authenticated queue agent.
$TicketNumber = $Unassigned.data[0].ticketNumber
$Claimed = Invoke-RestMethod -Method Patch `
  -Uri "$BaseUrl/tickets/$TicketNumber/claim" `
  -Headers $AgentHeaders -ContentType 'application/json' -Body '{}'

# 4. The manager can atomically assign/reassign to an active explicit queue agent.
$AssignmentBody = @{ assigneeId = $AgentUserId } | ConvertTo-Json -Compress
$Assigned = Invoke-RestMethod -Method Patch `
  -Uri "$BaseUrl/tickets/$TicketNumber/assignment" `
  -Headers $ManagerHeaders -ContentType 'application/json' -Body $AssignmentBody

# 5. Exercise operational priority and a valid state transition.
$PriorityBody = @{ priority = 'high' } | ConvertTo-Json -Compress
$Priority = Invoke-RestMethod -Method Patch `
  -Uri "$BaseUrl/tickets/$TicketNumber/priority" `
  -Headers $AgentHeaders -ContentType 'application/json' -Body $PriorityBody
$StatusBody = @{ status = 'in_progress' } | ConvertTo-Json -Compress
$InProgress = Invoke-RestMethod -Method Patch `
  -Uri "$BaseUrl/tickets/$TicketNumber/status" `
  -Headers $AgentHeaders -ContentType 'application/json' -Body $StatusBody

# 6. Transfer as a manager of both queues; the chosen assignee must be an active
#    explicit agent in the destination queue (restricted if the ticket is confidential).
$TransferBody = @{
  queueId = $TargetQueueId
  categoryId = $TargetCategoryId
  assigneeId = $TargetAgentUserId
} | ConvertTo-Json -Compress
$Transferred = Invoke-RestMethod -Method Patch `
  -Uri "$BaseUrl/tickets/$TicketNumber/transfer" `
  -Headers $ManagerHeaders -ContentType 'application/json' -Body $TransferBody

# 7. Confirm the existing agent detail route returns the updated, minimized DTO.
$Details = Invoke-RestMethod -Method Get `
  -Uri "$BaseUrl/tickets/$TicketNumber" `
  -Headers $ManagerHeaders
$Details.data | Select-Object ticketNumber, subject, queue, category, status, priority, assignedTo
```

If no unassigned ticket exists, create a disposable employee test ticket using the existing Phase 38.2 workflow; do not use a production employee's ticket. Delete is not part of this workflow, so use local-only test data. Run the requests with the correct actor token: assignment and transfer require queue-manager membership, while claim requires agent membership.

Negative/security checks (repeat with safe local accounts and test data):

1. A normal agent who is not a restricted confidential agent must not see a confidential ticket in list/detail, even if it is assigned to them. A queue manager or reporting manager without the restricted membership must also get a non-enumerating `404`. A listed reviewer may read/list confidential tickets but must not claim, assign, transfer, reprioritize, or transition them without queue-agent membership.
2. A user with a generic manager role or organizational department relationship but no explicit queue membership must get `404` for queue lists/details/actions. An ordinary agent must not use manager-only assignment or transfer.
3. Submit a body/query containing `companyId`, `actorId`, `userId`, `assignedTo`, or an unsupported filter; expect `400`. The authenticated actor and tenant remain server-derived.
4. Try an assignee inactive in the tenant, not in the queue, or from another tenant; expect rejection and no ticket update. Try a disabled/foreign destination queue or a category not belonging to the destination; expect rejection and no cross-tenant read/write.
5. Race two local requests to claim the same unassigned ticket, or submit competing assignment/status/priority/transfer requests. At most one stale conditional write should succeed; the loser should receive `409` (a ticket may naturally return another valid error if it became unauthorized after a transfer).
6. Confirm closed/cancelled tickets cannot be mutated or reopened. Confirm a requester can still cancel their own eligible ticket through `PATCH /tickets/mine/:ticketNumber/cancel` and the Phase 38.2 cancellation remains requester-scoped and atomic.

## Postman localhost acceptance

Create a **local-only, unshared** Postman environment. Define `baseUrl` as `http://localhost:5000/api/helpdesk`; store `agentToken` and `managerToken` only in local environment values and disable environment sharing/sync for them. Add non-secret variables `queueId`, `targetQueueId`, `targetCategoryId`, `agentUserId`, `targetAgentUserId`, and `ticketNumber`. Use Bearer Token auth with `{{agentToken}}` for reads/claim/agent operations and `{{managerToken}}` for assignment/transfer. Do not export or commit an environment containing tokens.

Add these requests (all relative to `{{baseUrl}}`):

| Method | URL | Auth | Body / checks |
|---|---|---|---|
| `GET` | `/queues/{{queueId}}/tickets?page=1&limit=20&sort=newest` | Agent | Check `200`; inspect top-level `meta.hasMore`; list must omit description and requester data. |
| `GET` | `/queues/{{queueId}}/tickets/assigned-to-me?page=1&limit=20` | Agent | Check each `data[*].assignedTo` equals the authenticated agent ID. |
| `GET` | `/queues/{{queueId}}/tickets/unassigned?page=1&limit=20` | Agent | Check each `data[*].assignedTo` is null; select a local test ticket and save its `ticketNumber` as `ticketNumber`. |
| `PATCH` | `/tickets/{{ticketNumber}}/claim` | Agent | JSON `{}`; expect `200`, `assignedTo` set to the agent, status `assigned`. |
| `PATCH` | `/tickets/{{ticketNumber}}/assignment` | Manager | JSON `{ "assigneeId": "{{agentUserId}}" }`; expect `200`. |
| `PATCH` | `/tickets/{{ticketNumber}}/priority` | Agent | JSON `{ "priority": "high" }`; expect `200` and effective priority `high`. |
| `PATCH` | `/tickets/{{ticketNumber}}/status` | Agent | JSON `{ "status": "in_progress" }`; expect `200`. |
| `PATCH` | `/tickets/{{ticketNumber}}/transfer` | Manager | JSON `{ "queueId": "{{targetQueueId}}", "categoryId": "{{targetCategoryId}}", "assigneeId": "{{targetAgentUserId}}" }`; expect `200` and the destination queue/category in `data`. |
| `GET` | `/tickets/{{ticketNumber}}` | Manager | Expect `200` only when that manager is authorized to read the ticket; inspect the safe detail DTO. |

Use Postman's Tests tab only for response assertions; do not add scripts that print, forward, or persist authorization tokens. Negative requests above should be run with separate local identities. An HTTP `400`, `404`, or `409` is an expected denial for the corresponding invalid/unauthorized/stale case, not a successful mutation.

## Acceptance status and deferred work

Hermetic tests verify service behavior, routes, validators, tenant filters, confidentiality and mutation compare-and-set logic, and audit labels/metadata. They do not start the backend, connect to a live MongoDB, or prove local credentials, permissions, deployment indexes, or real HTTP behavior. **Run the localhost/Postman checklist before release; acceptance remains pending until an authorized operator reports the results.**

Phase 38.4 remains explicitly out of scope. No replies/notes, attachments, SLA, notifications/realtime/NATS, auto-assignment, AI, analytics suite, frontend, or HR actions are implemented here.
