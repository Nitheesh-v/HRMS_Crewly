# Phase 32.15 — Localhost Acceptance Guide (Windows PowerShell)

Everything below runs on **your machine** with your existing dev setup. Nothing touches your `.env` file, nothing connects to any production service, nothing needs a vendor. Copy-paste blocks are PowerShell.

> Beginner notes: paste one block at a time. `$env:NAME="value"` sets a variable **only for that PowerShell window** (never written to any file). `Remove-Item Env:NAME` deletes it from the window. Close the window and everything is forgotten.

---

## Step 1 — Config pre-flight demo (`config:check`, names only)

```powershell
cd C:\path\to\HRMS_Crewly\Backend
npm run config:check
```

**Expect:** a table of variable **names** with `configured` / `missing` / `invalid` statuses, then either `✓ Configuration valid` (exit 0) or `✗ CONFIG PROBLEMS`. **No secret values are ever printed.** Your dev `.env` should pass.

Optional — the production law:

```powershell
node scripts/config-check.js --production
```

If your dev `JWT_SECRET` is the default or short, this **must fail with exit 1** while plain `config:check` passed — that is the phase's core fix demonstrated (production refuses insecure boot; dev is unaffected).

## Step 2 — Safe missing-config demo (no file edits)

```powershell
$env:MONGO_URI=""
npm run config:check
Remove-Item Env:MONGO_URI
```

**Expect:** exit 1, `MONGO_URI: missing` + `MONGO_URI is empty` message. Your `.env` file was never opened. Also verify the exit code:

```powershell
npm run config:check; echo "exit=$LASTEXITCODE"
```

## Step 3 — Start the dev API

```powershell
npm run dev
```

**Expect:** normal startup exactly as before this phase (Mongo connects; without Redis it logs the usual DEGRADED-infra note). Leave it running; Ctrl+C to stop gracefully.

## Step 4 — Prod-style start (local only — NOT real production)

```powershell
node src/server.js
```

Same app, same env, but the deterministic non-watch command a deployment would use. **This is a local rehearsal, not production**: real production additionally means real secrets via a secrets manager, TLS at a proxy, a production database. If you have no `JWT_SECRET` in your `.env`, this still starts — the strict production JWT law applies only when `NODE_ENV=production` (validated in the automated tests instead; never point a local run at production secrets).

## Step 5 — Worker lifecycle

New window:

```powershell
cd C:\path\to\HRMS_Crewly\Backend
npm run worker
```

**Expect:** without Redis configured, it **exits 1** with a name-only message (`REDIS_URL is empty…`) — the fail-fast demo. With your dev Redis enabled (`REDIS_ENABLED=true`, `REDIS_URL=redis://127.0.0.1:6379`), it starts, reports queues resumed; **Ctrl+C stops gracefully** (jobs finish or return for retry — no crash, no lost work).

## Step 6 — Two-API no-sticky re-verify (5000 + 5001)

Window A: `npm run dev` · Window B:

```powershell
$env:PORT="5001"; npm run dev
```

Then from a third window (or browser):

```powershell
curl.exe -s http://127.0.0.1:5000/api/health/live
curl.exe -s http://127.0.0.1:5001/api/health/live
```

**Expect:** both return 200 live. Log in via the UI on port 5000, then call an authenticated GET through 5001 — it **succeeds without re-login**: any instance can serve any request (stateless, no sticky sessions).

## Step 7 — Frontend production build

```powershell
cd C:\path\to\HRMS_Crewly\Frontend
npm run build
```

**Expect:** a clean production bundle in `dist/` (record the actual result). Optional taste, not production hosting: `npm run preview`. The real artifact would be uploaded to static hosting with `VITE_API_URL` pointing at the deployed API — frontend `VITE_*` values are **public by design** (test-pinned: only `VITE_API_URL` and `VITE_MAX_RESUME_SIZE_MB` exist).

## Step 8 — Env-prefix check (namespace safety, without exposing URLs/keys)

```powershell
node -e "const q=require('./src/config/queueConfig.js'); console.log('queue namespace root:', String(q.getQueuePrefix()).split(':')[0] + ':<env>:')"
```

**Expect:** `crewly:<env>:` pattern — each environment gets its own queue namespace, so a staging worker can never consume production jobs. (No Redis URLs or keys are printed.)

## Step 9 — 10-step rollout rehearsal (all local)

Walk the deployment ordering **documented** in `docs/PHASE_32_15_DEPLOYMENT_ARCHITECTURE.md` §6/§10 using only local processes — narrate, don't script:

1. `npm run config:check` → exit 0
2. Full ladder green on the build being "shipped"
3. Identify rollback target (previous git commit id — **write it down, do not reset**)
4. "Deploy" worker first (Step 5 command)
5. Start API #1 (port 5000), watch `/api/health/live` + `/ready`
6. Start API #2 (port 5001) — rolling, one instance at a time
7. Smoke: login + tenant-scoped read through **both** ports
8. "Deploy" frontend artifact (Step 7 build)
9. Post-deploy checks: health, error rate, queue resumed
10. Tear down (Ctrl+C ×3) — **rollback is documented, not simulated**: in a real incident you redeploy the previous artifact; we never `git reset` anything to rehearse

## Step 10 — Full test ladder

```powershell
npm run test:all
```

Record the **actual** totals (expect the ladder including the new `deploymentConfig` suite; 29 config/deployment tests inside).

---

## Acceptance Checklist (leave UNCHECKED until YOU verify)

- [ ] Step 1: `config:check` prints names/statuses only, exits 0 on your dev env
- [ ] Step 1: `--production` fails (exit 1) when the dev-default/short secret is present
- [ ] Step 2: missing `MONGO_URI` demo exits 1; `.env` untouched
- [ ] Step 3: `npm run dev` unchanged behavior
- [ ] Step 4: deterministic start works locally, clearly distinguished from real production
- [ ] Step 5: worker fails fast without Redis; starts + Ctrl+C-graceful with it
- [ ] Step 6: two APIs, shared token, no re-login on the other port
- [ ] Step 7: frontend build succeeds (actual result recorded)
- [ ] Step 8: namespace root prints `crewly:<env>:` pattern, no URLs/keys
- [ ] Step 9: 10-step rehearsal walked; no reset/rebase used
- [ ] Step 10: full ladder totals recorded (actual numbers)
- [ ] No secret value appeared in any output at any step

---

*When done, reply with your recorded results. Handoff line:*
**Phase 32.15 awaiting localhost acceptance.**
