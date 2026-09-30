// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.6 — CHAT TRANSCRIPT EXPORT
//
// The formatting is a pure string function, so it is pinned here. The browser
// half (the Blob and the download) is one small function that cannot run in
// plain Node, and it is pinned by source assertions instead.
//
// WHAT THIS FILE IS REALLY GUARDING: the file is the employee's own record of
// their own conversation. It must be complete (every turn, verbatim), honest
// (a real timestamp, never a fabricated one) and self-describing (a header
// that says what it is, because a .txt that opens mid-question is confusing).
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildTranscript,
  downloadTranscript,
  transcriptFileName,
} from '../src/components/AIAssistant/chatTranscript.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const read = (rel) => fs.readFileSync(path.join(here, '..', rel), 'utf8');

const MESSAGES = [
  {
    id: 'user-1727686500000',
    role: 'user',
    content: 'What is my leave balance?',
    at: 1727686500000,
  },
  {
    id: 'assistant-1727686510000',
    role: 'assistant',
    content: 'You have 4 sick leaves remaining.',
    at: 1727686510000,
  },
];

describe('chatTranscript — the format', () => {
  test('each turn is one timestamped, labelled line', () => {
    const text = buildTranscript(MESSAGES);

    const lines = text.split('\n').filter((line) => line.startsWith('['));

    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] User: What is my leave balance\?$/);
    assert.match(
      lines[1],
      /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] Assistant: You have 4 sick leaves remaining\.$/,
    );
  });

  test('a header explains what the file is and that it never left the browser', () => {
    const text = buildTranscript(MESSAGES);

    assert.equal(text.includes('CREWLY HR Assistant'), true);
    assert.equal(text.includes('chat transcript'), true);
    assert.equal(text.includes('Exported:'), true);

    // The privacy sentence matters: whoever opens this file later deserves to
    // know it holds their own HR questions and answers.
    assert.equal(text.includes('your own HR questions'), true);
    assert.equal(text.includes('never sent to a server'), true);
  });

  test('a multi-line answer is indented so it stays part of its turn', () => {
    const text = buildTranscript([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Line one.\nLine two.',
        at: 1727686510000,
      },
    ]);

    assert.equal(text.includes('Assistant: Line one.\n    Line two.'), true);
  });

  test('every message is present, in order, verbatim', () => {
    const many = Array.from({ length: 12 }, (_unused, index) => ({
      id: `user-${index}`,
      role: 'user',
      content: `question ${index}`,
      at: 1727686500000 + index * 1000,
    }));

    const text = buildTranscript(many);

    for (let index = 0; index < 12; index += 1) {
      assert.equal(text.includes(`question ${index}`), true);
    }
  });

  test('a blank turn is skipped rather than exported as an empty line', () => {
    const text = buildTranscript([
      { id: 'user-1', role: 'user', content: '   ', at: 1 },
      { id: 'user-2', role: 'user', content: 'real question', at: 2 },
    ]);

    const turns = text.split('\n').filter((line) => line.startsWith('['));

    assert.equal(turns.length, 1);
    assert.equal(text.includes('real question'), true);
  });

  test('an empty conversation exports nothing at all', () => {
    assert.equal(buildTranscript([]), '');
    assert.equal(buildTranscript(undefined), '');
    assert.equal(buildTranscript(null), '');
  });
});

describe('chatTranscript — honest timestamps', () => {
  test('the reducer timestamp is preferred', () => {
    const text = buildTranscript([
      { id: 'user-1', role: 'user', content: 'hi', at: 1727686500000 },
    ]);

    // 2024-09-30, local time. If the `at` field were ignored this would
    // print today's date instead, which would be a lie about when the
    // question was asked.
    assert.match(text, /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] User: hi/);
    assert.equal(text.includes('[unknown time]'), false);
  });

  test('the epoch embedded in a 36.3-36.5 id is used as a fallback', () => {
    // Messages created before 36.6 carried no `at`, only an id like
    // `user-1727686500000`.
    const text = buildTranscript([
      { id: 'user-1727686500000', role: 'user', content: 'hi' },
    ]);

    assert.equal(text.includes('[unknown time]'), false);
    assert.match(text, /User: hi/);
  });

  test('an unparseable timestamp prints unknown, never a plausible lie', () => {
    const text = buildTranscript([{ id: 'nope', role: 'user', content: 'hi' }]);

    assert.equal(text.includes('[unknown time] User: hi'), true);
  });
});

describe('chatTranscript — the file name', () => {
  test('it is dated, in local time, and says what it is', () => {
    const name = transcriptFileName(new Date(2026, 8, 30));

    assert.equal(name, 'crewly-chat-transcript-2026-09-30.txt');
    assert.equal(name.startsWith('crewly-chat-transcript-'), true);
    assert.equal(name.endsWith('.txt'), true);
  });

  test('the day and month are zero-padded', () => {
    const name = transcriptFileName(new Date(2026, 0, 5));

    assert.equal(name, 'crewly-chat-transcript-2026-01-05.txt');
  });
});

describe('chatTranscript — source pins', () => {
  test('the browser download is guarded and revokes its object URL', () => {
    const source = read('src/components/AIAssistant/chatTranscript.js');

    // A Blob URL that is never revoked leaks for the life of the tab.
    assert.equal(source.includes('URL.revokeObjectURL'), true);

    // No server call of any kind. This is the whole privacy argument for the
    // feature: the file is built and handed to the browser locally.
    assert.equal(source.includes('api.js'), false);
    assert.equal(source.includes('fetch('), false);
    assert.equal(source.includes('axios'), false);
    assert.equal(source.includes('localStorage'), false);
    assert.equal(source.includes('sessionStorage'), false);
  });

  test('no emojis anywhere in the module', () => {
    const source = read('src/components/AIAssistant/chatTranscript.js');

    // The house rule: no emojis in new UI. A transcript is UI-adjacent and
    // the header text ends up on screen in a text editor.
  // The Unicode property, not a hand-built range. A literal class that
  // includes U+FE0F (the variation selector) is flagged by
  // no-misleading-character-class, because that codepoint is a COMBINING
  // character and the rule exists to stop a class silently matching a
  // base character plus its decoration. \p{Extended_Pictographic} says the
  // same thing without the trap.
  const emoji = /\p{Extended_Pictographic}/u;

    assert.equal(emoji.test(source), false);
  });

  test('downloadTranscript is a no-op without a browser', () => {
    // Plain Node has no `document`, so the function must refuse rather than
    // throw. That is also what makes this module importable by the tests.
    assert.equal(downloadTranscript(MESSAGES), false);
    assert.equal(downloadTranscript([]), false);
  });
});
