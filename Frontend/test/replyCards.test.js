// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.6 — STRUCTURED ANSWER CARDS
//
// The parser is pure data, so it is tested here rather than through a browser.
// A parser that only runs in a browser is a parser nobody tests.
//
// THE LAW THIS FILE GUARDS: a card may RE-RENDER information. It may never
// REMOVE or CHANGE it. Every assertion below is some way of saying that a
// misparse degrades to the plain text 36.3 shipped, never to something worse.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BULLET_KEY_VALUE,
  hasCardBlocks,
  parseReplyBlocks,
} from '../src/components/AIAssistant/replyCards.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const read = (rel) => fs.readFileSync(path.join(here, '..', rel), 'utf8');

describe('replyCards — the conservative parse', () => {
  test('a run of two or more key-value bullets becomes cards', () => {
    const blocks = parseReplyBlocks(
      'You have 4 sick leaves remaining.\n\n- Sick Leave: 4 remaining\n- Casual Leave: 6 remaining',
    );

    const cards = blocks.filter((block) => block.type === 'cards');

    assert.equal(cards.length, 1);
    assert.deepEqual(cards[0].items, [
      { label: 'Sick Leave', value: '4 remaining' },
      { label: 'Casual Leave', value: '6 remaining' },
    ]);
  });

  test('the prose around the bullets survives untouched', () => {
    const blocks = parseReplyBlocks(
      'Before.\n\n- A: 1\n- B: 2\n\nAfter.',
    );

    assert.deepEqual(
      blocks.map((block) => block.type),
      ['text', 'cards', 'text'],
    );

    assert.equal(blocks[0].text.startsWith('Before.'), true);
    assert.equal(blocks[2].text.trim(), 'After.');
  });

  test('a SINGLE bullet stays text — a one-row card gains nothing', () => {
    const blocks = parseReplyBlocks('- Only one: value');

    assert.deepEqual(blocks, [{ type: 'text', text: '- Only one: value' }]);
    assert.equal(hasCardBlocks('- Only one: value'), false);
  });

  test('a bullet with no colon is never a card — this is the 36.3 negatives law', () => {
    // "none assigned to you" is an ANSWER, not a missing field. Turning it
    // into a card row would strip the prose that makes it readable.
    const text = '- none assigned to you\n- nothing pending';

    assert.deepEqual(parseReplyBlocks(text), [{ type: 'text', text }]);
    assert.equal(hasCardBlocks(text), false);
  });

  test('a MIXED run stays text: one bad line collapses the whole run', () => {
    // The deliberately conservative half. If any line in a run fails to match,
    // the entire run renders as the plain text 36.3 shipped.
    const text = '- Sick Leave: 4 remaining\n- none assigned to you';

    assert.deepEqual(parseReplyBlocks(text), [{ type: 'text', text }]);
  });

  test('prose that happens to contain a colon is not a card', () => {
    const text = 'My manager is Rajesh Kumar: he approved this';

    assert.deepEqual(parseReplyBlocks(text), [{ type: 'text', text }]);
  });

  test('an over-long "label" is prose, not a field name', () => {
    // 80 characters before the colon is a sentence. Rendering it as a card
    // row is exactly the misread this cap exists to prevent.
    const text = `- ${'x'.repeat(80)}: value\n- Another: value`;

    assert.deepEqual(parseReplyBlocks(text), [{ type: 'text', text }]);
  });

  test('all three bullet markers are accepted', () => {
    ['- ', '* ', '\u2022 '].forEach((marker) => {
      const text = `${marker}Sick Leave: 4 remaining\n${marker}Casual Leave: 6 remaining`;

      const cards = parseReplyBlocks(text).filter(
        (block) => block.type === 'cards',
      );

      assert.equal(cards.length, 1, `marker ${JSON.stringify(marker)} failed`);
      assert.equal(cards[0].items.length, 2);
    });
  });

  test('markdown bold and backticks are stripped from the LABEL only', () => {
    const blocks = parseReplyBlocks(
      '- **Sick Leave**: 4 remaining\n- `Casual Leave`: 6 remaining',
    );

    const cards = blocks.find((block) => block.type === 'cards');

    assert.deepEqual(cards.items, [
      { label: 'Sick Leave', value: '4 remaining' },
      { label: 'Casual Leave', value: '6 remaining' },
    ]);
  });

  test('the VALUE is never altered', () => {
    // The value is the answer. No trimming beyond whitespace, no rewording,
    // no rounding, no reordering.
    const blocks = parseReplyBlocks(
      '- Balance: 8 remaining / 12 total (4 approved, 0 pending)\n- Status: ACTIVE',
    );

    const cards = blocks.find((block) => block.type === 'cards');

    assert.equal(
      cards.items[0].value,
      '8 remaining / 12 total (4 approved, 0 pending)',
    );
    assert.equal(cards.items[1].value, 'ACTIVE');
  });

  test('an empty or non-string reply yields no blocks', () => {
    assert.deepEqual(parseReplyBlocks(''), []);
    assert.deepEqual(parseReplyBlocks('   '), []);
    assert.deepEqual(parseReplyBlocks(undefined), []);
    assert.deepEqual(parseReplyBlocks(null), []);
    assert.deepEqual(parseReplyBlocks(42), []);
  });

  test('a reply with no cards at all comes back as ONE text block', () => {
    // Exactly what 36.3 rendered. The caller must not have to special-case
    // "no cards found".
    const text = 'Just a plain answer with no bullets in it.';

    assert.deepEqual(parseReplyBlocks(text), [{ type: 'text', text }]);
  });

  test('two separate runs become two separate card groups', () => {
    const blocks = parseReplyBlocks(
      '- A: 1\n- B: 2\n\nSome prose.\n\n- C: 3\n- D: 4',
    );

    assert.deepEqual(
      blocks.map((block) => block.type),
      ['cards', 'text', 'cards'],
    );
  });
});

describe('replyCards — source pins', () => {
  test('the module holds no JSX and no React import', () => {
    // It must stay importable by plain Node, which is the whole reason the
    // parser is a separate file from the bubble.
    const source = read('src/components/AIAssistant/replyCards.js');

    assert.equal(source.includes('react'), false);
    assert.equal(source.includes('<div'), false);
    assert.equal(source.includes('=> ('), false);
  });

  test('the bullet regex is anchored and capped', () => {
    // Pinned so a future widening cannot quietly start turning prose into
    // cards. The 60-character label cap is the guard rail.
    assert.equal(BULLET_KEY_VALUE.source.includes('^'), true);
    assert.equal(BULLET_KEY_VALUE.source.includes('{1,60}'), true);
  });
});
