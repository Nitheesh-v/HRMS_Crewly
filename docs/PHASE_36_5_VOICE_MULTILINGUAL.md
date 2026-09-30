# PHASE 36.5 — VOICE ASSISTANT & MULTILINGUAL SUPPORT

**Status: SHIPPED on branch `arena/01a0e7a0-hrms-crewly` — pending owner
localhost verification.**

This is an EXTENSION unit. Phases 36.1–36.4 are closed and accepted and this
unit does not reopen any of them: the guard ladder, the error codes, the
`AIUsageLog` schema and the HR context retriever are all untouched.

---

## 0. What this unit is, in one paragraph

The HR assistant can now be **spoken to** and **spoken from**, and it can
**answer in five languages**. Both voice halves are the browser's own Web
Speech API — there is no new npm package, no API key, no vendor and no audio
that leaves the machine except through the browser's own speech service. The
language is a **presentation preference** and nothing more: it changes how an
answer is phrased and never what the caller is allowed to read.

---

## 1. The six deliverables

| # | Deliverable | Where |
| --- | --- | --- |
| A | The service accepts an optional `language` and injects rule 15 | `Backend/src/services/ai/hrChatbotService.js` |
| B | The validator accepts an optional `language` | `Backend/src/validators/ai/aiValidator.js` |
| C | Speech recognition hook | `Frontend/src/hooks/useSpeechRecognition.js` |
| D | Speech synthesis util | `Frontend/src/utils/speechSynthesis.js` |
| E | Language selector + Redux state | `AiAssistantPanel.jsx`, `aiChatSlice.js`, `chatLanguages.js`, `aiService.js` |
| F | Mic in the input bar, speaker on each reply | `ChatInputBar.jsx`, `ChatMessageBubble.jsx` |

The controller (`aiController.js`) forwards `language` from the body to the
service. It adds no logic of its own and keeps the three-section comment
convention.

---

## 2. The language enum — closed

```js
AI_SUPPORTED_LANGUAGES = ['en', 'ta', 'tanglish', 'hi', 'te']
AI_DEFAULT_LANGUAGE     = 'en'
```

BCP-47 tags for the browser speech APIs:

| Value | Label injected into the prompt | BCP-47 |
| --- | --- | --- |
| `en` | *(none — see §3)* | `en-IN` |
| `ta` | `Tamil (தமிழ் script)` | `ta-IN` |
| `tanglish` | `Tanglish (Tamil written in English/Roman letters, casual mix)` | `en-IN` |
| `hi` | `Hindi (हिंदी script or Hinglish as natural)` | `hi-IN` |
| `te` | `Telugu (తెలుగు script)` | `te-IN` |

**Why `tanglish` maps to `en-IN`.** Tanglish is Tamil written in Latin
letters, mixed casually with English — which is how a large part of this
workforce actually types. Asking a recogniser for Tamil script would
mis-hear it, so the browser is asked for Indian English and the model is told
to match the mix.

**Why the labels name the SCRIPT and not just the language.** "Reply in
Tamil" is ambiguous to a model that can produce either Tamil script or a
Roman transliteration, and the employee asked in one of them. Naming the
script removes the guess.

---

## 3. English is the base case and carries NO rule

This is the single most important design decision in the unit.

`SYSTEM_PROMPT_TEMPLATE` contains a `languageRule` slot, and
`buildSystemPrompt(retrievedContext, languageLabel)` fills it with either:

* the empty string, when the language is `en`; or
* rule 15, when it is anything else.

So an English turn sends **byte-identical** prompt text to what 36.3 sent.
A template that always contained the rule would spend tokens on every English
request telling the model to reply in English, and the owner measured a full
turn at ~556 tokens against an `AI_MAX_TOKENS` ceiling of 1024.

Rule 15, verbatim:

```
15. REPLY IN THE LANGUAGE THE EMPLOYEE CHOSE: <label>. Write your whole
answer in that language and that script, using the employee's own words for
their HR terms. Keep JSON field names, proper nouns (Crewly), and any code or
identifier exactly as they are. If the employee mixes two languages, match
the mix. Never answer in a language the employee did not choose, and never
translate an HR figure.
```

