# CREWLY — PROJECT STRUCTURE & PLACEMENT CONVENTIONS

Purpose: the authoritative map of where code lives and where NEW code
goes. This documents the existing (Phase 1–31 + 32.x) structure as-is.

> **Deliberate decision (Phase 32.3):** this is a DOCUMENTED structure —
> files were NOT physically moved. Relocating 124 models / 100+ controllers
> would rewrite imports across the entire codebase, violating the project's
> additive-evolution and no-broad-rewrite laws. New code simply follows the
> placement rules below.

## Backend (`Backend/src`)

| Folder | Role | Place NEW code here when… |
| --- | --- | --- |
| `config/` | App-wide configuration & singletons: `env.js`, `db.js`, `redis.js`, `queueConfig.js`, `lifecycle.js` (32.2), `proxyTrust.js` (32.3), `permissions/`… | it is infrastructure/startup/identity-level, loaded before requests |
| `controllers/` | Thin HTTP layer: read request → call service → respond (`attendanceKioskController.js`, `healthController.js`, …) | it parses/validates an HTTP request and returns a response; business logic goes to services |
| `middlewares/` | Express middlewares: auth chain (`authMiddleware`, `tenantMiddleware`, `permissionMiddleware`), `securityRateLimit`, scope gates (`payrollInputScope`, `statutoryScope`…), uploads | it runs inside the protect→tenant→subscription→permission→validator pipeline |
| `models/` | One Mongoose model per file (124): `User`, `Company`, `Attendance*` suite, payroll suite, BGV suite… | it is a persisted MongoDB collection with schema + indexes |
| `routes/` | One router per domain (`attendanceRoutes.js`, `rolePermissionRoutes.js`, `healthRoutes.js`…), mounted in `routes/index.js` (public → verifier → platform → auth → tenant modules) | it exposes endpoints; static paths precede `:params`; route files import cleanly standalone |
| `services/` | Business logic. Domain subfolders: `services/attendance/` (35 files: pure `*Rules.js` + injectable services), `services/payroll/`, `services/bgv/` | it holds rules/orchestration; pure `*Rules.js` + injectable `{models,cache,audit,notify}` pattern for hermetic testability |
| `utils/` | Cross-cutting helpers: `permissionService/Registry`, `securityPolicy`, `tokenService`, `gracefulShutdown.js` (32.2), `subscriptionLifecycle.js` | it is reusable infrastructure used by multiple domains (not a config, not a model) |
| `validators/` | One express-validator chain per surface (49 files) | it shapes/validates request bodies for a route |
| `workers/` | The ONE worker process: `index.js` (entry), `registry.js` (job dispatch), per-queue `*Processor.js`, `workerHeartbeat.js` | it executes queued/background jobs (never imported by the API) |
| `queues/` | `queueFactory.js` — BullMQ producer factory/shared lifecycle | it enqueues jobs (producer side only) |
| `scripts/` | Ops/preview CLIs (`redis-check`, `queue-reconcile`, `payslipPreview`…, 13 files) | it is a developer/operator command — NEVER seed/demo scripts |
| `test/` | Hermetic `node --test` suites wired into `package.json` scripts (`test:all`) | it proves behavior without Mongo/Redis via injected fakes |

Startup chain: `server.js` (loadEnv → connectDB → ensurePermissions →
initializeRedis → ensures → listen → markReady → graceful shutdown) ←
`app.js` (pure express app: security, CORS, drain gate, routes) ←
`routes/index.js`.

## Frontend (`Frontend/src`)

| Folder | Role |
| --- | --- |
| `routes/AppRoutes.jsx` | every route (153 paths), permission/role-gated wrappers |
| `layout/` | `AppLayout.jsx`, `SidebarNav.jsx` (permission-gated menus) |
| `pages/` | one folder per domain: `attendance/`, `payroll/`, `kiosk/`, `settings/`, … |
| `components/` | shared/domain components (`components/attendance/`…) |
| `services/` | one axios module per domain (`permissionService.js`, `attendanceCaptureService.js`…) |
| `hooks/` | `usePermission` etc. |
| `redux/` | slices + store (`AuthSlices`, `PermissionSlices`…) |
| `style.css` | dark Crewly tokens (`.card/.input/.btn-primary/.badge`) |

Rules: no emojis in new UI, Lucide icons, dark tokens, permission-gated
menus, no backend secrets in any `VITE_*` variable.

## Phase 32 additions (so far)

| File | Phase |
| --- | --- |
| `src/config/lifecycle.js` | 32.2 |
| `src/controllers/healthController.js`, `src/routes/healthRoutes.js` | 32.2 |
| `src/utils/gracefulShutdown.js` | 32.2 |
| `src/config/proxyTrust.js` | 32.3 |
| `test/multiInstanceBaseline.test.js` | 32.1 |
| `test/healthLifecycle.test.js` | 32.2 |
| `test/proxyReadiness.test.js` | 32.3 |
| `docs/PHASE_32_PRODUCTION_INFRASTRUCTURE.md` | 32.1–32.18 |
| `docs/RBAC_BOOTSTRAP.md`, `docs/PROJECT_STRUCTURE.md` | supporting |
