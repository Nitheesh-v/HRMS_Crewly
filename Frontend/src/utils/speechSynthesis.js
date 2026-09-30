// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.5 — SPEECH SYNTHESIS (browser-native, zero dependencies)
//
// The read-aloud half of the voice assistant. Like the recogniser, this is
// the browser's own `speechSynthesis` — no vendor, no API key, no network
// call of ours, no new package.
//
// PRIVACY. The text to speak is the assistant's reply, which is ALREADY on
// screen. Nothing new is generated, nothing is uploaded, and nothing is
// stored. There is no audio file, no Blob and no URL anywhere in this file:
// the browser synthesises locally from installed system voices.
//
// WHY A MODULE AND NOT A HOOK. Speaking is a global, singleton resource:
// `window.speechSynthesis` has one queue for the whole tab, and two
// components each owning "the current utterance" is how you get overlapping
// voices. One module owns the utterance and hands out handles, so the panel's
// speaker button and the auto-speak path can never talk over each other.
//
// VOICE QUALITY IS THE OPERATING SYSTEM'S PROBLEM, NOT OURS.
//   Tamil, Telugu and Hindi need a voice actually INSTALLED on the machine.
//   Windows and Android usually have them; many macOS and Linux installs do
//   not. When no voice matches, the browser still speaks — it just uses its
//   default voice and the accent may be wrong. The UI says "read aloud", not
//   "read aloud in Tamil", because it cannot promise the second.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The synthesiser, or null when the browser has none.
 *
 * Safari exposes `speechSynthesis` but historically needed a user gesture
 * before the first utterance, which is why every entry point here is called
 * from a click or from a send the person initiated.
 */
const getSynth = () => {
  if (typeof window === 'undefined') return null;

  return window.speechSynthesis ?? null;
};

export const isSpeechSynthesisSupported = () => {
  const synth = getSynth();

  if (!synth || typeof synth.speak !== 'function') return false;

  try {
    // Some locked-down environments expose the object and throw on use.
    return typeof SpeechSynthesisUtterance !== 'undefined';
  } catch {
    return false;
  }
};

/** The voice actually chosen for a BCP-47 tag, or null. */
const pickVoice = (voices, bcp47) => {
  if (!Array.isArray(voices) || voices.length === 0) return null;

  // An exact tag match first (en-IN, ta-IN), then the bare language (ta) so a
  // machine with only a generic Tamil voice still gets it.
  const exact = voices.find((voice) => voice?.lang === bcp47);

  if (exact) return exact;

  const base = String(bcp47 || '').split('-')[0];

  return voices.find((voice) => voice?.lang?.split('-')[0] === base) ?? null;
};

/**
 * Speak one string.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.lang]        BCP-47 tag. Defaults to en-IN.
 * @param {number} [options.rate]        0.5–2. Defaults to 1.
 * @param {number} [options.pitch]       0–2. Defaults to 1.
 * @param {() => void} [options.onStart] Called the moment speaking begins.
 * @param {() => void} [options.onEnd]   Always called once, including on error.
 *
 * @returns {{stop: () => void}} A handle, or a no-op handle when unsupported.
 *          The handle is ALWAYS returned so a caller never has to branch on
 *          support just to avoid a crash.
 */
export const speak = (text, options = {}) => {
  const spoken = String(text || '').trim();

  const noop = { stop: () => {} };

  const synth = getSynth();

  if (!spoken || !synth) return noop;

  const {
    lang = 'en-IN',
    rate = 1,
    pitch = 1,
    onStart,
    onEnd,
  } = options;

  // Stop whatever was already speaking. One reply at a time: a second click
  // must replace the voice, not queue behind it.
  stopSpeaking();

  let utterance;

  try {
    utterance = new SpeechSynthesisUtterance(spoken);
  } catch {
    onEnd?.();

    return noop;
  }

  utterance.lang = lang;
  utterance.rate = rate;
  utterance.pitch = pitch;

  const voice = pickVoice(synth.getVoices?.() ?? [], lang);

  // A null voice is fine and expected on many machines: the browser then uses
  // its default voice for that language. Setting it anyway would be worse.
  if (voice) utterance.voice = voice;

  // Guarded so a double end (error then end) cannot fire the caller twice and
  // leave a speaker button stuck in the "speaking" state.
  let finished = false;

  const finish = () => {
    if (finished) return;

    finished = true;

    onEnd?.();
  };

  utterance.onend = finish;
  utterance.onerror = finish;

  try {
    synth.speak(utterance);

    // Fired here rather than by the caller so the "is this bubble being
    // read" state belongs to the speech lifecycle and not to a render
    // path. A caller that sets its own flag before this point can briefly
    // claim to be speaking when the browser refused to start.
    onStart?.();
  } catch {
    finish();

    return noop;
  }

  return {
    stop: () => {
      try {
        synth.cancel();
      } catch {
        /* already silent */
      }

      finish();
    },
  };
};

/** Silence the tab immediately. Safe to call when nothing is speaking. */
export const stopSpeaking = () => {
  const synth = getSynth();

  if (!synth) return;

  try {
    synth.cancel();
  } catch {
    /* already silent */
  }
};

/**
 * True while the tab is speaking.
 *
 * `speechSynthesis.speaking` is the browser's own answer and is the only
 * honest source; there is no per-utterance flag to read.
 */
export const isSpeaking = () => {
  const synth = getSynth();

  if (!synth) return false;

  return synth.speaking === true || synth.pending === true;
};

/**
 * Wait for the voice list to populate.
 *
 * Chrome and Safari load `getVoices()` asynchronously, so the first call can
 * legitimately return an empty array. Calling this before the first speak is
 * what stops a Tamil reply from falling back to an English voice for no
 * reason other than a race.
 *
 * Resolves immediately (and never rejects) when unsupported or already loaded.
 */
export const whenVoicesReady = () =>
  new Promise((resolve) => {
    const synth = getSynth();

    if (!synth || typeof synth.getVoices !== 'function') {
      resolve([]);

      return;
    }

    const voices = synth.getVoices();

    if (voices.length > 0) {
      resolve(voices);

      return;
    }

    let settled = false;

    const done = () => {
      if (settled) return;

      settled = true;

      resolve(synth.getVoices());
    };

    // `voiceschanged` is the documented event, but not every browser fires it
    // reliably, so a short timeout backs it up. 1200ms is well past the point
    // where a loaded machine has answered, and short enough not to delay the
    // first reply noticeably.
    synth.addEventListener?.('voiceschanged', done, { once: true });

    window.setTimeout(done, 1200);
  });

export default {
  speak,
  stopSpeaking,
  isSpeaking,
  isSpeechSynthesisSupported,
  whenVoicesReady,
};
