// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.5 — SPEECH RECOGNITION (browser-native, zero dependencies)
//
// Wraps the Web Speech API's SpeechRecognition. Nothing here is invented:
// there is no Whisper, no Google Cloud, no Azure, no ElevenLabs, no
// react-speech-* package. If the browser does not expose the interface, the
// hook reports `supported: false` and the caller hides the microphone. That
// is the whole contract.
//
// PRIVACY — THE ONE RULE THAT MATTERS HERE.
//   No audio is persisted anywhere. The browser streams the microphone to its
//   own speech service and hands back text; this hook receives text and never
//   a Blob, a MediaRecorder, an ArrayBuffer or a URL. There is no upload in
//   this file, no fetch, and no storage. The transcript lives in React state
//   for the life of the component and is gone when the panel closes.
//
//   What leaves the machine is the browser's own speech service, which is a
//   browser feature the person opted into by pressing the microphone. The
//   words that come back are still run through the SAME server-side PII
//   redaction as typed words — see hrChatbotService STEP 4. A spoken bank
//   account number is masked exactly like a typed one.
//
// SUPPORT IS UNEVEN AND THIS FILE DOES NOT PRETEND OTHERWISE.
//   Chrome and Edge: full. Safari: partial (no continuous mode, and it stops
//   itself after a pause). Firefox: behind a flag, so most users see
//   `supported: false`. The UI must degrade to a hidden button, never to a
//   broken one.
//
// NON-GOAL: there is no language auto-detection anywhere in this product.
// The recogniser is asked for the language the person already chose in the
// header. It is a preference, not an authority.
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The constructor, or null when the browser has none.
 *
 * Read lazily and defensively: a browser can expose the interface but throw
 * when it is constructed (older Safari), and that must not break a render.
 */
const getRecognitionConstructor = () => {
  if (typeof window === 'undefined') return null;

  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
};

/**
 * True only when the interface exists AND can actually be constructed.
 *
 * `supported` and `available` are deliberately two different answers. A
 * browser that has the constructor but refuses to build it (some Safari
 * builds, some embedded webviews) would render a button that does nothing,
 * which is worse than not rendering one.
 */
export const isSpeechRecognitionSupported = () => {
  const Ctor = getRecognitionConstructor();

  if (!Ctor) return false;

  try {
    const probe = new Ctor();

    probe.abort();

    return true;
  } catch {
    return false;
  }
};

/**
 * Map a Web Speech error code to something a person can act on.
 *
 * Kept as a pure export so a test can assert the wording without a browser,
 * and so the panel never has to inline an error taxonomy.
 */
export const describeSpeechError = (code) => {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access was blocked. Allow it in your browser and try again.';

    case 'no-speech':
      return 'Nothing was heard. Try again a little closer to the microphone.';

    case 'audio-capture':
      return 'No microphone was found on this device.';

    case 'network':
      return 'The speech service could not be reached. Check your connection.';

    case 'aborted':
      // The user stopped it, or the component unmounted. Not an error worth
      // showing — the panel already removed the "listening" state.
      return '';

    default:
      return 'Speech could not be recognised. You can still type your question.';
  }
};

/**
 * @param {object}   options
 * @param {string}   options.lang           BCP-47 tag. Defaults to en-IN.
 * @param {boolean}  options.continuous     Keep listening after a pause.
 * @param {boolean}  options.interimResults Report words as they are spoken.
 * @param {(text: string) => void} options.onFinal
 *        Called with the final transcript. The hook clears its own state
 *        before calling, so a caller that also clears its draft is safe.
 * @param {(message: string) => void} options.onError
 *        Called with a human message, or '' for a silent abort.
 *
 * @returns {{
 *   supported: boolean,
 *   listening: boolean,
 *   interim: string,
 *   error: string,
 *   start: () => void,
 *   stop: () => void,
 *   toggle: () => void,
 * }}
 */
