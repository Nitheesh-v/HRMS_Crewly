# Phase 38.11 — Helpdesk Production Closeout

**Status:** Code and hermetic closeout work is complete. **The owner accepted the Phase 38.11 implementation and automated test results on 2026-10-23; this acceptance does not include production. Production deployment and production acceptance are still pending.**

**Owner acceptance:** “I accept the Phase 38.11 implementation and automated test results. Production acceptance remains pending.”

**Production acceptance decision submitted on 2026-10-23: REJECT.** The submitted decision states that production deployment/release identity, live API readiness and index/query-plan verification, worker health, production authenticated smoke tests, and owner-run localhost acceptance are unconfirmed or pending. The listed risks (dev-only audit findings, unconfigured malware scanning, large-tenant search performance, live index/query plans, and worker recovery) have no authorized production-owner risk acceptance. The submitter did not identify an authorized production approver; therefore this is recorded as a submitted rejection, not a completed production-owner sign-off. Production acceptance remains pending.

The owner explicitly accepted the previously requested local Helpdesk workflows as working and reported that their staging authorization-fence harness passed all seven checks. The owner-run command was `node .\scripts\helpdesk-staging-integration.js --allow-staging-writes --confirm-database=crewly_staging`. Its result is owner-reported evidence; this agent did not connect to staging or production and did not rerun the write-capable harness. No production-readiness claim is made.

## Phase 38.11 changes

- Requester ticket-detail responses now include server-derived `canReopen`, `reopenEligibilityKnown`, and `reopenUntilAt`. The mutation service still rechecks tenant policy, resolved time, and the deadline at write time. If the policy read fails, the ticket remains readable but reopening is hidden and marked unknown. The detail UI enables reopening only when the server positively allows it and displays the deadline/unknown state.
- The shared authenticated SSE event vocabulary admits `helpdesk:notifications:changed`; the backend protocol requires an empty `{}` payload, and the client independently rejects a non-empty payload. The event is user/tenant targeted and contains no ticket/message content or ticket ID. Notification records remain authoritative; the bell refreshes them over the existing REST service. Existing Socket.IO notification nudges are retained for their current consumers. No Helpdesk-specific socket or polling loop was added; the bell's existing 60-second unread REST refresh remains the fallback.
- `AppLayout` owns the shared realtime session, keyed by authenticated user and tenant lifecycle. The client requests a fresh opaque stream ticket through the shared API client, tolerates API-envelope unwrapping, rejects stale ticket responses after account/session changes, and reconnects with bounded backoff. It sends no client-supplied tenant authority.
- Helpdesk query shapes are now part of the static index-coverage catalog. API Mongo startup explicitly builds the declared Helpdesk ticket, message, attachment, and SLA-policy indexes additively, then checks required names, ordered keys, uniqueness, and partial filters. It does not call `syncIndexes` or drop indexes.
- Existing package versions were security-updated where compatible. Backend Nodemailer moved to `^10.2.1` to clear the production SMTP credential-disclosure advisory; the vulnerable Multer/transitive production versions were also updated. Nodemailer 10 requires Node.js 20 or newer. The audited Frontend Vite 8.3.5 build requires Node `^20.19.0 || >=22.12.0`; verify CI/deployment build runtimes satisfy that range. No package was added.

## Scope review and operational boundaries

