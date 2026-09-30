// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// PHASE 36.6 \u2014 STRUCTURED ANSWER CARDS (data only, no JSX)
//
// Plain Node can import this file, which is why the parser lives here and not
// inside ChatMessageBubble.jsx: a parser that only runs in a browser is a
// parser nobody tests.
//
// THE ONE RULE THIS FILE IS BUILT AROUND
//
//   A card may RE-RENDER information. It may never REMOVE or CHANGE it.
//
// The reply is model output answering an HR question. If this parser
// misreads a line and the card drops half a leave balance, the employee is
// worse off than with the plain text we shipped in 36.3. So the parse is
// deliberately conservative:
//
//   \u00b7 only a RUN of two or more consecutive bullet lines is considered;
//   \u00b7 EVERY line in that run must match `- Label: value`;
//   \u00b7 if any line does not, the whole run stays plain text;
//   \u00b7 label and value are rendered VERBATIM \u2014 nothing is reworded,
//     reformatted, rounded or reordered.
//
// The result is that a misparse degrades to exactly what 36.3 shipped, never
// to something worse.
//
// NOTE ON THE 36.3 NEGATIVES. A line like `- none assigned to you` has no
// colon, so it never matches and never becomes a card. That is correct: a
// stated negative is an ANSWER (prompt rule 8) and must stay readable prose.
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

/**
 * A bullet line carrying exactly one label and one value.
 *
 * Tolerant of the markdown a model reaches for on its own \u2014 bold, backticks
 * and a trailing full stop are all stripped from the LABEL only, never from
 * the value, because the value is the answer.
 *
 * The label is capped at 60 characters: a longer "label" is prose that happens
 * to contain a colon, and turning a paragraph into a card row is exactly the
 * misread this file exists to avoid.
 */
const BULLET_KEY_VALUE = /^[\u2022\-*]\s+([^:\n]{1,60}?):\s*(.+)$/;

const cleanLabel = (raw) =>
  String(raw || '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Parse a reply into an ordered list of blocks.
 *
 * @param {string} text
 * @returns {Array<{type: 'text', text: string}
 *                | {type: 'cards', items: Array<{label: string, value: string}>}>}
 *          Never returns an empty array for non-empty input: if nothing parses,
 *          the whole reply comes back as one text block.
 */
export const parseReplyBlocks = (text) => {
  const source = typeof text === 'string' ? text : '';

  if (source.trim().length === 0) return [];

  const lines = source.split('\n');

  const blocks = [];

  let paragraph = [];

  let run = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;

    blocks.push({ type: 'text', text: paragraph.join('\n') });

    paragraph = [];
  };

  const flushRun = () => {
    // Two is the minimum. A single `- Label: value` line gains nothing from a
    // card and loses its place in the surrounding prose.
    if (run.length >= 2) {
      blocks.push({ type: 'cards', items: run });
    } else if (run.length === 1) {
      // Put it back as the original line so nothing is reworded.
      paragraph.push(`- ${run[0].label}: ${run[0].value}`);
    }

    run = [];
  };

  lines.forEach((line) => {
    const match = BULLET_KEY_VALUE.exec(line);

    if (match) {
      // A card run starts, so the paragraph before it is closed.
      flushParagraph();

      run.push({
        label: cleanLabel(match[1]),
        value: match[2].trim(),
      });

      return;
    }

    // Not a key-value bullet: the run is over.
    flushRun();

    paragraph.push(line);
  });

  flushRun();
  flushParagraph();

  // If everything collapsed into text blocks, merge them back into one so the
  // caller renders exactly what 36.3 rendered.
  if (blocks.every((block) => block.type === 'text')) {
    return [{ type: 'text', text: source.trim() }];
  }

  return blocks.filter(
    (block) => block.type === 'cards' || block.text.trim().length > 0,
  );
};

/**
 * True when a reply contains at least one card block.
 *
 * Used by the panel to decide whether to bother rendering the card grid at
 * all, and by tests to assert the parser found something.
 */
export const hasCardBlocks = (text) =>
  parseReplyBlocks(text).some((block) => block.type === 'cards');

// Also a NAMED export, not just part of the default object: a test pins the
// regex itself, and reaching it through the default export would mean the pin
// breaks if the default object is ever reshaped.
export { BULLET_KEY_VALUE };

export default { parseReplyBlocks, hasCardBlocks, BULLET_KEY_VALUE };
