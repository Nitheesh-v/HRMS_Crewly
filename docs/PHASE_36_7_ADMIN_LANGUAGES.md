# PHASE 36.7 — Admin-configurable assistant languages

**Status:** complete. All gates green.

**One sentence:** an admin picks reply languages from a platform catalogue in
a new **AI Settings** page, and those languages open up in the assistant's
selector for every employee of that company — and for nobody else's.

---

## 1. What the owner asked for

> "make the language as option if admin adds that any language then the
> language would open" — and "make good ui and ux".

36.5 shipped five languages **hardcoded in two places**: the backend's
`AI_SUPPORTED_LANGUAGES` and the frontend's `CHAT_LANGUAGES`. An admin who
wanted a sixth had to change code and redeploy. This unit makes the list a
**tenant setting**.

Two scope decisions the owner settled before any code was written:

1. **Platform catalogue only — no free text.** An admin picks from a curated
   list. A free-text field would let a typo become a language the model cannot
   actually produce, and the admin would believe they had added it.
2. **A new AI Settings page** at `/app/settings/ai-settings`, `COMPANY_ADMIN`
   only, hosting the enable switch, the monthly quota, the context categories
   and the language manager.

---

## 2. The catalogue

Fourteen languages in `AI_LANGUAGE_CATALOGUE`
(`Backend/src/services/ai/aiConfig.js`), each a frozen record:

```js
{ code, label, native, hint, bcp47, rule }
```

| code | label | native | bcp47 |
|---|---|---|---|
| `en` | English | English | `en-IN` |
| `ta` | Tamil | தமிழ் | `ta-IN` |
| `tanglish` | Tanglish | Tanglish | `en-IN` |
| `hi` | Hindi | हिंदी | `hi-IN` |
| `te` | Telugu | తెలుగు | `te-IN` |
| `kn` | Kannada | ಕನ್ನಡ | `kn-IN` |
| `ml` | Malayalam | മലയാളം | `ml-IN` |
| `mr` | Marathi | मराठी | `mr-IN` |
| `gu` | Gujarati | ગુજરાતી | `gu-IN` |
| `pa` | Punjabi | ਪੰਜਾਬੀ | `pa-IN` |
| `bn` | Bengali | বাংলা | `bn-IN` |
| `or` | Odia | ଓଡ଼ିଆ | `or-IN` |
| `as` | Assamese | অসমীয়া | `as-IN` |
| `ur` | Urdu | اردو | `ur-IN` |

`native` is the name in the language itself, because that is what a person
scans for. `hint` is the script note shown under the selector so nobody picks
Tamil expecting Roman letters. `bcp47` feeds the browser's Web Speech APIs.
`rule` is the phrase the model is told.

**`tanglish` deliberately maps to `en-IN`.** Tanglish is Tamil written in
Latin letters, so asking a recogniser for Tamil script would mis-hear it. A
test pins this on its own, because it is the one deliberate exception and the
easiest thing to "fix" by mistake.

Derived from the catalogue, not hand-written beside it:
`AI_LANGUAGE_CODES`, `AI_LANGUAGE_LABELS`, `AI_LANGUAGE_TO_BCP47`.

### The two lists, and why the distinction matters

```
AI_LANGUAGE_CATALOGUE      14 codes — everything the platform knows
AI_TENANT_LANGUAGE_DEFAULT  5 codes — what an UNCONFIGURED tenant gets
AI_SUPPORTED_LANGUAGES     alias of the default set (kept so 36.5 imports work)
```

The **enum** on the model is the catalogue; the **default** is the five. If
the enum were the five, an admin could never add a language — which is the
exact bug this unit fixes.

---

## 3. English is mandatory

A tenant's language list must always contain English. Enforced at the
**model**, not only the UI:

* `AITenantConfig.js` carries a path validator refusing a list that is empty
  or lacks `en`;
* `updateConfigValidator` refuses it with a 400 naming the reason;
* the settings page refuses to send it.

**Why.** English is the one language the system prompt needs no rule for, and
the platform's fallback when a request carries no preference at all. A tenant
without it would have a selector promising languages the prompt cannot produce
for a default request — a UI that lies quietly. Three layers, because the
model is the one that cannot be bypassed.

---

## 4. Where the state lives

`AITenantConfig.languages` — `[String]`, enum = the catalogue, default = the
five. Keyed by `companyId` and nothing else. A client-supplied `companyId` is
still refused by `noIdentityOverride`.

`getTenantLanguages(companyId, deps)` reads it and **fails closed to the
default set**, never throwing. A language is a presentation preference;
refusing the whole assistant because a config read timed out would be the
wrong trade.

`toSnapshot` carries `languages`, and an empty or missing array becomes the
default set rather than `[]` — a row written before 36.7 has no such key, and
an empty list would render a selector with nothing in it.