| Area | Closeout result | Remaining operator/acceptance boundary |
|---|---|---|
| Tenant/RBAC and authorization fence | Existing server-derived tenant context, permission checks, queue-membership fence, confidentiality checks, and transaction/CAS behavior were preserved. The owner's seven-check staging report covers the authorization-fence harness. | Deployment still needs the normal role/permission smoke check; no live DB was used by this agent. |
| Ticket lifecycle/reopen | Requester detail is now server-authoritative; the reopen mutation remains authoritative and deadline/policy checked. | Verify the enabled/expired/disabled cases using a disposable local tenant. |
| Attachments | Existing private-storage path, tenant/ticket authorization, signature/MIME checks, 10 MiB cap, immutable-message association, and bounded compensation/reconciliation remain in place. Production does not serve the development local directory. | There is no malware scanner in this repository: the model remains `NOT_CONFIGURED`. Files must not be represented as virus-scanned/clean. Obtain an explicit security risk decision or provide approved external scanning before enabling attachments where policy requires it. |
| SLA and auto-close | Mongo remains authoritative; the existing separate worker performs bounded startup/periodic due sweeps and CAS/idempotent state transitions. | Deploy/restart the existing worker as well as the API; an API-only rollout does not persist worker reconciliation. |
| Notifications/realtime | Durable notification records and retry/reconciliation stay authoritative. SSE is an empty-payload invalidation nudge only; REST is used to refresh. | Realtime depends on the existing realtime/Redis configuration. If disabled or unavailable, the bell's existing REST refresh remains; delivery is best-effort, not exactly-once. |
| Knowledge Base | Existing publication, tenant, visibility, queue, and confidentiality restrictions and query bounds remain unchanged. | Exercise published/draft/queue visibility using disposable local records. |
| Analytics | Existing route authorization, date bounds, aggregate limits, and audit behavior remain unchanged. Supported filters are `from`, `to`, `page`, and `limit`; metrics reflect persisted lifecycle/message/SLA/feedback data, not unrecorded views or clicks. | Confirm manager/queue scopes and expected data coverage in a local tenant; no live report query was run. |
| Failure recovery | Existing durable message/ticket notification recovery, attachment reconciliation, SLA reconciliation, and auto-close sweeps remain in their existing API/worker processes. Retries/CAS provide recoverability, not exactly-once delivery. | Keep the worker healthy and inspect sanitized recovery counts/warnings. |
| Observability | Notification and SLA/auto-close workers log bounded aggregate counts and sanitized failures; attachment recovery logs scoped Mongo IDs, not file bytes, filenames, storage keys, or provider URLs. Existing readiness/process diagnostics remain the health surface. | There is no new dedicated Helpdesk metrics dashboard or alert policy in this change; use the existing log/health platform and set alert thresholds operationally. |

## Index/query review

The static coverage audit now catalogs 28 hot query shapes, including requester and queue ticket lists, SLA due work, automatic closure, ticket notification event/gap recovery, public-message notification recovery, and first qualifying public staff replies. It prefers an index that satisfies both the equality prefix and the declared sort, and Helpdesk entries pin their discriminator/partial-filter contract. `npm run index:check` is hermetic and inspects Mongoose declarations only; it does not connect to MongoDB or prove a production query plan.

Startup now runs `createIndexes()` sequentially for `HelpdeskTicket`, `HelpdeskMessage`, `HelpdeskAttachment`, and `HelpdeskSlaPolicy`, reads back the persisted definitions, and fails API startup if required operational indexes do not match. Existing startup checks remain for the unique authorization-fence index, lifecycle/analytics indexes, and Knowledge Base/queue membership indexes. Index creation is additive: no data backfill, destructive migration, `syncIndexes`, or index drop is performed.

The query/index mapping is:

- Requester lists: tenant/requester plus stable `createdAt`/`_id` or `updatedAt`/`_id` indexes, partial to `ticketKind: HELPDESK`.
- Queue/assignment lists: tenant/queue and optional assignee plus stable date/`_id` indexes, also discriminator-partial.
- SLA and auto-close sweeps: due timestamp, tenant, and `_id` indexes with date/status partial filters.
- Notification recovery: separate ticket event/gap indexes and a public-message retry index aligned with pending-state and attempt-time filters.
- First public staff response: tenant/ticket chronological message index, partial to public messages.
- Attachment and SLA policy uniqueness/recovery: message-unique and cleanup/commit recovery indexes; tenant/queue-unique SLA policy index.
- Queue membership and Knowledge Base authorization/search/order indexes are created and verified by the existing startup path.

**Known query limitation:** Helpdesk ticket search is a bounded, case-insensitive substring regular expression over ticket number/subject. It is not B-tree-prefix searchable. Tenant/requester or tenant/queue predicates and page/result limits reduce returned data but do not cap documents examined for a large tenant. Search semantics were not changed and no speculative text index was added. Use staging/local explain and representative volume tests before relying on this search at large scale.

An operator must still review persisted index health and representative `explain('executionStats')` plans on the target environment. Do not infer live index presence or selectivity solely from this static audit or startup success, and do not run `syncIndexes`/drop indexes as a shortcut.

## Dependency audit

Final `npm audit --omit=dev` results are clean for both Backend and Frontend. The Frontend full audit is also clean. Backend full audit still reports **3 high-severity dev-only findings** in `braces` → `chokidar` → `nodemon`; npm's offered `--force` remedy would downgrade Nodemon to `1.14.10` (a breaking change), so it was not applied. These packages are excluded from production installs; the dev-tooling finding still requires normal dependency triage before development environments are considered fully clean. No audit fix was run with `--force`.

## Deployment and rollback

