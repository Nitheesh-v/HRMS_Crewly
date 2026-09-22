# Phase 32.17 — Localhost Acceptance Guide (Windows PowerShell)

> **SECURITY TESTING SAFETY:** Run every step against **localhost/development only**. Do not target Production, real customers, SMTP/BGV providers, or live billing. Nothing here needs real secrets — never paste any token/password into chat.

**Needs:** Mongo (your dev `.env`) + Backend + Frontend dev server. Redis/worker/realtime **not required** (limiters run their documented local mode). One API instance is enough. Helpful but optional: an employee user + an HR/admin user in your dev data. Paste one block at a time. First: `git pull` so you have this phase's commit.

---

## Step 1 — Normal system starts (baseline first)

Window A:

```powershell
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
npm run dev
```

**Expect:** the startup you know (Mongo connects; Redis disabled → DEGRADED-infra note). If it doesn't start normally, stop — that's a defect before anything else.

## Step 2 — Health endpoints leak nothing (S-07)

```powershell
(Invoke-WebRequest http://localhost:5000/api/health/live).Content
(Invoke-WebRequest http://localhost:5000/api/health/ready).Content
(Invoke-WebRequest http://localhost:5000/api/health).Content
```

**Expect:** tiny JSON — `{success,status,timestamp}` (live); readiness with `dependencies: {database, cache}` **labels**; legacy always HTTP 200. **No** Mongo/Redis URIs, no hostnames, no env values, no stack traces — even when Redis is down.

## Step 3 — Invalid auth is generic (S-03)

```powershell
try { Invoke-WebRequest http://localhost:5000/api/users -Headers @{Authorization=""} } catch { $_.Exception.Response.StatusCode.value__ }
try { Invoke-WebRequest http://localhost:5000/api/users -Headers @{Authorization="Bearer synthetic-test-token-DO-NOT-USE"} } catch { $_.Exception.Response.StatusCode.value__ }
```

**Expect:** both refuse (401/403-class) with the same generic shape — no hint whether the token was malformed vs expired.

## Step 4 — CORS stays restricted (S-02)

```powershell
$ok = Invoke-WebRequest http://localhost:5000/api/health/live -Headers @{Origin="http://localhost:5173"}
$ok.Headers["Access-Control-Allow-Origin"]
try { $bad = Invoke-WebRequest http://localhost:5000/api/health/live -Headers @{Origin="http://evil.example"} } catch { $bad = $_.Exception.Response }
Write-Host "unapproved origin status:" $bad.StatusCode
```

**Expect:** your configured dev origin gets an `Access-Control-Allow-Origin`; the unapproved origin is refused (403-class). CORS is browser defense-in-depth — real security still comes from auth (an unapproved origin failing here is CORS working, not an auth event).

## Step 5 — Proxy spoof: forged headers do nothing (S-01/S-06/S-15)

The authoritative proof is the automated suite (Step 9). A visible one-liner (safe, harmless route):

```powershell
node -e "import('express').then(async ({default: express}) => { const {applyProxyTrust} = await import('./src/config/proxyTrust.js'); const app = express(); applyProxyTrust(app, {TRUST_PROXY_MODE:'direct'}); app.get('/x',(req,res)=>res.json({ip:req.ip, secure:req.secure})); const s=app.listen(0,'127.0.0.1',async()=>{ const r=await fetch('http://127.0.0.1:'+s.address().port+'/x',{headers:{'x-forwarded-for':'10.9.9.9','x-forwarded-proto':'https'}}); console.log(await r.text()); s.close(); }); });"
```

**Expect:** `{"ip":"127.0.0.1","secure":false}` — forged `X-Forwarded-For`/`-Proto` are **inert** without a declared proxy topology. (With `TRUST_PROXY_MODE=loopback` the same headers ARE honored — that's the documented trusted-proxy model.)

## Step 6 — Oversized request is bounded (S-08)

```powershell
$big = "x" * 11000
try { Invoke-WebRequest http://localhost:5000/api/health/live -Method Post -ContentType "application/json" -Body ('{"pad":"' + $big + '"}') } catch { Write-Host "status:" $_.Exception.Response.StatusCode.value__ }
(Invoke-WebRequest http://localhost:5000/api/health/live).StatusCode
```

**Expect:** a safe 4xx (413/400-class) for the ~11kb body (limit is 10kb), and the backend is still healthy immediately after.

## Step 7 — RBAC refusals are server-side (S-05) — browser

Log in as a **low-privilege user**, open DevTools → Console, and hit an HR/admin-only endpoint they shouldn't have:

```js
fetch('/api/users', { headers: { Authorization: 'Bearer ' + JSON.parse(localStorage.getItem('token') ?? sessionStorage.getItem('token') ?? '"missing"') } }).then(r => r.status).then(console.log)
```

(Adjust the storage key to your dev build if different — or just attempt the action in the UI.) **Expect:** 401/403 — direct API authorization refuses even when the JWT is valid. Possession of a token is not permission.

## Step 8 — Private downloads are not public-cacheable (S-21/S-11) — browser

Log in as an authorized user, download/preview **one safe synthetic** private document (never real HR evidence). DevTools → Network → that response → Headers:

**Expect:** `cache-control: private, no-store` (or `private, no-store, max-age=0`) — never `public`, never `immutable`. Then confirm the distinction: the app's **hashed JS chunks** (`Network` → `index-*.js`) are the public-cacheable class — that's *code*, and it contains no backend secrets (Step 9's build scan proves it).

## Step 9 — Automated adversarial suite + full ladder (authoritative)

```powershell
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
$env:MONGO_URI="mongodb://127.0.0.1:27017/crewly_dev"
node --test test/phase32SecurityAdversarial.test.js
Remove-Item Env:MONGO_URI
npm run test:all
```

**Expect:** the adversarial suite 20/20 (cache deception, health disclosure, forged-XFF identity, redaction, queue trust, structural pins) and the full ladder all-pass — sandbox recorded **2167/2167 twice**. Record **your** actual totals.

## Step 10 — Frontend smoke + build secret check (S-25)

```powershell
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Frontend
npm run build
```

**Expect:** login, Attendance, a Payroll read, and `/kiosk` all work in the dev app with **no new Console errors** (no CSP/CORS breakage from security headers — none were changed). Build passes; the automated artifact scan (run this phase) found **zero** backend-secret patterns across 274 files — only the two public-by-design `VITE_*` names.

---

## Acceptance Checklist (leave UNCHECKED until YOU verify)

- [ ] Normal system starts (Step 1)
- [ ] Health responses leak no URIs/hosts/stacks (Step 2)
- [ ] Invalid auth refuses generically (Step 3)
- [ ] CORS: allowed origin OK, unapproved refused (Step 4)
- [ ] Forged forwarded headers are inert (Step 5)
- [ ] Oversized request → safe 4xx, backend healthy (Step 6)
- [ ] Valid-token/low-role user refused by API directly (Step 7)
- [ ] Private download carries private/no-store; hashed chunks are the only public-cache class (Step 8)
- [ ] Adversarial suite 20/20; full ladder green (Step 9)
- [ ] Frontend smoke clean; build + secret scan clean (Step 10)
- [ ] No Production target touched; no secret value printed anywhere

---

*Reply with your recorded results. Handoff line:*
**Phase 32.17 awaiting localhost acceptance.**