**Rule 15 is appended. Nothing above it moves.** The prompt had 14 rules and
now has 15; rule 8 (`"NONE" IS AN ANSWER`) and rule 14 (the relevant-answer
law) are unchanged, and a test asserts that everything English carries before
rule 15 is still present, in order, before rule 15 in Tamil.

---

## 4. Invalid or absent language → English, silently

The **service** normalizes silently:

```js
export const normalizeLanguage = (value) =>
  AI_SUPPORTED_LANGUAGES.includes(value) ? value : AI_DEFAULT_LANGUAGE;
```

`undefined`, `null`, `42`, `{}`, `[]`, `true` and `'fr'` all become `'en'`.
The question still gets answered.

The **validator** refuses an unsupported value with a 400:

```js
body('language')
  .optional({ nullable: true })
  .isIn([...AI_SUPPORTED_LANGUAGES])
```

Those two rules look contradictory and are not:

* Refusing at the edge stops the UI claiming Tamil while the model answers in
  English — the quiet lie this codebase refuses to ship.
* Normalizing in the service is the defence in depth for a caller that reaches
  the service directly (a test, a future internal caller). Failing a question
  over a cosmetic preference would be the wrong trade.

`{ nullable: true }` because JSON `null` is how a client says "no preference",
and refusing it would fail a whole question over cosmetics.

---

## 5. Language is a preference, NEVER an authority

The field is deliberately **not** in `chatbotIdentityOverride`. That list is
the set of fields a client must never supply because they decide
**authorization**. Language decides how an answer is phrased, never what the
caller may read.

A test asserts this by slicing the override block out of the validator source
and checking the word `language` does not appear in it.

`companyId` and `userId` still come from `req.companyId` and `req.user._id`
only, exactly as in 36.3.

---

## 6. Privacy

| Rule | How it is met |
| --- | --- |
| No audio persistence anywhere | Neither module references `MediaRecorder`, `Blob`, `FileReader`, `createObjectURL`, `FormData`, `indexedDB`, `localStorage` or `sessionStorage`. A test asserts each absence. |
| No server-side transcript storage | The transcript never reaches the server as a transcript. It becomes the `content` of a normal user message, which is redacted in `hrChatbotService` STEP 4 exactly like typed text, and nothing is persisted. |
| PII redaction still mandatory | Unchanged. A spoken bank account number is masked exactly like a typed one. |
| No network call of ours | Neither voice module imports `api.js` or calls `fetch`. A test asserts each absence. |
| Redux only, no `localStorage` | `aiChat.language` lives in Redux. Tests assert the panel and the slice never touch `localStorage` or `sessionStorage`. |
| Closing the panel stops the mic | `useEffect(() => () => { stopSpeaking(); }, [])` plus the hook's own `teardown` on unmount. A recogniser still running after the panel closes is a microphone nobody is watching. |

What leaves the machine is the browser's own speech service, which is a
browser feature the person opted into by pressing the microphone.

---

## 7. `sentViaVoice` and the one-shot auto-speak

The interaction rule, and why it is coded the way it is.

**Setting the flag.** `ChatInputBar` calls
`onSend(trimmed, { sentViaVoice: listening })`. The panel stores it on a
**ref**, not in Redux:

```js
pendingVoiceSpeakRef.current = meta?.sentViaVoice === true;
```

**Consuming it.** An effect watches `messages`. When the newest message is an
assistant reply and the latch is set, the latch is cleared **before** speaking
and the reply is read aloud:

```js
if (last.role !== 'assistant') return;
if (!pendingVoiceSpeakRef.current) return;

pendingVoiceSpeakRef.current = false;

if (last.id === 'welcome') return;

speakReply(last.id, last.content);
```

**Why a ref and not state.** A state flag would re-fire under React's
strict-mode double-invoke and speak the same reply twice. A ref is a one-shot
signal between two renders, which is exactly what this is.

