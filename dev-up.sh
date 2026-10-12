#!/usr/bin/env bash
# ============================================================
# Crewly one-command local full-stack: Mongo (replica set) +
# real Backend + real Frontend + demo tenant seed.
#   ./dev-up.sh
# Prereqs: Docker (recommended) OR a local mongod+mongosh; Node 20+.
# Or skip both: export MONGO_URI=<your Atlas string> before running.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

log() { printf '\033[1;32m[dev-up]\033[0m %s\n' "$*"; }

# ---- 1) database -----------------------------------------------------------
if [[ -z "${MONGO_URI:-}" ]]; then
  if command -v docker >/dev/null 2>&1; then
    log "starting Mongo (single-node replica set) via docker compose…"
    docker compose up -d mongo
    for _ in $(seq 1 40); do
      docker compose exec -T mongo mongosh --quiet --eval "db.adminCommand('ping').ok" >/dev/null 2>&1 && break
      sleep 2
    done
    docker compose up mongo-rs-init || true
    export MONGO_URI="mongodb://127.0.0.1:27017/crewly_dev?replicaSet=rs0"
  elif command -v mongod >/dev/null 2>&1; then
    log "starting local mongod (single-node replica set)…"
    mkdir -p .data/mongo
    pgrep -x mongod >/dev/null 2>&1 || mongod --dbpath .data/mongo --replSet rs0 --bind_ip 127.0.0.1 --port 27017 --fork --logpath .data/mongo.log
    sleep 2
    mongosh --quiet --eval 'try{rs.initiate()}catch(e){print("rs already initiated")}' >/dev/null 2>&1 || true
    export MONGO_URI="mongodb://127.0.0.1:27017/crewly_dev?replicaSet=rs0"
  else
    echo "No MongoDB available. Install Docker (recommended) or mongod," >&2
    echo "or export MONGO_URI with an Atlas connection string first." >&2
    exit 1
  fi
fi
log "MONGO_URI: ${MONGO_URI%%@*}@…(redacted)"

# ---- 2) backend env (dev-only secrets, never commit real values) ----------
if [[ ! -f Backend/.env ]]; then
  log "writing Backend/.env (development values)…"
  cat > Backend/.env <<ENV
NODE_ENV=development
PORT=5000
MONGO_URI=$MONGO_URI
CLIENT_URL=http://localhost:5173
JWT_SECRET=dev-only-secret-change-me
JWT_EXPIRES_IN=7d
REDIS_ENABLED=false
ENV
fi

# ---- 3) dependencies -------------------------------------------------------
[[ -d Backend/node_modules ]]  || { log "installing backend deps…";  (cd Backend  && npm ci --no-audit --no-fund); }
[[ -d Frontend/node_modules ]] || { log "installing frontend deps…"; (cd Frontend && npm ci --no-audit --no-fund); }

# ---- 4) seeds (idempotent) --------------------------------------------------
log "seeding super-admin + demo tenant…"
(cd Backend && npm run seed && npm run seed:demo)

# ---- 5) run both apps -------------------------------------------------------
log "starting backend (:5000) and frontend (:5173)…"
(cd Backend  && npm run dev) & BPID=$!
(cd Frontend && npm run dev) & FPID=$!
trap 'kill $BPID $FPID 2>/dev/null || true' EXIT

cat <<BANNER

  ✅ Crewly full stack is up.
     Frontend : http://localhost:5173
     Backend  : http://localhost:5000/api
     Logins   : company code crewlydemo
                hr@crewly.dev / Demo@123        (HR_MANAGER — sees all tickets + queues)
                priya@crewly.dev / Demo@123     (EMPLOYEE — raises & tracks own tickets)
     Helpdesk : sidebar → Administration → Support  (or /app/support)

BANNER
wait
