// ═══════════════════════════════════════════════════════════════════════════
// UI COPY — the diet, pinned.
//
// The screens had grown a second voice: internal section markers ("§16"),
// phase numbers ("Phase 29.9"), and one- and two-sentence explanations under
// almost every heading. None of it is a number or an action, so all of it is
// noise to the person using the page.
//
// These pins hold the three rules the clean-up settled on, across every page in
// `src`, so a new screen cannot quietly reintroduce the habits:
//
//   1. no internal section markers (§) in rendered copy
//   2. no "Phase 29.x" build references in rendered copy
//   3. no `subtitle` / `note` / `hint` string over 110 characters
//
// Comments are exempt: the code may still explain itself to the next reader.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const SRC = path.join(root, 'src');

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.jsx')) out.push(full);
  }
  return out;
};

const isComment = (line) => {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('{/*') ||
    trimmed.startsWith('*/')
  );
};

// A trailing `// …` is a comment even when the line also holds code.
const codeOnly = (line) => line.replace(/\/\/.*$/, '');

const files = walk(SRC).map((full) => ({
  rel: path.relative(root, full).replace(/\\/g, '/'),
  source: fs.readFileSync(full, 'utf8'),
}));

describe('ui copy — no internal notes on the glass', () => {
  test('every jsx file was scanned', () => {
    assert.ok(files.length > 80, `expected the whole tree, scanned ${files.length} files`);
  });

  test('no section marker (§) reaches the screen', () => {
    const offenders = [];
    for (const { rel, source } of files) {
      source.split('\n').forEach((line, index) => {
        if (codeOnly(line).includes('§') && !isComment(line)) {
          offenders.push(`${rel}:${index + 1}: ${line.trim().slice(0, 90)}`);
        }
      });
    }
    assert.deepEqual(offenders, [], `rendered section markers:\n${offenders.join('\n')}`);
  });

  test('no build reference reaches the screen', () => {
    const offenders = [];
    for (const { rel, source } of files) {
      source.split('\n').forEach((line, index) => {
        if (/Phase\s+\d{2}\.\d/.test(codeOnly(line)) && !isComment(line)) {
          offenders.push(`${rel}:${index + 1}: ${line.trim().slice(0, 90)}`);
        }
      });
    }
    assert.deepEqual(offenders, [], `rendered phase references:\n${offenders.join('\n')}`);
  });

  test('no heading caption runs past 110 characters', () => {
    const offenders = [];
    for (const { rel, source } of files) {
      for (const match of source.matchAll(/(subtitle|note|hint)="([^"{}]{1,400})"/g)) {
        if (match[2].length > 110) {
          offenders.push(`${rel}: ${match[1]}="${match[2].slice(0, 80)}…" (${match[2].length})`);
        }
      }
    }
    assert.deepEqual(offenders, [], `over-long captions:\n${offenders.join('\n')}`);
  });
});