**Why the flag is cleared before speaking.** So a re-render, a language change
or a scroll cannot speak it again.

**Stoppable.** The speaker button toggles. `speak()` cancels whatever was
already speaking, so a second click replaces the voice rather than queueing
behind it.

---

## 8. The voice modules

### `useSpeechRecognition.js`

Wraps `window.SpeechRecognition` / `window.webkitSpeechRecognition`.

```js
const voice = useSpeechRecognition({
  lang: chatLanguageBcp47(language),
  continuous: false,
  interimResults: true,
  onFinal: (text) => { /* append to draft and send */ },
});

// voice.supported  → whether to render the mic at all
// voice.listening  → whether it is live right now
// voice.interim    → the words heard so far
// voice.toggle()   → start or stop
```

`supported` and "can actually be constructed" are two different answers, and
both are checked. A browser that exposes the constructor but throws when it is
built (some Safari builds, some embedded webviews) would otherwise render a
button that does nothing.

Callbacks are held in refs, so a stale closure can never capture an old `lang`
or an old `onFinal`. That is also what lets a language change take effect on
the **next** start without tearing down the current session.

`continuous: false` — one utterance, then stop. A chat box is not a dictation
pad, and a recogniser that never ends is how a microphone stays open long
after the person finished talking.

### `speechSynthesis.js`

A module, not a hook, and that is deliberate: `window.speechSynthesis` has
**one queue per tab**, and two components each owning "the current utterance"
is how you get overlapping voices.

```js
speak(text, {
  lang: 'ta-IN',
  onStart: () => setSpeakingId(id),
  onEnd:   () => setSpeakingId((cur) => (cur === id ? '' : cur)),
});
```

`speak()` **always returns a handle**, so a caller never has to branch on
support just to avoid a crash.

`whenVoicesReady()` exists because Chrome and Safari populate `getVoices()`
asynchronously. Calling it before the first speak is what stops a Tamil reply
from falling back to an English voice for no reason other than a race.

A missing matching voice is **not** an error: the browser uses its default
voice for that language. The UI says "Read this answer aloud", never "read it
aloud in Tamil", because it cannot promise the second.

---

## 9. What the owner sees

* A **language selector** in a new row under the header. Five options, English
  first. Each option shows the language in English *and* in its own script,
  and a hint line names the script so nobody picks Tamil expecting Roman
  letters.
* A **mic button** in the input bar, only when the browser supports it. While
  listening it turns red, the icon becomes `MicOff`, and the live transcript
  replaces the "Enter to send" hint rather than adding to it.
* A **Listen / Stop button** on every assistant reply, only when the browser
  can synthesise.
* Changing the language does **not** clear the transcript. The answers
  already on screen were given in the previous language and are still true;
  the new choice applies to the next answer.

No emojis anywhere. The icon set is `lucide-react` only: `Mic`, `MicOff`,
`Volume2`, `VolumeX`, `Languages`.

---

## 10. Operational runbook

| Situation | What to do |
| --- | --- |
| The mic button is not there at all | The browser has no working `SpeechRecognition`. Firefox needs `media.webspeech.recognition.enable` in `about:config`; some embedded webviews never expose it. The typing chat is complete on its own. |
| The mic is there but nothing is heard | Check the OS microphone permission for the browser. `no-speech` and `audio-capture` are reported in the UI with a human message. |
| The reply is read with an English voice | No Tamil/Telugu/Hindi voice is **installed** on the machine. Install one in the OS speech settings. This is an OS voice problem, not a code problem. |
| The reply is read in the wrong language entirely | The selector and the synthesis tag are the same value, so this means the voice list had no match and the browser used its default. Same fix as above. |
| Tanglish is misheard | Expected. Tanglish STT accuracy is imperfect — it is Tamil in Latin letters, and no recogniser is trained for it well. The person can always type instead. |
| A spoken question came back in English | The selector was still on English. There is no language auto-detection anywhere in this product, by design. |
| The assistant answers in a language nobody selected | That would be a bug. The selector is the only input; check `state.aiChat.language` and the `language` key in the request body. |
| A `400 AI_REQUEST_INVALID` on chat | The `language` value was not in the closed set. The client only ever writes values from `CHAT_LANGUAGES`, so this means a hand-made request. |

