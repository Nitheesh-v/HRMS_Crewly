# Phase 38 — Running the REAL full stack (Frontend + Backend + MongoDB)

## Why the Arena sandbox cannot host the database

The Arena sandbox enforces a network allow-list (github.com, codeload.github.com,
api.github.com, registry.npmjs.org, pypi.org, files.pythonhosted.org). Verified
consequences on 2026-10-12:

1. **No Mongo binary exists in the sandbox** (`which mongod` → nothing; no Docker,
   no Redis either).
2. **MongoDB binaries cannot be downloaded**: MongoDB distributes `mongod` only
   from its own CDN (`fastdl.mongodb.org` / `downloads.mongodb.com`) — both
   blocked; `mongodb-memory-server` auto-downloads from the same CDN, so it
   fails here too. No allowed host (npm/PyPI/GitHub) ships a usable modern
   `mongod` binary (searched npm registry + GitHub code/repos: only ARM builds,
   2.6/3.4-era binaries with OpenSSL-1.0 deps, or downloaders).
3. **Outbound connections to a remote cluster are blocked as well** (Atlas /
   any external host:port), so pointing a sandbox backend at an outside DB
   cannot work either.

Therefore the sandbox can run the frontend (and backend code up to its DB
handshake), but a *real* database run must happen on a machine without that
network policy — typically **your laptop** or your hosting.

## One-command local run (real backend, real Mongo, real data)

Prereqs: Docker (recommended) **or** local `mongod` + `mongosh`; Node 20+.
Alternatively `export MONGO_URI=<Atlas string>` first and skip both.

```bash
git pull            # branch arena/3644f896-hrms-crewly
./dev-up.sh
```

What `dev-up.sh` does:

1. Starts MongoDB **as a single-node replica set** (`docker-compose.yml`,
   or a local `mongod --replSet rs0`). Replica set is required because the
   register-company flow uses Mongo transactions, which standalone refuses.
2. Writes `Backend/.env` (dev values: `MONGO_URI`, dev `JWT_SECRET`,
   `REDIS_ENABLED=false` — Redis is optional for the API by design).
3. `npm ci` in `Backend/` and `Frontend/` when needed.
4. Runs the idempotent seeds: `npm run seed` (super-admin) and
   `npm run seed:demo` (`Backend/src/seedDemoTenant.js`) which creates ONE
   trial tenant with **real documents** — company `crewlydemo`, an HR manager,
   two employees and six support tickets across departments/statuses.
5. Starts the real backend (`:5000`, nodemon) and the real frontend
   (`:5173`, Vite — which proxies `/api` + `/socket.io` to `:5000`).

### Logins (demo tenant)

| Field | HR / agent | Employee |
|---|---|---|
| Company code | `crewlydemo` | `crewlydemo` |
| Email | `hr@crewly.dev` | `priya@crewly.dev` (or `irfan@crewly.dev`) |
| Password | `Demo@123` | `Demo@123` |

Helpdesk UI: sidebar → Administration → **Support**, or `/app/support`.
HR sees the *My tickets / All tickets* scope toggle (department queues);
employees see their own tickets and the raise-ticket flow.

## Using Atlas or another hosted Mongo instead of Docker

```bash
export MONGO_URI="mongodb+srv://<user>:<pass>@<cluster>/crewly_dev"
./dev-up.sh
```

Everything else is identical; the seed scripts and both apps read `MONGO_URI`
from `Backend/.env` / environment. Keep real secrets out of Git — `.env` is
ignored.

## What is NOT mocked anywhere in this flow

- Frontend talks to the **real** Express backend through the Vite proxy.
- Backend talks to a **real** MongoDB (replica set) via Mongoose.
- Tickets, replies, status changes, notifications are **real documents**
  created by the seeded users through the product's own endpoints.

The only synthetic content is the demo tenant itself (a normal trial company
created by a seed instead of the registration form), which exists purely so a
fresh checkout has something to click on. Delete it by dropping the
`crewly_dev` database.
