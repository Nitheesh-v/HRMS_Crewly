# MongoDB: `querySrv ECONNREFUSED` on startup

```
2026-10-26 12:49:48 [error]: ❌ MongoDB connection failed:
  querySrv ECONNREFUSED _mongodb._tcp.hrms.vxhoifi.mongodb.net
[nodemon] app crashed - waiting for file changes before starting...
```

This is almost never a database problem. `mongodb+srv://` asks DNS for an **SRV**
record before it opens a single socket, and `ECONNREFUSED` here means *the DNS
query itself was refused* — by Windows' resolver, a VPN, an antivirus DNS filter,
or an ISP resolver that drops SRV queries. The cluster can be perfectly healthy
at that moment, and usually is.

Two error codes that look alike mean opposite things:

| Code | What it means | Where to look |
| --- | --- | --- |
| `querySrv ECONNREFUSED` (also `ETIMEOUT`, `EAI_AGAIN`, `ESERVFAIL`) | the resolver refused or blocked the query | this machine's DNS, VPN, antivirus |
| `querySrv ENOTFOUND` | the record does not exist | the cluster is paused/deleted, or the hostname is wrong |

## Check it in one command

```bash
cd Backend
npm run db:check
```

It tests the three things that fail independently — DNS (SRV + TXT, or A), then a
TCP connection to each host — and prints the next step. It never prints the
connection string. On a healthy setup:

```
✓ MONGO_URI found — mongodb+srv → hrms.vxhoifi.mongodb.net
✓ SRV record resolved — 3 hosts
✓ TXT record (driver options) — authSource=admin&replicaSet=atlas-nhq9bq-shard-0
✓ TCP ac-…-shard-00-02.vxhoifi.mongodb.net:27017 — open
3/3 host(s) reachable.
```

The startup log now prints the same diagnosis after the driver's one-liner, so a
crashed boot says what to fix instead of only what broke.

## Fix 1 — give this process a resolver that answers (no admin rights)

Keep the URI exactly as it is and add one line to `Backend/.env`:

```
MONGO_DNS_SERVERS=8.8.8.8,1.1.1.1
```

`src/config/db.js` calls `dns.setServers()` before the first connect, so the SRV
and TXT lookups go to that resolver. This affects **only the API process** — the
machine's network settings are untouched, and nothing is committed.

If that works, the cause was the local resolver: check Windows' DNS order
(`ipconfig /all`), a VPN or Cloudflare WARP adapter, and antivirus "web shield" /
"secure DNS" features. `ipconfig /flushdns` clears a stale cache.

## Fix 2 — drop DNS out of the connection path entirely

Atlas can hand you a **standard** connection string that needs only ordinary A
records. Atlas → Connect → Drivers → choose an older driver (or toggle "standard
connection string"), or build it from the SRV/TXT output:

```
mongodb://<user>:<password>@ac-yu4z71i-shard-00-00.vxhoifi.mongodb.net:27017,ac-yu4z71i-shard-00-01.vxhoifi.mongodb.net:27017,ac-yu4z71i-shard-00-02.vxhoifi.mongodb.net:27017/hrms?ssl=true&replicaSet=atlas-nhq9bq-shard-0&authSource=admin&retryWrites=true&w=majority
```

Rules for a hand-written `mongodb://` URI:

- `authSource=admin` is **not** implied — the SRV TXT record supplied it before.
  Without it: `bad auth`.
- `replicaSet=atlas-nhq9bq-shard-0` must match the cluster (it is in the TXT
  record). Without it the driver may treat the hosts as standalone.
- Percent-encode the password (`@`→`%40`, `:`→`%3A`, `#`→`%23`, `%`→`%25`, …) —
  a raw `@` truncates the userinfo and the failure reads like a timeout.

The hostnames above are public DNS, not secrets; the credentials are not.

## Fix 3 — develop against a local database

Nothing in the API requires Atlas. For an offline or flaky-network week:

```bash
docker run -d --name crewly-mongo -p 27017:27017 mongo:7
```

```
MONGO_URI=mongodb://127.0.0.1:27017/hrms
```

Then `npm run seed` for demo data. Redis is optional — the API degrades without
it (see `docs/PHASE_28_1_REDIS_FOUNDATION.md`).

## When it is not DNS

The startup log names the class of failure:

| Message | Cause | Fix |
| --- | --- | --- |
| `bad auth` / `Authentication failed` | credentials | re-copy the string; encode the password |
| `not on its access list` / IP whitelist | Atlas Network Access | add the current public IP (new Wi-Fi = new IP) |
| `connect ECONNREFUSED 127.0.0.1:27017` | nothing listening locally | start mongod (Fix 3) |
| `Server selection timed out` with reachable hosts | TLS/proxy intercept | check antivirus HTTPS scanning, corporate proxy |

## Tests

`Backend/test/mongoConnectionDiagnostics.test.js` (`npm run test:db`) pins the
classifier: the two SRV messages must not share a summary, a stopped local mongod
must not be blamed on DNS, no step may echo the connection string, and
`dns.setServers` must run before the first connect.