---

## 11. Honest flags — read before signing this off

1. **Web Speech support is uneven.** Chrome and Edge are full. Safari is
   partial — no continuous mode, and it stops itself after a pause. Firefox
   needs `media.webspeech.recognition.enable` in `about:config`, so most
   Firefox users never see the mic button. The typing chat is unaffected in
   every case.

2. **Voice quality depends on the operating system, not on this code.** Tamil,
   Telugu and Hindi need a voice actually installed on the machine. Windows
   and Android usually have them; many macOS and Linux installs do not. When
   no voice matches, the browser still speaks — it just uses its default voice
   and the accent may be wrong.

3. **Tanglish STT accuracy is imperfect.** It is Tamil written in Latin
   letters, mixed with English, and no recogniser is trained for it well.
   Treat a misheard Tanglish question as expected behaviour, not a bug.

4. **The frontend voice features are NOT hermetically tested.** `node:test`
   has no DOM, no microphone and no installed system voice. A fake that
   returned a transcript would only be testing the fake. `Frontend/test/
   aiVoice.test.js` pins the **wiring** — the modules exist, the icons are
   imported, the privacy rules are present in the source, and
   `sentViaVoice` plus the auto-speak latch are actually coded. That is the
   honest limit of what can be automated.

   **The owner must verify interactively in Chrome.** See §12.

5. **There is no server-side language auto-detection** and no backend
   auto-translation. Both were explicitly out of scope. The selector is the
   only input.

6. **Safari needs a user gesture before the first utterance.** Every entry
   point into `speak()` is therefore a click or a send the person initiated.
   The auto-speak path is safe because it is triggered by a send.

---

## 12. Localhost verification steps for the owner

PowerShell, copy-paste. Run from the repo root.

### Backend

```powershell
cd Backend
npm run dev
```

Leave it running.

### Frontend (a second PowerShell window)

```powershell
cd Frontend
npm run dev
```

Open the printed `http://localhost:5173`, log in, and open the floating HR
assistant (the Bot button, bottom-right).

**Use Chrome or Edge.** Firefox will not show the mic without a flag.

### The five checks

**1. The language selector is there and works**

Click the selector under the header. Pick **Tamil — தமிழ்**. Ask:

```
What is my leave balance?
```

The reply should arrive in Tamil script. Pick **Tanglish** and ask again — the
reply should be Tamil in English letters, casually mixed. Repeat for **Hindi**
and **Telugu**.

**2. English is unchanged**

Set the selector back to **English** and ask the same question. The reply
should be exactly as it was before this unit — no language instruction was
added to the prompt.

**3. The microphone fills the box and sends**

Click the mic. Allow the microphone permission if asked. Say:

```
What are my shift timings
```

You should see the words appear in the box as you speak, and the question
should send itself when you stop. The reply should be **read aloud
automatically** — that is the `sentViaVoice` rule.

**4. The speaker button works and stops**

Click **Listen** on any reply. It should start reading and the button should
change to **Stop**. Click it again and it should stop immediately.

**5. Typing does not trigger auto-speak**

Type a question by hand and send it. The reply should arrive **silently**.
Auto-speak is only for mic-composed questions.

### If the mic is missing

Firefox: open `about:config`, set `media.webspeech.recognition.enable` to
`true`, restart the browser. Or just use Chrome.

### Hard reload

If the panel looks stale after a `git pull`, hard-reload:
**Ctrl + Shift + R**.

---

## 13. Files changed

**Added**

```
Frontend/src/hooks/useSpeechRecognition.js
Frontend/src/utils/speechSynthesis.js
Frontend/src/components/AIAssistant/chatLanguages.js
Frontend/test/chatLanguages.test.js
Frontend/test/aiVoice.test.js
docs/PHASE_36_5_VOICE_MULTILINGUAL.md
```