export const useSpeechRecognition = ({
  lang = 'en-IN',
  continuous = false,
  interimResults = true,
  onFinal,
  onError,
} = {}) => {
  const [supported] = useState(() => isSpeechRecognitionSupported());

  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');

  // The recogniser instance lives in a ref, not state: it is an imperative
  // object with its own lifecycle, and putting it in state would re-render on
  // every assignment for no benefit.
  const recognitionRef = useRef(null);

  // Callbacks in refs so a stale closure can never capture an old `lang` or an
  // old `onFinal`. The handler is registered once; these are read at call
  // time. This is also what lets a language change take effect on the NEXT
  // start without tearing down the current session.
  const langRef = useRef(lang);
  const continuousRef = useRef(continuous);
  const interimRef = useRef(interimResults);
  const onFinalRef = useRef(onFinal);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    langRef.current = lang;
    continuousRef.current = continuous;
    interimRef.current = interimResults;
    onFinalRef.current = onFinal;
    onErrorRef.current = onError;
  }, [lang, continuous, interimResults, onFinal, onError]);

  /** Tear the recogniser down. Safe to call when there is nothing to tear. */
  const teardown = useCallback(() => {
    const recognition = recognitionRef.current;

    recognitionRef.current = null;

    if (!recognition) return;

    // Detach first: an abort fires `onend`, and a handler still attached would
    // flip `listening` back on and re-enter the start path.
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;

    try {
      recognition.abort();
    } catch {
      /* already dead */
    }
  }, []);

  const start = useCallback(() => {
    if (!supported || recognitionRef.current) return;

    const Ctor = getRecognitionConstructor();

    if (!Ctor) {
      setError('Speech recognition is not available in this browser.');

      return;
    }

    let recognition;

    try {
      recognition = new Ctor();
    } catch {
      setError('Speech recognition could not be started in this browser.');

      return;
    }

    recognitionRef.current = recognition;

    // Apply the CURRENT preference at start time. Re-reading the ref here is
    // what makes a language change land on the next session.
    recognition.lang = langRef.current || 'en-IN';
    recognition.continuous = continuousRef.current === true;
    recognition.interimResults = interimRef.current !== false;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      let spoken = '';

      // Walk every result from the index the API says is new, so a continuous
      // session accumulates instead of overwriting. Taking only the last
      // result would drop everything before a pause.
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];

        if (result.isFinal) {
          onFinalRef.current?.(result[0].transcript.trim());
        } else {
          spoken += result[0].transcript;
        }
      }

      setInterim(spoken.trim());
    };

    recognition.onerror = (event) => {
      const message = describeSpeechError(event?.error);

      setError(message);

      if (message) onErrorRef.current?.(message);
    };

    recognition.onend = () => {
      // Fires on a natural stop, a manual stop, and an abort. Either way the
      // recogniser is finished, so the reference is cleared and the UI stops
      // claiming to listen.
      recognitionRef.current = null;
      setListening(false);
      setInterim('');
    };

    try {
      recognition.start();

      setListening(true);
      setError('');
    } catch {
      // A second start before the first settled throws InvalidStateError.
      // Nothing is broken; just do not flip the UI into a lying state.
      recognitionRef.current = null;
    }
  }, [supported]);

  const stop = useCallback(() => {
    const recognition = recognitionRef.current;

    if (!recognition) {
      setListening(false);

      return;
    }

    try {
      recognition.stop();
    } catch {
      /* already stopped */
    }
  }, []);

  const toggle = useCallback(() => {
    if (listening) stop();
    else start();
  }, [listening, start, stop]);

  // Unmount must stop the microphone. A panel that is closed but still
  // listening is both a privacy surprise and a battery drain.
  useEffect(() => teardown, [teardown]);

  return {
    supported,
    listening,
    interim,
    error,
    start,
    stop,
    toggle,
  };
};

export default useSpeechRecognition;
