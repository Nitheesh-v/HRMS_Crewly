# Phase 38.9 — Helpdesk Analytics (Backend)

**Status:** backend implementation and hermetic tests complete; localhost acceptance pending.

Phase 38.9 adds bounded, tenant-scoped Helpdesk reports. It reuses the existing ticket discriminator, RBAC, current queue membership, confidentiality rules, SLA snapshots, lifecycle events, feedback fields, and public-reply Knowledge Base references. It adds no frontend, export format, new role grant, worker, or data backfill.

## API surface

All routes inherit the existing Helpdesk authentication, customer-tenant context, subscription check, and tenant requirement. Date filters accept `YYYY-MM-DD` (interpreted at UTC midnight) or a timezone-bearing ISO timestamp. `from` is inclusive and `to` is exclusive. Both must be supplied together; the default is the previous 30 days. The maximum period is 366 days. `page` defaults to 1 and `limit` defaults to 50 (maximum 100); they apply to overview queue rows, queue-agent rows, and Knowledge Base article rows. The single-queue summary has no paginated list.

| Method | Route | Access |
| --- | --- | --- |
| `GET` | `/api/helpdesk/admin/analytics/overview` | `HELPDESK_TICKET_READ`; report includes only queues/tickets currently readable by the actor. |
| `GET` | `/api/helpdesk/admin/analytics/queues/:queueId` | `HELPDESK_TICKET_READ`; actor must currently have readable access to that queue. |
| `GET` | `/api/helpdesk/admin/analytics/queues/:queueId/agents` | `HELPDESK_TICKET_READ` and `HELPDESK_QUEUE_MANAGE`; actor must be an explicit manager of the selected queue. |
| `GET` | `/api/helpdesk/admin/analytics/knowledge-base/usage` | `HELPDESK_KB_MANAGE` and `HELPDESK_TICKET_READ`; only references on tickets the actor can read are aggregated. |

Example local PowerShell call (keep real tokens private):

```powershell
$Base = 'http://localhost:5000/api/helpdesk/admin/analytics'
$Headers = @{ Authorization = "Bearer $ManagerToken" }
$Period = 'from=2026-01-01&to=2026-02-01&limit=50'
Invoke-RestMethod -Method Get -Uri "$Base/overview?$Period" -Headers $Headers
Invoke-RestMethod -Method Get -Uri "$Base/queues/$QueueId/agents?$Period" -Headers $Headers
Invoke-RestMethod -Method Get -Uri "$Base/knowledge-base/usage?$Period" -Headers $Headers
```

## Authorization and confidentiality

- Tenant and actor IDs come only from `req.companyId` and `req.user._id`.
- Every ticket aggregate includes both `companyId` and `ticketKind: 'HELPDESK'`; the underlying collection is shared with legacy Support tickets.
- Queue scope is re-read from current tenant queue membership. Public-ticket aggregates require current agent/manager access. Confidential-ticket aggregates require the existing confidential-agent or reviewer authorization for that same queue. An unauthorized queue ID returns a non-enumerating not-found response.
- Agent breakdowns are manager-only at both RBAC and explicit queue membership layers. Results contain current active queue-agent IDs and aggregates, not user profile documents or ticket content.
- Feedback comments, ticket descriptions, message bodies, ticket numbers, attachment data, and internal notes are never returned.
- Report reads create a safe audit event containing report kind, period, and optional queue ID only.

## Metric definitions and limitations

- Ticket totals/status/priority and queue rows use tickets **created** in the requested period; statuses, assignees, and SLA clocks are current persisted snapshots.
- First-response SLA summaries use persisted clock state for the created-ticket cohort. Resolution SLA compliance uses persisted `RESOLVED` lifecycle-event snapshots. Only tracked/observed clocks enter compliance rates; missing SLA snapshots are not guessed.
- Resolution/reopen/confirmation/closure counts use immutable lifecycle events whose `occurredAt` is in the period. Average first-resolution duration uses tickets' persisted `createdAt` and their first `RESOLVED` event. Legacy history that was never recorded is not inferred or backfilled.
- Feedback counts/average/distribution use persisted feedback whose `submittedAt` is in the period. Comments are excluded.
- Knowledge Base usage counts article references persisted on public Helpdesk messages. It is **not** a view, click, or search metric; those events are not stored. Each reference count is derived from a public reply and an article ID, and is filtered through current ticket visibility.
- Agent workload counts use current assignee state for tickets created in the period; public reply counts use persisted public-message authorship in the period. Assignment/reassignment history is not stored, so past ownership is not attributed. This is operational reporting only, not an automated HR performance decision.
- No CSV/XLSX export is provided because the repository has no Helpdesk export infrastructure. JSON results and list sizes are bounded.

## Existing administration operations

The administration review covered tenant configuration; queue list/create/update; SLA policy read/update; and Knowledge Base category/article list, draft, revision, publish, restore, and archive operations. These routes retain write-access checks, operation-specific RBAC, strict input allowlists, tenant-derived identities, and the existing audit trail. Queue updates validate active tenant members and run through the authorization-fence transaction path; SLA policy updates use version compare-and-set; Knowledge Base writes use version checks and transactions where publication/category serialization requires them. Queue disabling and KB archival are non-destructive. No missing destructive operation was added: Phase 38.9 adds the missing report/read operations only.

## Database and deployment

Three indexes are added and explicitly created/verified during backend Mongo initialization:

- `helpdesk_ticket_feedback_analytics` — tenant/queue feedback period queries.
- `helpdesk_lifecycle_analytics` — tenant/event/time lifecycle metrics.
- `helpdesk_public_message_analytics` — tenant/time public-message reference scans.

There is no new collection, schema data migration, or backfill. Index construction is additive but may take time on large existing collections; rollout should verify successful API startup and index presence. Deploy the new API code to every API instance. No worker restart or new environment setting is required. Aggregates have a 366-day maximum range and an 8-second Mongo `maxTimeMS` bound. No staging or production access is part of this phase.

## Verification

Hermetic coverage is in `Backend/test/helpdeskAnalytics.test.js`; the file is included in `npm run test:helpdesk`. It verifies bounded filters, RBAC/queue visibility, confidentiality-safe aggregation filters, manager-only agent breakdown, supported metric sources/limitations, route permissions, audited report reads, and declared/startup-verified indexes. Final verification: the focused file passed **6/6**; `npm run test:helpdesk` passed **149/149**; `node --check` on all changed JavaScript files and `git diff --check` passed. `Backend/package.json` defines no build or lint script. Hermetic tests do not replace the owner's localhost acceptance.