`UPDATABLE_FIELDS` gained `languages`, so `PUT /ai/config` accepts it instead
of answering `Unsupported AI config field(s)`.

---

## 5. The API

| route | who | what |
|---|---|---|
| `GET /ai/languages` | any authenticated user | `{ languages, catalogue }` |
| `GET /ai/config` | `SETTINGS_MANAGE` | config + quota + `languageCatalogue` |
| `PUT /ai/config` | `SETTINGS_MANAGE` | save `enabled` / quota / categories / `languages` |
| `POST /ai/chatbot` | any authenticated user | `language` validated against the **tenant's** list |

**Why `/ai/languages` is separate.** The widget is open to every employee and
its selector must list what the admin enabled, so an employee has to be able
to ask. `/ai/config` answers that too, but it is behind `SETTINGS_MANAGE` and
carries the quota — an employee has no business reading either. The new route
returns presentation preferences and nothing else: no quota, no enabled flag,
no usage.

**The validator change that was the actual bug.** 36.5's chain was
`isIn(AI_SUPPORTED_LANGUAGES)`. With a tenant list in play that made an
admin-added language **unreachable**: the selector offered it and the request
came back 400. It is now:

```js
isIn(AI_LANGUAGE_CODES).bail().custom(async (value, { req }) => {
  const allowed = await getTenantLanguages(req.companyId);
  if (!allowed.includes(value)) throw new Error(...);
  return true;
});
```

The `isIn` stays first so a typo is reported as a typo, not as "not enabled for
your company" — two different problems, two different messages.

---

## 6. The prompt

`askHRAssistant` takes `languages` and resolves the rule through
`languageRuleLabel(language, allowed)`.

* **Rule 16**, conditional — omitted entirely for English, so an English turn
  stays byte-identical to a 36.3 turn. Follow-up remains rule 15 and
  unconditional.
* Omitting `languages` behaves like an unconfigured tenant, so a direct caller
  gets the 36.5 behaviour.
* A language that is on the platform but not enabled for this tenant falls
  back to the tenant's first entry. The validator already refuses it with a
  400; this is defence in depth, and failing a question over a cosmetic
  preference would be the wrong trade.

---

## 7. The UI

### AI Settings — `/app/settings/ai-settings`

`COMPANY_ADMIN` only. Four sections:

* **Reply languages** — a checkbox per catalogue record, showing the language
  in **both** its own script and English, plus the script hint. English is
  locked with an "Always on" label and a disabled checkbox. Bulk actions:
  *Enable all* and *Reset to default*.
* **Assistant enabled** — the tenant kill switch.
* **Context categories** — what the retriever may read.
* The month-to-date usage summary travels with the config read.

Saves only the keys that actually changed, then **re-reads** rather than
trusting the local draft — the server is the authority on what was stored, and
a second admin may have changed something between load and save.

### The assistant selector

Reads the tenant's list. `chatLanguagesFor(allowedCodes)` filters the
catalogue to those codes, in **catalogue order** rather than the order the
codes arrived, so the selector does not reshuffle between reloads.

Changing the language does **not** clear the transcript: the answers already
on screen were given in the previous language and are still true. The new
choice applies to the next answer.

### The frontend's own copy

`chatLanguages.js` still holds the catalogue, because plain Node can load a
`.js` file but not a `.jsx` one and a test needs to assert it without a
browser. At runtime the server sends the catalogue over `/ai/languages`, so
the local copy is the offline fallback for the first paint and for tests.

A test imports the backend module and compares **field by field** — codes,
labels, native names, hints and BCP-47 tags. It used to scrape the backend
file as text, which broke the moment a second export whose name appeared in a
doc comment came along: the slice started inside a comment and swallowed
unrelated codes. `aiConfig.js` has no imports and touches nothing at module
scope, so importing it is exact and cannot be fooled by a comment.

---

## 8. What did NOT change

* A language is a **presentation** preference. It never changes what a caller
  may read — the server scopes that from `req.companyId` and `req.user._id`
  before this value is looked at.
* No chat or transcript persistence. Nothing new in `AIUsageLog`.
* Zero new npm packages.
* 36.3–36.6 rules, rate limits, quotas and redaction untouched.
* The 36.6 usage route and its guard are untouched — 36.7 adds a route, it
  does not move one.

---

## 9. Localhost acceptance

Exact steps. Everything runs on `localhost`.

```powershell
# 1 — Backend, one terminal
cd C:\path\to\HRMS_Crewly\Backend
npm run dev

# 2 — Frontend, a SECOND terminal
cd C:\path\to\HRMS_Crewly\Frontend
npm run dev
```

Then in the browser, **signed in as a `COMPANY_ADMIN`**:

1. Open `/app/settings/ai-settings`. Four sections load, and **Reply
   languages** shows 14 checkboxes with exactly five ticked — English, Tamil,
   Tanglish, Hindi, Telugu.
