// ═══════════════════════════════════════════════════════════════════════════
// Phase 32.14 — HARD-TERMINATION HARNESS FIXTURE (child process)
//
//   node test/helpers/crashServer.js --port <port> --mode mid-response|clean
//
// TEST-ONLY child used by failureRecovery.test.js to simulate a HARD
// process death mid-request (§21/§56/§97/§114) — something Ctrl+C can
// never show (SIGINT runs the graceful 32.2 drain). Loopback only;
// fixed modes; no arbitrary code/shell; exits by itself. This file is
// test infrastructure and is NEVER imported by product runtime.
//
// Modes:
//   mid-response — writes status+headers, writes a PARTIAL body chunk,
//                  then process.exit(1) BEFORE completing the response.
//                  The client must observe a broken response — never a
//                  fabricated success.
//   clean        — normal 200 JSON response (used as the healthy
//                  "API #2" in the failover assertion).
// ═══════════════════════════════════════════════════════════════════════════
import http from 'node:http';

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index !== -1 ? args[index + 1] : null;
};

const port = Number(flag('--port')) || 0;
const mode = flag('--mode') || 'clean';

const server = http.createServer((req, res) => {
  if (mode === 'mid-response') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"partial":tr'); // syntactically broken partial body
    // HARD death: no 'end' event, no graceful close, no drain — the
    // closest portable equivalent to a crashed process (§58: this is
    // NOT Ctrl+C and must never be labeled as graceful).
    setTimeout(() => process.exit(1), 5);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, pid: process.pid }));
});

server.listen(port, '127.0.0.1', () => {
  // Parent reads the bound port from stdout (one JSON line).
  process.stdout.write(`${JSON.stringify({ ready: true, port: server.address().port })}\n`);
});

// Safety net: never outlive the test run.
setTimeout(() => process.exit(0), 15000).unref();