1. Deploy the Backend API code first. Mongo initialization now explicitly builds/verifies required Helpdesk indexes; allow for index-build time and monitor startup/readiness. A unique-index conflict, missing index, or insufficient index privilege fails startup closed. Investigate data/index state; do not use `syncIndexes` or drop indexes to force the deployment.
2. Deploy/restart the existing Backend worker with the same release. Keep the worker connected to the intended MongoDB/Redis services so attachment, SLA, auto-close, and other durable recovery loops run.
3. Deploy the Frontend bundle after the API. The DTO changes are additive. The new UI fails closed against an older API that does not provide positive reopen eligibility (it will not expose a reopen action). Existing clients ignore the new nudge if they do not know its event name.
4. Realtime notification nudges require the already-existing realtime/Redis deployment configuration. No new environment variable, collection, data backfill, package, or credential is introduced by the SSE feature. If realtime is unavailable, durable notification REST reads and the pre-existing unread refresh remain.
5. Rollback is application-code rollback only. Keep additive indexes and durable notification/ticket/attachment records; do not drop indexes or delete records as part of rollback. If the new frontend is rolled back, the existing notification path remains. If the server is rolled back, the new client ignores unavailable realtime and will fail closed on missing reopen eligibility; restore a compatible frontend/API pair.

## Verification performed

All tests/builds below ran locally and hermetically; the Mongo URI passed to `test:all` is a process-local placeholder and no Mongo/Redis/staging/production connection was made.

| Command | Result |
|---|---:|
| `MONGO_URI='mongodb://127.0.0.1:27017/crewly_full_test' REDIS_ENABLED=false NODE_ENV=test npm run test:all` (Backend) | **3,531 passed, 0 failed, 0 skipped** across 178 suites |
| `npm run test:helpdesk` (Backend) | **151 passed, 0 failed** |
| `npm run test:index-coverage` (Backend) | **19 passed, 0 failed** |
| `npm run index:check` (Backend) | 146/146 models loaded; 694 declared indexes; all 28 catalog entries covered/documented |
| `node --test test/realtimeFoundation.test.js test/helpdeskNotificationRecovery.test.js` (Backend) | **35 passed, 0 failed** |
| `node --check` on changed Backend source/test modules | Passed |
| `npm test` (Frontend) | **468 passed, 0 failed** across 53 suites |
| `npm run build` (Frontend) | Passed; Vite production build completed |
| Targeted `npx eslint` on changed Frontend source/tests | Passed |
| `npm ci --no-audit --no-fund` (Backend and Frontend) | Both exited 0 |
| `npm audit --omit=dev` (Backend and Frontend) | Both: **0 vulnerabilities** |
| Full `npm audit` | Frontend: **0**; Backend: **3 high dev-only** findings (`braces`, `chokidar`, `nodemon`) |

The first unconfigured `npm run test:all` attempt failed environment validation in 16 test files because `MONGO_URI` was absent. It was rerun with the documented process-local test URI and passed as recorded above. No `.env` file was edited. The historical Frontend repo-wide lint baseline was 166 issues; this turn ran targeted lint on the changed files, not a repo-wide lint.

## Windows PowerShell localhost acceptance

Use only a dedicated local MongoDB replica set/database and disposable tenant/accounts. Do not point these commands at staging or production, and do not edit `.env` for this run.

1. Ensure the local MongoDB is transaction-capable. If using a dedicated single-node replica set, start that local instance with `--replSet rs0`. On a fresh, dedicated local instance only, initialize it once with `mongosh 'mongodb://127.0.0.1:27017/admin' --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:27017'}]})"`. Do not run `rs.initiate` against a shared service. Confirm the local replica-set status before proceeding.
2. In Backend Terminal 1, use process-scoped local settings and start the API:

   ```powershell
   Set-Location .\Backend
   $env:NODE_ENV = 'development'
   $env:PORT = '5000'
   $env:MONGO_URI = 'mongodb://127.0.0.1:27017/crewly_phase38_11_local?replicaSet=rs0'
   $env:JWT_SECRET = 'LOCAL-' + [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
   $env:REDIS_ENABLED = 'false'
   $env:REALTIME_ENABLED = 'false'
   npm run dev
   ```

   Confirm API readiness from another PowerShell window:

   ```powershell
   Invoke-RestMethod -Uri 'http://localhost:5000/api/health/ready'
   ```

   API startup should complete its required Helpdesk index creation/readback before reporting Mongo connected. Do not continue if startup reports an index mismatch or duplicate-key failure.