2. Tick **Kannada**. The "enabled" counter goes to 6. Click **Save changes**.
   A green "AI settings saved." appears.
3. **Hard-reload** the page (`Ctrl+Shift+R`). Kannada is still ticked — it was
   stored, not just held in the form.
4. Untick Tamil. Save. Hard-reload. Tamil is gone.
5. Try to untick English. **You cannot** — the checkbox is disabled and
   labelled "Always on".
6. Open the assistant widget. The language dropdown lists **exactly** the
   languages you enabled, in catalogue order, with English first.
7. Pick Kannada and ask *"what is my leave balance?"*. The reply is in
   Kannada script. (If the tenant is disabled or the key is unset, you will
   get the honest `AI_UNAVAILABLE` message instead — that is 36.1 working.)
8. Switch back to English and ask again. The reply is English and the prompt
   cost is unchanged — English adds no language rule.

As an ordinary **employee** (not an admin):

9. `/app/settings/ai-settings` is **refused**. The route guard and the server
   both refuse; you never see another company's settings.
10. The assistant widget's dropdown shows the **same** list the admin
    configured. The employee did not need any permission to see which
    languages are on offer — only to change them.

Sign out and back in as a `COMPANY_ADMIN` of a **different** company:

11. Its language list is the **default five**, unchanged. The list is tenant
    state and there is no path by which one company's choice reaches another.

---

## 10. Gates

```
Backend   npm run test:all   3062 tests / 131 files / 0 fail   (was 3024 / 160 suites)
Frontend  npm test            153 tests /  26 suites / 0 fail   (was  111 /  19)
Frontend  npm run build       clean
Frontend  npm run lint        128 problems (baseline held)
```

New and changed suites:

| suite | tests | note |
|---|---|---|
| `aiTenantLanguages.test.js` | 35 | **new** — catalogue, defaults, tenant resolution, validators, source pins |
| `aiTenantConfig.test.js` | 49 | was 46 — the `languages` field, enum, and the English rule |
| `chatLanguages.test.js` | 21 | was 10 — the platform list, `chatLanguagesFor`, the import-based drift guard |
| `aiSettings.test.js` | 29 | **new** — slice behaviour, selector pins, page pins, route guard, service surface |
| `aiVoice.test.js` | 22 | was 20 — three 36.5 pins updated for the tenant list |

---

## 11. Known limitations

* **The catalogue is fixed.** Adding a language means editing
  `AI_LANGUAGE_CATALOGUE` and redeploying. That is the owner's decision — the
  alternative was free text, which produces selectors that lie.
* **No per-user language.** The list is per tenant. A person who wants
  Kannada at a company that disabled it has to ask their admin.
* **The settings page shows categories but does not edit them.** Editing is
  one field away in `updateAiConfig` and was left out of scope; the page
  renders what the tenant has rather than pretending to a control it does not
  wire.
* **`Frontend` lint stays at 128.** The new page carries one
  `set-state-in-effect`, suppressed at file level exactly as 8 other pages in
  this repo suppress the same unavoidable fetch-on-mount rule.

---

## 12. Pits hit, so they are not hit again

* **A pin that greps raw source matches the file's own documentation.** The
  first version of `aiSettings.test.js` asserted the panel contains no
  `localStorage` and failed — because the panel's header comment explains at
  length that the language is deliberately *not* stored there. Every code pin
  now goes through a comment-stripping helper, the same one `aiVoice.test.js`
  has used since 36.5.
* **An `await import()` inside a `describe` callback is illegal.** Hoist them.
* **A validator chain can signal refusal by THROWING, not by calling
  `next(error)`.** A promise wrapper that only watches `next` never sees the
  refusal, and every assertion about a 400 silently passes for the wrong
  reason.
* **A fake model must expose the method the code actually calls.**
  `loadFromMongo` uses `findOneAndUpdate`, not `findOne`; a `findOne`-only fake
  returns null and the caller falls back to the default set.
* **A source pin sliced to "the next export" can be empty.** The chatbot
  validator is the LAST export in `aiValidator.js`, so slicing to a name that
  appears *earlier* in the file produced an empty string.
* **Filtering by type is not filtering.** An empty string is a string, so a
  list of `['']` read as "one language enabled" and rendered a selector with a
  single nameless entry. Keep only codes that are actually on the platform.
* **A hand-copied Unicode string will be wrong.** The Telugu native name
  arrived as `ଲ` (Odia LA) instead of `ల` (Telugu LA) — visually near
  identical, wrong script. The frontend copy is now regenerated from the
  backend's own module, and a test compares them field by field.
* **A `builder` chain terminated by `;` cannot be extended.** Appending
  `.addCase(...)` after the semicolon is a syntax error.