**Modified**

```
Backend/src/services/ai/aiConfig.js
Backend/src/services/ai/hrChatbotService.js
Backend/src/validators/ai/aiValidator.js
Backend/src/controllers/aiController.js
Backend/test/hrChatbotService.test.js
Backend/test/phase36Closeout.test.js
Frontend/src/components/AIAssistant/AiAssistantPanel.jsx
Frontend/src/components/AIAssistant/ChatInputBar.jsx
Frontend/src/components/AIAssistant/ChatMessageBubble.jsx
Frontend/src/redux/slices/aiChatSlice.js
Frontend/src/services/aiService.js
docs/PHASE_36_HR_CHATBOT.md
docs/PHASE_36_MEMORY_CAPSULE.md
```

**Deleted** — nothing.

**ZERO new npm packages.** No change to `package.json` in either half.

---

## 14. Tests

Backend:

```
npm run test:ai-chatbot        → 58 tests / 0 fail   (was 49)
npm run test:phase36-closeout  → 49 tests / 0 fail   (was 44)
npm run test:ai-foundation     → 68 tests / 0 fail
npm run test:ai-tenant-config  → 45 tests / 0 fail
npm run test:ai-context        → 47 tests / 0 fail
npm run test:ai-own-records    → 39 tests / 0 fail
npm run test:all               → 2999 tests / 156 suites / 0 fail   (was 2985 / 155)
```

Frontend:

```
npm test     → 61 tests / 7 suites / 0 fail   (was 31 / 5)
npm run build → clean
npm run lint  → 127 problems, exactly the pre-existing baseline
```

### What the new tests pin

**Backend, `hrChatbotService.test.js` (9 new)**

1. English carries NO language rule, and still carries rules 1–14 and the
   context.
2. An absent language also carries no rule.
3. Each supported language injects its own label, read from the config rather
   than re-typed.
4. Tanglish is described as Latin letters, not Tamil script.
5. An unsupported language falls back to English silently.
6. A non-string language (`null`, `42`, `{}`, `[]`, `true`) also normalizes.
7. Rule 15 never weakens a rule 1–14 guarantee.
8. The language changes the prompt and **nothing else** in the payload —
   same roles, same history, still exactly one system message.
9. The vendor call itself is unchanged by the language.

**Backend, `phase36Closeout.test.js` (5 new)**

1. An unsupported language is refused with a 400.
2. An absent language is accepted.
3. A `null` language is accepted as no preference.
4. Every supported language is accepted, driven from the config.
5. `language` is not in the identity-override list — the
   "preference, never authority" rule.

**Frontend, `chatLanguages.test.js` (10 new)**

The closed set, the default, the BCP-47 tags, the Tanglish mapping, silent
normalization, the real native script names, and the **drift guard** that
reads `Backend/src/services/ai/aiConfig.js` and proves the two lists agree.

**Frontend, `aiVoice.test.js` (20 new)**

Wiring pins only, and the file says so in its own header. Includes: no banned
speech package in `package.json`, no `fetch`/`api.js`/XHR in either voice
module, no `MediaRecorder`/`Blob`/`localStorage` anywhere in them, the mic is
guarded on `voiceSupported`, the speaker is assistant-only and toggles, the
auto-speak latch is a ref cleared before speaking, closing the panel stops the
voice, and the client still sends no identity fields.

The suite was mutation-checked: breaking `sentViaVoice` in `ChatInputBar`
fails exactly one test, and restoring it passes again.

---

## 15. What this unit deliberately did NOT do

* No server-side language detection.
* No backend auto-translation.
* No Whisper, Google Cloud Speech, Azure Speech, ElevenLabs, or any
  `react-speech-*` package.
* No new npm packages at all, in either half.
* No change to the 36.1–36.4 guard ladder, error codes, `AIUsageLog` schema or
  the HR context retriever.
* No audio persistence, anywhere.
* No `localStorage` for chat state.
* No `/metrics`, no APM vendor, no chaos toggles, no Docker.