3. In Frontend Terminal 2:

   ```powershell
   Set-Location .\Frontend
   npm run dev -- --host 127.0.0.1
   ```

   Open `http://127.0.0.1:5173`; the existing Vite proxy uses the local API. Create a disposable tenant, an employee/requester, an enabled queue/category, a queue manager, and an explicitly assigned queue agent using the normal UI. Use separate browser profiles for the requester and staff accounts.
4. Exercise the acceptance matrix using the existing routes/UI and the detailed local instructions in `docs/PHASE_38_4_HELPDESK_CONVERSATIONS_ATTACHMENTS.md` and `docs/PHASE_38_5_HELPDESK_SLA.md`:
   - Requester ownership, queue membership, role denial, foreign-tenant non-enumeration, and confidentiality boundaries for list/detail/history/download.
   - Resolve a ticket, verify the detail DTO's `canReopen`/known/deadline state, reopen before expiry, then verify expired/disabled-policy cases stay hidden and the server still rejects a stale/unauthorized reopen.
   - Verify public replies versus internal notes, cursor-paged history, valid signature/MIME and size-limited private attachment download, and denial for foreign/inactive attachment IDs. Use harmless test files only. Confirm the app never serves private storage as static content.
   - Configure a short disposable SLA policy; start the local worker below; confirm qualifying public staff reply, warning/breach, pause/resume, resolution, escalation visibility, and auto-close with employee/staff role differences.
   - Verify Knowledge Base draft/published and employee/queue visibility, plus manager-only analytics with supported `from`, `to`, `page`, `limit` filters and expected historical-data limitations.
5. For realtime notification acceptance, use a local Redis service only. Restart API with `REDIS_ENABLED=true`, `REDIS_URL='redis://127.0.0.1:6379'`, and `REALTIME_ENABLED=true`, then start the local worker in Terminal 3 with the same local Mongo URI and Redis settings:

   ```powershell
   Set-Location .\Backend
   $env:NODE_ENV = 'development'
   $env:MONGO_URI = 'mongodb://127.0.0.1:27017/crewly_phase38_11_local?replicaSet=rs0'
   $env:REDIS_ENABLED = 'true'
   $env:REDIS_URL = 'redis://127.0.0.1:6379'
   npm run worker
   ```

   Trigger a disposable Helpdesk notification and verify the bell refreshes authoritative REST data after the data-less nudge. Confirm no ticket content/ID is carried by the event. Stop the worker/API once, restart them, and verify durable recovery from the persisted state. If local Redis is unavailable, do not point the worker at another environment; accept only the REST path and record realtime/worker acceptance as pending.
6. Close the PowerShell windows when finished so process-scoped variables disappear. Drop the database only if it is the dedicated `crewly_phase38_11_local` database created solely for this acceptance run.

The earlier owner-run staging harness is already reported as passing; **do not rerun its write-capable command** for this closeout.

## Safe staging verification and production gate

- Any staging verification must be run only by an authorized operator in the approved staging environment. Load the connection secret from the approved secret manager directly into the protected operator process; never paste it into chat, a ticket, console transcript, or Git. Confirm `db.getName()` is exactly `crewly_staging`, the authenticated role is limited to `readWrite` on that database, and the topology supports transactions. Never reuse production credentials/data.
- The already-passed harness is explicitly write-capable and cleans up only IDs it creates. It is not a general smoke-test command and does not need to be repeated for this frontend/realtime/index closeout. Re-run it only if an approved, relevant authorization-fence change requires a new owner-authorized test; use the exact staging confirmation flags and inspect cleanup status.
- After an approved staging deployment, use a read-only observer to check `getIndexes()` metadata for `supporttickets`, `helpdeskmessages`, `helpdeskattachments`, `helpdeskslapolicies`, and lifecycle/Knowledge Base collections. For representative requester/queue/due/recovery filters, inspect `explain('executionStats')` only; retain index name and examined/returned counts, not ticket/message documents or query payloads. Avoid broad unbounded scans. Confirm startup reports successful required-index verification and the worker/API readiness signals are healthy.
- Production requires its own approved deployment/change window, production-specific backups/restore readiness, least-privilege index provisioning, rollout/rollback owner, observed API and worker health, and explicit post-deploy owner acceptance. Staging success and local test success are not substitutes.

**Production blockers/acceptance items:** production deployment and live acceptance have not occurred; live database index plans/latency have not been inspected; malware scanning remains unconfigured; the Backend dev-only Nodemon dependency advisories require triage; large-tenant substring-search performance needs representative explain/load evidence. Record accepted risk or remediation for each relevant item before enabling production Helpdesk workflows.

`Phase 38.11 awaiting production acceptance.`
