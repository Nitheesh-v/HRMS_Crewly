// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// PHASE 36.6 \u2014 CHAT TRANSCRIPT EXPORT (data only, no JSX)
//
// The formatting lives here so a test can assert it without a browser, and so
// the browser-only half (the Blob and the download) is one small function at
// the bottom that is easy to reason about on its own.
//
// WHAT THIS IS AND IS NOT.
//
//   It IS a convenience: a person can save their own conversation to a file
//   they control, to paste into a ticket or keep for their records.
//
//   It is NOT a data pipeline. There is no server call, no upload, no email
//   and no storage key. `buildTranscript` is a pure string function and
//   `downloadTranscript` touches the browser only.
//
// PRIVACY \u2014 WHY THIS IS ALLOWED AT ALL.
//
//   The transcript contains the employee's OWN questions and the assistant's
//   OWN answers about their own records. Nobody else's data is in it: the
//   server scoped every turn to req.user._id before this text existed.
//
//   The file is written to the machine the person is already sitting at, by a
//   click they made, and it is never sent anywhere by this code. The one thing
//   worth saying out loud is that the FILE now exists outside the browser, so
//   it is the employee's to protect \u2014 the same as any payslip PDF they have
//   already downloaded.
//
// WHY THE TIMESTAMP IS ON THE MESSAGE.
//
//   Phase 36.6 also added `at: Date.now()` to every message in the slice's
//   reducers. Without it an export would have to stamp "now" on every line,
//   which would be a lie about when the question was actually asked. The
//   reducer is the single place a message is created, so one change covers
//   every dispatch site.
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

/** Who said it, in the words the transcript uses. */
const SPEAKER = Object.freeze({
  user: 'User',
  assistant: 'Assistant',
});

/**
 * `[2026-09-30 10:15]` in the reader's own timezone.
 *
 * Local time, not UTC, on purpose: this is a personal record of a conversation
 * the person had at their desk, and "10:15" should be the 10:15 they saw.
 */
const stamp = (value) => {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) return '[unknown time]';

  const pad = (part) => String(part).padStart(2, '0');

  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

  return `[${day} ${clock}]`;
};

/**
 * Resolve when a message was created.
 *
 * Prefers the reducer’s `at`. Falls back to the epoch embedded in the id
 * (`user-1727686400000`), which is what 36.3-36.5 messages carry.
 *
 * WHEN NEITHER EXISTS it returns `[unknown time]` rather than the export
 * time. That is deliberate and it is the whole point of this function:
 * stamping "now" on a turn that happened twenty minutes ago is a lie about
 * when the question was actually asked, and a transcript that lies about
 * its own timestamps is worthless as a record. An unknown time is honest.
 */
const messageTime = (message) => {
  if (typeof message?.at === 'number' && Number.isFinite(message.at)) {
    return stamp(message.at);
  }

  const fromId = /-(\d{10,})$/.exec(String(message?.id || ''));

  if (fromId) return stamp(Number(fromId[1]));

  return '[unknown time]';
};

/**
 * Build the plain-text transcript.
 *
 * Format, one turn per two lines:
 *
 *   [2026-09-30 10:15] User: What is my leave balance?
 *   [2026-09-30 10:15] Assistant: You have 4 sick leaves remaining...
 *
 * @param {Array<{id?: string, role: string, content: string, at?: number}>} messages
 * @param {object}  [options]
 * @param {Date}    [options.now]  The export moment, for the header only.
 *                                 A message's own timestamp is never
 *                                 replaced by it.
 * @returns {string} '' when there is nothing to export.
 */
export const buildTranscript = (messages, options = {}) => {
  if (!Array.isArray(messages) || messages.length === 0) return '';

  const now = options.now instanceof Date ? options.now : new Date();

  const lines = [];

  messages.forEach((message) => {
    const role = message?.role === 'assistant' ? 'assistant' : 'user';

    const content = String(message?.content || '').trim();

    // A blank turn is skipped rather than exported as an empty line pair.
    if (content.length === 0) return;

    const speaker = SPEAKER[role];

    // Multi-line content is indented so a wrapped answer stays visually part
    // of the turn it belongs to instead of looking like a new speaker.
    const body = content
      .split('\n')
      .map((line, index) => (index === 0 ? line : `    ${line}`))
      .join('\n');

    lines.push(`${messageTime(message)} ${speaker}: ${body}`);
  });

  if (lines.length === 0) return '';

  // A short header, because a file called crewly-chat-transcript-2026-09-30.txt
  // that opens straight into a question is harder to recognise later.
  const header = [
    'CREWLY HR Assistant \u2014 chat transcript',
    `Exported: ${stamp(now)}`,
    `${lines.length} message(s). This file contains your own HR questions and the`,
    'assistant\u2019s answers about your own records. It was generated in your browser',
    'and was never sent to a server.',
    '',
  ];

  return `${header.join('\n')}${lines.join('\n')}\n`;
};

/**
 * `crewly-chat-transcript-2026-09-30.txt`
 *
 * Local date again, matching the timestamps inside the file.
 */
export const transcriptFileName = (date = new Date()) => {
  const pad = (part) => String(part).padStart(2, '0');

  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

  return `crewly-chat-transcript-${day}.txt`;
};

/**
 * Trigger the browser download. Returns true when a download was started.
 *
 * BROWSER ONLY. Everything above is pure; this is the one function that
 * touches a platform API, which is why it is small and separately guarded.
 *
 * `URL.createObjectURL` appears HERE and nowhere near the voice modules: 36.5
 * bans it in useSpeechRecognition.js and speechSynthesis.js because audio must
 * never be persisted, and a text transcript the person explicitly asked for is
 * a different thing entirely. The ban is scoped to those two files by design.
 *
 * The object URL is revoked on the next tick. Skipping that leaks a blob URL
 * per export for the life of the tab.
 */
export const downloadTranscript = (messages, options = {}) => {
  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    return false;
  }

  const text = buildTranscript(messages, options);

  if (text.length === 0) return false;

  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });

  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = transcriptFileName(
    options.now instanceof Date ? options.now : new Date(),
  );

  // Kept out of the layout so the click cannot shift anything.
  anchor.style.display = 'none';

  document.body.appendChild(anchor);

  anchor.click();

  document.body.removeChild(anchor);

  // Revoked asynchronously: some browsers cancel the download if the URL goes
  // away in the same tick as the click.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);

  return true;
};

export default { buildTranscript, transcriptFileName, downloadTranscript };
