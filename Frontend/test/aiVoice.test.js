// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// PHASE 36.5 \u2014 VOICE WIRING (source pins, deliberately not behavioural)
//
// READ THIS BEFORE TRUSTING THESE GREEN TICKS.
//
// The browser's SpeechRecognition and speechSynthesis cannot be exercised
// hermetically. There is no DOM in this runner, no microphone, no installed
// system voice, and a fake that returns a transcript would only be testing
// the fake. A behavioural test here would be a green tick that means nothing.
//
// So this file pins the WIRING instead: that the modules exist, that they
// import the right icons, that the privacy rules are present in the source,
// and that the two behaviours the owner cares about most \u2014 `sentViaVoice` and
// the one-shot auto-speak latch \u2014 are actually coded and not merely intended.
//
// That is the honest limit of what can be automated. The owner still has to
// press the microphone in Chrome and listen to the reply, which is exactly
// what the honest-flags section of the phase doc says.
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');

const read = (rel) => fs.readFileSync(path.join(src, rel), 'utf8');

/** Strip comments so a pin cannot match a doc block describing itself. */
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('Phase 36.5 voice wiring', () => {
  // \u2500\u2500 the two browser-facing modules exist \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  test('useSpeechRecognition.js exists and exports the hook', () => {
    const source = read('hooks/useSpeechRecognition.js');

    assert.equal(source.includes('export const useSpeechRecognition'), true);
    assert.equal(source.includes('export default useSpeechRecognition'), true);
    assert.equal(source.includes('isSpeechRecognitionSupported'), true);
  });

  test('speechSynthesis.js exists and exports speak and stop', () => {
    const source = read('utils/speechSynthesis.js');

    for (const name of [
      'export const speak',
      'export const stopSpeaking',
      'export const isSpeechSynthesisSupported',
      'export const whenVoicesReady',
    ]) {
      assert.equal(source.includes(name), true, `missing ${name}`);
    }
  });

  // \u2500\u2500 ZERO new packages \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  test('no speech package was added to package.json', () => {
    // The hard rule: browser-native only. Whisper, Google, Azure,
    // ElevenLabs and every react-speech-* wrapper are out of scope.
    const pkg = JSON.parse(read('../package.json'));

    const deps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };

    const banned = [
      'whisper',
      'react-speech',
      'react-hook-speech-to-text',
      'speech-to-text',
      '@google-cloud/speech',
      'microsoft-cognitiveservices-speech-sdk',
      'elevenlabs',
      'openai',
      'react-media-recorder',
      'recordrtc',
    ];

    for (const name of Object.keys(deps)) {
      assert.equal(
        banned.some((bad) => name.includes(bad)),
        false,
        `a banned speech dependency is present: ${name}`,
      );
    }
  });

  test('no speech or AI vendor is called anywhere in the voice modules', () => {
    // Browser-native means no fetch, no axios, no api.js. If a network call
    // appears in either module, audio is leaving the machine and the privacy
    // claim in the docs is a lie.
    for (const rel of [
      'hooks/useSpeechRecognition.js',
      'utils/speechSynthesis.js',
    ]) {
      const source = code(rel);

      assert.equal(source.includes('fetch('), false, `${rel} calls fetch`);
      assert.equal(source.includes('api.js'), false, `${rel} imports the API client`);
      assert.equal(source.includes('XMLHttpRequest'), false, `${rel} uses XHR`);
    }
  });

  test('no audio is persisted by either module', () => {
    // The privacy rule that matters most. There is no Blob, no MediaRecorder,
    // no File, no URL.createObjectURL and no storage key anywhere.
    const banned = [
      'MediaRecorder',
      'createObjectURL',
      'new Blob',
      'FileReader',
      'indexedDB',
      'localStorage',
      'sessionStorage',
      'FormData',
      'new File',
    ];

    for (const rel of [
      'hooks/useSpeechRecognition.js',
      'utils/speechSynthesis.js',
    ]) {
      const source = code(rel);

      for (const needle of banned) {
        assert.equal(
          source.includes(needle),
          false,
          `${rel} references ${needle}`,
        );
      }
    }
  });

  // \u2500\u2500 the mic button \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  test('the input bar renders the mic only when the browser supports it', () => {
    const source = code('components/AIAssistant/ChatInputBar.jsx');

    assert.equal(source.includes('MicOff'), true, 'no MicOff icon');
    assert.equal(source.includes('Mic,'), true, 'no Mic icon');

    // The guard is the whole point: a disabled stub would be a button that
    // does nothing, which is worse than no button.
    assert.equal(source.includes('voiceSupported && ('), true);
  });

  test('the input bar forwards the sentViaVoice flag', () => {
    const source = code('components/AIAssistant/ChatInputBar.jsx');

    // This is the flag the panel uses to decide whether to read the reply
    // aloud. Without it the auto-speak feature has no trigger.
    assert.equal(source.includes('sentViaVoice: listening'), true);
  });

  test('the live transcript replaces the Enter hint rather than adding to it', () => {
    const source = code('components/AIAssistant/ChatInputBar.jsx');

    // Telling a person "Enter to send" while the microphone is listening is
    // two contradictory instructions at once.
    assert.equal(source.includes('listening ? ('), true);
    assert.equal(source.includes('voice?.interim'), true);
  });

  // \u2500\u2500 the speaker button \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  test('the bubble renders the speaker only on assistant replies', () => {
    const source = code('components/AIAssistant/ChatMessageBubble.jsx');

    assert.equal(source.includes('Volume2'), true, 'no Volume2 icon');
    assert.equal(source.includes('VolumeX'), true, 'no VolumeX icon');

    // Reading a person their own question back is noise, so the button is
    // assistant-only.
    assert.equal(source.includes('isAssistant && onSpeak'), true);
  });

  test('the speaker button toggles rather than only starting', () => {
    const source = code('components/AIAssistant/ChatMessageBubble.jsx');

    assert.equal(source.includes('speaking'), true);
    assert.equal(source.includes("'Stop reading'"), true);
  });

  // \u2500\u2500 the language selector \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  test('the panel renders a selector over the closed language list', () => {
    const source = code('components/AIAssistant/AiAssistantPanel.jsx');

    assert.equal(source.includes('CHAT_LANGUAGES.map'), true);
    assert.equal(source.includes('languageSet(event.target.value)'), true);
    assert.equal(source.includes('Languages'), true, 'no Languages icon');
  });

  test('the panel reads the language from Redux, never from localStorage', () => {
    const source = code('components/AIAssistant/AiAssistantPanel.jsx');

    assert.equal(source.includes('useSelector'), true);
    assert.equal(source.includes('language ='), true);

    // One exception would become the precedent for the next one, so the ban
    // is absolute and asserted.
    assert.equal(source.includes('localStorage'), false);
    assert.equal(source.includes('sessionStorage'), false);
  });

  // \u2500\u2500 the sentViaVoice / auto-speak contract \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  test('the panel sets the auto-speak latch only for a spoken question', () => {
    const source = code('components/AIAssistant/AiAssistantPanel.jsx');

    // The latch is a REF and not state, and that is not a style choice: a
    // state flag would re-fire under React's strict-mode double-invoke and
    // speak the same reply twice.
    assert.equal(source.includes('pendingVoiceSpeakRef'), true);
    assert.equal(source.includes('meta?.sentViaVoice === true'), true);
  });

  test('the panel consumes the latch exactly once, when the reply lands', () => {
    const source = code('components/AIAssistant/AiAssistantPanel.jsx');

    // Cleared BEFORE speaking, so a re-render cannot speak twice.
    assert.equal(source.includes('pendingVoiceSpeakRef.current = false;'), true);
    assert.equal(source.includes("last.role !== 'assistant'"), true);
    assert.equal(source.includes("last.id === 'welcome'"), true);
  });

  test('closing the panel stops both the microphone and the voice', () => {
    const source = code('components/AIAssistant/AiAssistantPanel.jsx');

    // A recogniser still running after the panel closes is a microphone
    // nobody is watching.
    assert.equal(source.includes('stopSpeaking();'), true);
  });

  test('the recogniser is asked for the currently selected language', () => {
    const source = code('components/AIAssistant/AiAssistantPanel.jsx');

    // And the SAME tag is used for synthesis, so a Tamil reply is read with a
    // Tamil voice rather than an English one reading Tamil text.
    assert.equal(source.includes('lang: chatLanguageBcp47(language)'), true);
  });

  // \u2500\u2500 the Redux slice \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  test('the slice holds the language and exposes a setter', () => {
    const source = code('redux/slices/aiChatSlice.js');

    assert.equal(source.includes("language: 'en'"), true);
    assert.equal(source.includes('languageSet:'), true);
    assert.equal(source.includes('normalizeChatLanguage(action.payload)'), true);
  });

  test('the slice never persists the language', () => {
    const source = code('redux/slices/aiChatSlice.js');

    assert.equal(source.includes('localStorage'), false);
    assert.equal(source.includes('sessionStorage'), false);
  });

  // \u2500\u2500 the wire \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  test('the client omits the language when it is English', () => {
    const source = code('services/aiService.js');

    // English is the base case and the server adds no rule for it, so sending
    // `en` would be a key that changes nothing. Omitting it keeps the wire
    // identical to 36.3.
    assert.equal(source.includes("wanted !== 'en'"), true);
    assert.equal(source.includes('payload.language = wanted'), true);
  });

  test('the client still sends no identity fields', () => {
    // 36.3's boundary must survive 36.5 untouched. A language field must not
    // become the camel's nose for a client-supplied tenant id.
    const source = code('services/aiService.js');

    for (const field of ['companyId', 'userId', 'user', 'feature']) {
      assert.equal(source.includes(field), false, `client sends ${field}`);
    }

    assert.equal(source.includes("'/ai/chatbot'"), true);
  });
});
