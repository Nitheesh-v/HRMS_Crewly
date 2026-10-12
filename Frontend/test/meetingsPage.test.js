// ═══════════════════════════════════════════════════════════════════════════
// MEETINGS PAGE — the link must be openable, and an edit must not rewrite the
// series it was opened from.
//
// Two owner reports land here:
//   1. "if we opening the meeting link it opens with localhost with /meeting
//      link so it does not opening" — a scheme-less value in `href` is a
//      RELATIVE path, so the browser resolved `meet.google.com/abc` against the
//      app origin and the Join button 404'd.
//   2. "editing was not working" — the edit modal prefilled its date from the
//      clicked OCCURRENCE, so saving a recurring meeting moved the series anchor
//      to that date and every earlier occurrence disappeared.
//
// The parser is pure, so its behaviour is pinned directly. The wiring is pinned
// by source assertions (the repo's discipline for JSX), with comments stripped
// first — otherwise a ban matches the comment that explains the ban.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMeetingLink } from '../src/utils/meetingLink.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const read = (rel) => fs.readFileSync(path.join(here, '..', rel), 'utf8');

const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const PAGE = 'src/pages/meetings/MeetingsPage.jsx';

describe('meeting links — the client parser', () => {
  test('a plain "meet.google.com/…" becomes an absolute https address', () => {
    assert.equal(
      parseMeetingLink('meet.google.com/abc-defg-hij').link,
      'https://meet.google.com/abc-defg-hij',
    );
    assert.equal(parseMeetingLink('zoom.us/j/12345').link, 'https://zoom.us/j/12345');
  });

  test('http(s) is preserved, whitespace is ignored', () => {
    assert.equal(parseMeetingLink('  https://meet.google.com/abc  ').link, 'https://meet.google.com/abc');
    assert.equal(parseMeetingLink('http://localhost:8080/room').link, 'http://localhost:8080/room');
  });

  test('the client refuses what the server refuses', () => {
    for (const raw of ['javascript:alert(1)', 'data:text/html,x', 'zoommtg://zoom.us/join', 'file:///etc/passwd']) {
      const parsed = parseMeetingLink(raw);

      assert.equal(parsed.link, '', raw);
      assert.ok(parsed.error, raw);
    }
  });

  test('empty stays empty so "no link" is still a valid meeting', () => {
    assert.deepEqual(parseMeetingLink(''), { link: '', error: null });
    assert.deepEqual(parseMeetingLink('   '), { link: '', error: null });
    assert.deepEqual(parseMeetingLink(null), { link: '', error: null });
  });

  test('an unsalvageable value is reported instead of silently stored', () => {
    assert.equal(parseMeetingLink('https://').link, '');
    assert.match(parseMeetingLink('https://').error, /incomplete/i);
    assert.equal(parseMeetingLink('the usual room').link, '');
  });

  test('both copies of the parser agree on the messages', () => {
    const backend = fs.readFileSync(
      path.join(here, '..', '..', 'Backend', 'src', 'utils', 'meetingLink.js'),
      'utf8',
    );

    for (const phrase of ['must be a normal http(s) web address', 'include the full address']) {
      assert.ok(backend.includes(phrase), `backend copy still says: ${phrase}`);
      assert.ok(read('src/utils/meetingLink.js').includes(phrase), `client copy still says: ${phrase}`);
    }
  });
});

describe('MeetingsPage — Join Meeting', () => {
  test('href never receives the raw stored value', () => {
    const source = code(PAGE);

    assert.ok(source.includes('href={joinLink.link}'), 'the anchor uses the parsed link');
    assert.equal(source.includes('href={selected.link}'), false, 'raw href is banned');
  });

  test('an unusable link explains itself instead of rendering a dead anchor', () => {
    const source = code(PAGE);

    assert.ok(source.includes('const joinLink = selected ? parseMeetingLink(selected.link)'));
    assert.ok(source.includes('!joinLink.link'), 'there is a branch for an unusable link');
  });
});

describe('MeetingsPage — the edit form', () => {
  test('a link that cannot be salvaged blocks the save and says why', () => {
    const source = code(PAGE);

    assert.ok(source.includes('if (linkState.error) return setErr(linkState.error)'));
    assert.ok(source.includes('linkState.error && <p'), 'and shows it under the field');
  });

  test('the payload carries the normalised link, not the typed text', () => {
    const source = code(PAGE);

    assert.ok(source.includes('link: linkState.link,'));
    assert.equal(source.includes('link: form.link,'), false);
  });

  test('editing a recurring meeting edits the SERIES anchor', () => {
    const source = code(PAGE);

    assert.ok(
      source.includes('const isSeries = Boolean(initial?.recurrence && initial.recurrence !== \'NONE\')'),
      'the modal knows it is looking at a series',
    );
    assert.ok(source.includes('? (initial?.startAt || initial?.occStart'), 'the anchor is preferred over the occurrence');
    assert.ok(source.includes("'Series starts'"), 'and the field is labelled honestly');
    assert.ok(source.includes('changes apply to the whole series'), 'with a visible consequence');
  });

  test('a stale load error is cleared once a load succeeds', () => {
    assert.ok(code(PAGE).includes("setMsg('');"), 'a good load clears the red banner');
  });
});

describe('dead meeting client is gone', () => {
  test('selfService no longer offers a meeting client that 404s', () => {
    const source = code('src/services/selfService.js');

    assert.equal(source.includes("api.get('/meetings/my')"), false, '/meetings/my has never existed');
    assert.equal(source.includes('meetingService'), false);
  });
});
