// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.8 — WHERE THE CHAT SOCKET CONNECTS
//
// The resolver is pure, so it is pinned here directly. The client wiring is
// pinned by source assertions below, because importing the real
// chatSocketClient pulls in the store, api.js and socket.io-client, none of
// which belong in a hermetic test.
//
// WHAT THIS FILE IS REALLY GUARDING: a socket that connects to the wrong
// origin fails in the least visible way possible. The handshake is refused,
// the banner says "realtime unavailable", the REST half of chat keeps
// working, and the product looks like it has a Redis problem rather than a
// URL problem. Nothing in the UI says "the socket went to the wrong host".
// So the guarantee is pinned at the one place it is cheap to pin: the
// function that decides the URL.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSocketUrl } from '../src/services/realtime/socketUrl.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Comment-stripping reader, the same discipline every other code pin in this
// suite uses. Without it a ban matches the comment that explains the ban.
const read = (rel) => fs.readFileSync(path.join(here, '..', rel), 'utf8');

const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const CLIENT = 'src/services/realtime/chatSocketClient.js';

describe('Phase 36.8 — resolveSocketUrl', () => {
  test('nothing configured → empty, so the caller keeps same-origin behaviour', () => {
    assert.equal(resolveSocketUrl({}), '');
    assert.equal(resolveSocketUrl({ VITE_API_URL: '' }), '');
    assert.equal(resolveSocketUrl({ VITE_API_URL: '   ' }), '');
  });

  test('a relative VITE_API_URL has no origin to point the socket at', () => {
    // `/api` is the Vite proxy path and the documented default. There is no
    // host in it, and inventing one would connect to nothing.
    assert.equal(resolveSocketUrl({ VITE_API_URL: '/api' }), '');
  });

  test('the /api path is stripped — the socket is not under /api', () => {
    // This is the whole point of deriving an ORIGIN. Passing the whole
    // baseURL would request /api/socket.io, which does not exist, and the
    // resulting 404 reads like a server fault.
    assert.equal(
      resolveSocketUrl({ VITE_API_URL: 'https://api.example.com/api' }),
      'https://api.example.com',
    );
  });

  test('an API URL with no path still yields the origin', () => {
    assert.equal(
      resolveSocketUrl({ VITE_API_URL: 'https://api.example.com' }),
      'https://api.example.com',
    );
  });

  test('a trailing slash does not survive into the socket URL', () => {
    assert.equal(
      resolveSocketUrl({ VITE_API_URL: 'https://api.example.com/api/' }),
      'https://api.example.com',
    );
  });

  test('a local API URL is derived too — the proxy is bypassed, not broken', () => {
    assert.equal(
      resolveSocketUrl({ VITE_API_URL: 'http://localhost:5000/api' }),
      'http://localhost:5000',
    );
  });

  test('VITE_SOCKET_URL wins over the derived origin', () => {
    assert.equal(
      resolveSocketUrl({
        VITE_API_URL: 'https://api.example.com/api',
        VITE_SOCKET_URL: 'https://realtime.example.com',
      }),
      'https://realtime.example.com',
    );
  });

  test('an empty VITE_SOCKET_URL falls through to the derived origin', () => {
    // An unset variable in a .env file is an empty string, not undefined.
    assert.equal(
      resolveSocketUrl({
        VITE_API_URL: 'https://api.example.com/api',
        VITE_SOCKET_URL: '',
      }),
      'https://api.example.com',
    );
    assert.equal(
      resolveSocketUrl({
        VITE_API_URL: 'https://api.example.com/api',
        VITE_SOCKET_URL: '   ',
      }),
      'https://api.example.com',
    );
  });

  test('a relative VITE_SOCKET_URL is passed through — the client resolves it', () => {
    assert.equal(
      resolveSocketUrl({ VITE_SOCKET_URL: '/socket.io' }),
      '/socket.io',
    );
  });

  test('a non-http API URL yields nothing rather than a broken host', () => {
    assert.equal(resolveSocketUrl({ VITE_API_URL: 'ftp://api.example.com' }), '');
    assert.equal(resolveSocketUrl({ VITE_API_URL: 'not a url' }), '');
    assert.equal(resolveSocketUrl({ VITE_API_URL: '//api.example.com/api' }), '');
  });

  test('a missing source object is not a crash', () => {
    assert.equal(resolveSocketUrl(undefined), '');
    assert.equal(resolveSocketUrl(null), '');
  });
});

describe('Phase 36.8 — the client is wired to the resolver', () => {
  test('the client imports the resolver', () => {
    assert.match(
      code(CLIENT),
      /import\s*\{\s*resolveSocketUrl\s*\}\s*from\s*['"]\.\/socketUrl\.js['"]/,
    );
  });

  test('the client actually resolves a URL before connecting', () => {
    assert.match(code(CLIENT), /resolveSocketUrl\(\)/);
  });

  test('the io() call is conditional on the resolved URL', () => {
    // Shape-tolerant: the point is that BOTH call shapes exist, so a deploy
    // with a URL cannot silently fall back to the page origin.
    assert.match(
      code(CLIENT),
      /socketUrl\s*\?\s*io\(socketUrl,\s*socketOptions\)\s*:\s*io\(socketOptions\)/,
    );
  });

  test('the client hard-codes no host', () => {
    const source = code(CLIENT);
    // A literal host in the client is the bug wearing a different hat: it
    // works on one deploy and nowhere else.
    assert.ok(
      !/https?:\/\/[a-z0-9.-]/i.test(source),
      'the socket client must not contain a hardcoded host',
    );
    assert.ok(!/localhost:\d+/.test(source));
  });

  test('the resolver guards against a relative value before parsing it', () => {
    const source = code('src/services/realtime/socketUrl.js');
    // Without this guard `new URL('/api')` throws, and a module that throws
    // at import time takes the whole chat page down rather than degrading.
    assert.match(source, /\^https\?:/);
    // And the parse is wrapped, so a malformed absolute URL is a '' and not
    // an exception either.
    assert.match(source, /try\s*\{[\s\S]*?new URL\(/);
    assert.match(source, /catch\s*\{/);
  });
});

describe('Phase 36.8 — the deployment surface is documented', () => {
  test('VITE_SOCKET_URL is named in the frontend .env.example', () => {
    const example = read('.env.example');
    assert.ok(example.includes('VITE_SOCKET_URL'));
    // And it ships EMPTY: a checked-in socket URL is a deploy pinned to one
    // machine.
    assert.match(example, /^VITE_SOCKET_URL=\s*$/m);
  });
});
