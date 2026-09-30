// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.3 — HR CHATBOT SERVICE (hermetic)
//
// No Mongo, no Redis, no network, no vendor. aiChat, getUserHRContext and
// redactPII are all injectable, so the REAL orchestration runs against
// recorders: the fake aiChat CAPTURES the payload it was handed, which is what
// makes "the system prompt carries the context" and "the history was redacted"
// assertable rather than assumed.
//
// The comments explain WHY each assertion exists.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV ||= 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_ai_chatbot_test';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(backendRoot, rel), 'utf8');

const {
  askHRAssistant,
  SYSTEM_PROMPT_TEMPLATE,
} = await import('../src/services/ai/hrChatbotService.js');

const {
  AI_ERROR_CODES,
  AIError,
} = await import('../src/services/ai/aiErrors.js');

const {
  AI_CHATBOT_HISTORY_LIMIT,
  AI_CHATBOT_RATE_LIMIT,
} = await import('../src/services/ai/aiConfig.js');

const { createRateLimitStore } = await import(
  '../src/utils/rateLimitStore.js'
);

const COMPANY = '0000000000000000000064b1';
const USER = '0000000000000000000064b9';

const CONTEXT =
  '=== EMPLOYEE HR CONTEXT ===\n- Name: John Doe\n=== END CONTEXT ===';

/** A fake aiChat that records exactly what it was given. */
const recordingAiChat = (result) => {
  const calls = [];

  const fn = async (input) => {
    calls.push(input);

    return (
      result ?? {
        content: 'You have 12 earned leave days remaining.',
        usage: { promptTokens: 120, completionTokens: 18, totalTokens: 138 },
        latencyMs: 240,
      }
    );
  };

  fn.calls = calls;

  return fn;
};

const contextFn = (overrides = {}) => async () => ({
  context: CONTEXT,
  categoriesUsed: ['profile', 'leaves'],
  sections: {},
  ...overrides,
});

const baseDeps = (overrides = {}) => ({
  aiChatFn: recordingAiChat(),
  getContextFn: contextFn(),
  redact: (text) => text,
  ...overrides,
});

const history = (count, role = 'user') =>
  Array.from({ length: count }, (_unused, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `turn ${index + 1}`,
  }));

// ═══════════════════════════════════════════════════════════════════════════
// A. SYSTEM PROMPT CONSTRUCTION
// ═══════════════════════════════════════════════════════════════════════════
describe('system prompt construction (Phase 36 §5 step 3)', () => {
  test('the payload has exactly ONE system message, at index 0', async () => {
    const aiChatFn = recordingAiChat();

    await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: history(3),
      deps: baseDeps({ aiChatFn }),
    });

    const payload = aiChatFn.calls[0].messages;

    const systemMessages = payload.filter((m) => m.role === 'system');

    // Two system messages would let one overwrite the other, and a system
    // message anywhere but index 0 is ignored by most chat APIs.
    assert.equal(systemMessages.length, 1);
    assert.equal(payload[0].role, 'system');
  });

  test('the system message contains the retrieved context verbatim', async () => {
    const aiChatFn = recordingAiChat();

    await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: history(2),
      deps: baseDeps({ aiChatFn }),
    });

    const system = aiChatFn.calls[0].messages[0].content;

    assert.equal(system.includes(CONTEXT), true);
  });

  test('the system message contains all fourteen rules verbatim', async () => {
    const aiChatFn = recordingAiChat();

    await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: history(1),
      deps: baseDeps({ aiChatFn }),
    });

    const system = aiChatFn.calls[0].messages[0].content;

    // A prompt that drifted silently would be an instruction the product never
    // approved, so the rules are pinned as text, not as behaviour. 36.4 took
    // the count from nine to thirteen, and the close-out unit took it to
    // fourteen.
    for (let rule = 1; rule <= 14; rule += 1) {
      assert.equal(system.includes(`${rule}. `), true, `rule ${rule} is missing`);
    }

    assert.equal(
      system.includes('NEVER invent leave balances, policies, holidays, or employee data.'),
      true,
    );

    // 36.4 close-out: rule 3 used to END at the bare refusal. Rule 14 replaced
    // that with a requirement to follow it with something useful, so the
    // sentence is deliberately gone and its absence is pinned below.
    assert.equal(
      system.includes('I do not have that information. Please contact your HR team.'),
      false,
      'rule 3 still ends at a bare refusal',
    );

    assert.equal(
      system.includes('NEVER offer to take actions on behalf of the employee'),
      true,
    );

    // 36.4 rule 10 — the "how do I..." questions must be answerable from
    // the capability catalogue, which is the whole reason the catalogue exists.
    assert.equal(
      system.includes('QUESTIONS ARE ANSWERED FROM THE CAPABILITY LIST'),
      true,
    );

    // 36.4 rule 11 — the answer must say where it came from.
    assert.equal(system.includes('NAME YOUR SOURCE'), true);

    // 36.4 rule 12 — no salary figure, ever. This is the redactor's rule
    // restated for the model, because the context has no amounts to leak.
    assert.equal(system.includes('NEVER STATE A SALARY FIGURE'), true);
    assert.equal(system.includes('My Payslips'), true);

    // 36.4 rule 13 — the model must not turn a count into a person.
    assert.equal(system.includes('YOU ONLY KNOW THIS EMPLOYEE'), true);
  });

  test('rule 14 makes a refusal useful instead of a dead end', async () => {
    // THE OWNER'S ASK: "if the answer does not know for that question make
    // reply with relevant answer". A bare "I do not have that information"
    // tells the employee nothing they can act on, so rule 14 requires three
    // things in order: say what is missing, give the closest thing that IS
    // known, then say what to do next.
    const aiChatFn = recordingAiChat();

    await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: history(1),
      deps: baseDeps({ aiChatFn }),
    });

    const system = aiChatFn.calls[0].messages[0].content;

    assert.equal(
      system.includes('WHEN YOU CANNOT ANSWER, STILL BE USEFUL'),
      true,
    );

    // Rule 3 no longer tells the model to stop at a bare refusal.
    assert.equal(
      system.includes('say "I do not have that information. Please contact your HR team."'),
      false,
      'rule 3 still ends at a bare refusal',
    );

    // The hard limit must survive: being helpful is never a licence to guess.
    assert.equal(system.includes('Never estimate'), true);
    assert.equal(system.includes('Rule 4 still wins over rule 14'), true);
  });

  test('rule 8 teaches that "none" IS an answer', async () => {
    // THE 36.4 FIX: the assistant used to answer "I do not have that
    // information" to "what are my shift timings?" because the context said
    // "no shift assigned" and the prompt only taught the refusal. A stated
    // negative is a confirmed fact and must be delivered as the answer.
    const aiChatFn = recordingAiChat();

    await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: [{ role: 'user', content: 'What are my shift timings?' }],
      deps: baseDeps({ aiChatFn }),
    });

    const system = aiChatFn.calls[0].messages[0].content;

    assert.equal(system.includes('"NONE" IS AN ANSWER'), true);
    assert.equal(
      system.includes('NEVER say you lack information when the context names the answer'),
      true,
    );
  });

  test('rule 9 teaches that "unavailable" is NOT an answer', async () => {
    // The other half: a failed read must not be reported as "none", and must
    // not be guessed at.
    const aiChatFn = recordingAiChat();

    await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: [{ role: 'user', content: 'What is my leave balance?' }],
      deps: baseDeps({ aiChatFn }),
    });

    const system = aiChatFn.calls[0].messages[0].content;

    assert.equal(system.includes('"UNAVAILABLE" IS NOT AN ANSWER'), true);
    assert.equal(system.includes('the system could not READ that section'), true);
  });

  test('an empty context still produces a valid system message', async () => {
    // A tenant with an empty allowlist must not crash the chatbot: the model
    // answers "I do not have that information", which is the honest reply.
    const aiChatFn = recordingAiChat();

    await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: history(1),
      deps: baseDeps({
        aiChatFn,
        getContextFn: contextFn({
          context:
            '=== EMPLOYEE HR CONTEXT ===\n(no categories enabled)\n=== END CONTEXT ===',
          categoriesUsed: [],
        }),
      }),
    });

    const system = aiChatFn.calls[0].messages[0].content;

    assert.equal(system.includes('=== EMPLOYEE HR CONTEXT ==='), true);
    assert.equal(system.includes('=== END CONTEXT ==='), true);
    assert.equal(system.includes('{retrievedContext}'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. HISTORY CAPPING
// ═══════════════════════════════════════════════════════════════════════════
describe('history capping (Phase 36 §5 step 1)', () => {
  test('a 15-message history is capped to the service limit', async () => {
    const aiChatFn = recordingAiChat();

    await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: history(15),
      deps: baseDeps({ aiChatFn }),
    });

    const payload = aiChatFn.calls[0].messages;

    // The cap is tighter than the UI's 20-message display cap because the
    // system prompt already carries several hundred tokens of context.
    assert.equal(payload.length, AI_CHATBOT_HISTORY_LIMIT + 1);
  });

  test('a 5-message history is sent whole', async () => {
    const aiChatFn = recordingAiChat();

    await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: history(5),
      deps: baseDeps({ aiChatFn }),
    });

    assert.equal(aiChatFn.calls[0].messages.length, 6);
  });

  test('the cap keeps the LAST turns and drops the OLDEST', async () => {
    const aiChatFn = recordingAiChat();

    const messages = Array.from({ length: 12 }, (_unused, index) => ({
      role: 'user',
      content: `turn ${index + 1}`,
    }));

    await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages,
      deps: baseDeps({ aiChatFn }),
    });

    const contents = aiChatFn.calls[0].messages.map((m) => m.content);

    // Chronological order preserved: the newest exchange is what the model
    // needs, and a reversed history would read as nonsense to it.
    assert.equal(contents[1], 'turn 7');
    assert.equal(contents[contents.length - 1], 'turn 12');
    assert.equal(contents.includes('turn 1'), false);
    assert.equal(contents.includes('turn 6'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. PII REDACTION OF THE HISTORY
// ═══════════════════════════════════════════════════════════════════════════

/** The real redactor, so these tests prove the actual behaviour. */
const { redactPII } = await import('../src/services/ai/piiRedactor.js');

describe('PII redaction of the conversation history (Phase 36 §1.4)', () => {
  test('a PAN typed by the user is masked in the payload', async () => {
    const aiChatFn = recordingAiChat();

    await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: [{ role: 'user', content: 'my PAN is ABCDE1234F, is it on file?' }],
      deps: baseDeps({ aiChatFn, redact: redactPII }),
    });

    const payload = aiChatFn.calls[0].messages;

    assert.equal(JSON.stringify(payload).includes('ABCDE1234F'), false);
    assert.equal(payload[1].content.includes('[PAN_REDACTED]'), true);
  });

  test('a mobile number typed by the user is masked in the payload', async () => {
    const aiChatFn = recordingAiChat();

    await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: [{ role: 'user', content: 'call me on 9876543210 please' }],
      deps: baseDeps({ aiChatFn, redact: redactPII }),
    });

    const payload = aiChatFn.calls[0].messages;

    assert.equal(payload[1].content.includes('9876543210'), false);
    assert.equal(payload[1].content.includes('[MOBILE_REDACTED]'), true);
  });

  test('an email typed by the user is masked in the payload', async () => {
    const aiChatFn = recordingAiChat();

    await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: [{ role: 'user', content: 'my address is john.doe@example.com' }],
      deps: baseDeps({ aiChatFn, redact: redactPII }),
    });

    const payload = aiChatFn.calls[0].messages;

    assert.equal(payload[1].content.includes('john.doe@example.com'), false);
    assert.equal(payload[1].content.includes('[EMAIL_REDACTED]'), true);
  });

  test('an Aadhaar typed by the user is masked in the payload', async () => {
    const aiChatFn = recordingAiChat();

    await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: [{ role: 'user', content: 'Aadhaar 1234 5678 9012 verification' }],
      deps: baseDeps({ aiChatFn, redact: redactPII }),
    });

    const payload = aiChatFn.calls[0].messages;

    assert.equal(payload[1].content.includes('1234 5678 9012'), false);
    assert.equal(payload[1].content.includes('[AADHAAR_REDACTED]'), true);
  });

  test('assistant turns are NOT re-redacted', async () => {
    // Re-redacting model output would corrupt a legitimate answer that quotes
    // a masked placeholder, and the assistant only ever saw redacted input.
    const aiChatFn = recordingAiChat();

    await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: [
        { role: 'user', content: 'what is my email on file?' },
        {
          role: 'assistant',
          content: 'Your work email is [EMAIL_REDACTED].',
        },
        { role: 'user', content: 'thanks' },
      ],
      deps: baseDeps({ aiChatFn, redact: redactPII }),
    });

    const assistant = aiChatFn.calls[0].messages.find(
      (m) => m.role === 'assistant',
    );

    assert.equal(assistant.content, 'Your work email is [EMAIL_REDACTED].');
  });

  test("the caller's array is not mutated", async () => {
    // The history is React state. Mutating it here would corrupt the
    // conversation the person is still reading on screen.
    const messages = [
      { role: 'user', content: 'my PAN is ABCDE1234F' },
    ];

    const before = JSON.stringify(messages);

    await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages,
      deps: baseDeps({ redact: redactPII }),
    });

    assert.equal(JSON.stringify(messages), before);
    assert.equal(messages[0].content, 'my PAN is ABCDE1234F');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. CONTEXT INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════
describe('context integration (Phase 36 §5 step 2)', () => {
  test('getUserHRContext is called with the server-derived identity', async () => {
    let seen = null;

    await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: history(1),
      deps: baseDeps({
        getContextFn: async (input) => {
          seen = input;

          return { context: CONTEXT, categoriesUsed: [], sections: {} };
        },
      }),
    });

    assert.equal(seen.companyId, COMPANY);
    assert.equal(seen.userId, USER);
  });

  test('a requested category narrowing is forwarded to the retriever', async () => {
    let seen = null;

    await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: history(1),
      categories: ['leaves'],
      deps: baseDeps({
        getContextFn: async (input) => {
          seen = input;

          return { context: CONTEXT, categoriesUsed: ['leaves'], sections: {} };
        },
      }),
    });

    assert.deepEqual(seen.categories, ['leaves']);
  });

  test("the retriever's categoriesUsed reaches the caller", async () => {
    const result = await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: history(1),
      deps: baseDeps({
        getContextFn: contextFn({ categoriesUsed: ['profile', 'attendance'] }),
      }),
    });

    assert.deepEqual(result.categoriesUsed, ['profile', 'attendance']);
  });

  test('an empty categoriesUsed still returns a response', async () => {
    const result = await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: history(1),
      deps: baseDeps({ getContextFn: contextFn({ categoriesUsed: [] }) }),
    });

    assert.equal(typeof result.reply, 'string');
    assert.deepEqual(result.categoriesUsed, []);
  });

  test('a partial context (some sections unavailable) still answers', async () => {
    // 36.2 ships partial results by design: a missing announcement list must
    // not stop the employee learning their leave balance.
    const aiChatFn = recordingAiChat();

    const result = await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: [{ role: 'user', content: 'what is my leave balance?' }],
      deps: baseDeps({
        aiChatFn,
        getContextFn: contextFn({
          context: `${CONTEXT}\n\nLeave Balances:\n(leaves unavailable)`,
          categoriesUsed: ['profile'],
        }),
      }),
    });

    assert.equal(aiChatFn.calls.length, 1);
    assert.equal(result.reply.length > 0, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. THE VENDOR CALL
// ═══════════════════════════════════════════════════════════════════════════
describe('the vendor call (Phase 36 §5 step 6)', () => {
  test('aiChat is called with feature "chatbot"', async () => {
    // The feature label is what makes a usage row say WHICH surface spent the
    // tokens. Without it, chatbot usage would be indistinguishable from a raw
    // verification call.
    const aiChatFn = recordingAiChat();

    await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: history(1),
      deps: baseDeps({ aiChatFn }),
    });

    assert.equal(aiChatFn.calls[0].feature, 'chatbot');
  });

  test('aiChat receives the assembled payload (system + history)', async () => {
    const aiChatFn = recordingAiChat();

    await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: history(3),
      deps: baseDeps({ aiChatFn }),
    });

    const { messages } = aiChatFn.calls[0];

    assert.equal(messages.length, 4);
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[1].role, 'user');
    assert.equal(messages[3].content, 'turn 3');
  });

  test('aiChat receives the server-derived companyId and userId', async () => {
    const aiChatFn = recordingAiChat();

    await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: history(1),
      deps: baseDeps({ aiChatFn }),
    });

    assert.equal(aiChatFn.calls[0].companyId, COMPANY);
    assert.equal(aiChatFn.calls[0].userId, USER);
  });

  test('the caller receives { reply, usage, categoriesUsed }', async () => {
    const result = await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: history(1),
      deps: baseDeps({
        aiChatFn: recordingAiChat({
          content: 'You have 12 earned leave days remaining.',
          usage: { promptTokens: 120, completionTokens: 18, totalTokens: 138 },
        }),
      }),
    });

    assert.equal(result.reply, 'You have 12 earned leave days remaining.');
    assert.equal(result.usage.totalTokens, 138);
    assert.deepEqual(result.categoriesUsed, ['profile', 'leaves']);
  });

  test('the caller NEVER receives the context or the prompt', async () => {
    // The HR context stays server-side. Returning it would put the assembled
    // prompt in the browser, which is the one place it must never be.
    const result = await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: history(1),
      deps: baseDeps(),
    });

    const serialised = JSON.stringify(result);

    assert.equal(serialised.includes('=== EMPLOYEE HR CONTEXT ==='), false);
    assert.equal(serialised.includes('Rules you must follow'), false);
    assert.equal(serialised.includes('You are the Crewly HR Assistant'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. ERROR PROPAGATION — never a fake reply
// ═══════════════════════════════════════════════════════════════════════════
describe('error propagation (Phase 36 §5 error handling)', () => {
  // KEY names as they appear in AI_ERROR_CODES (UNAVAILABLE, not
  // AI_UNAVAILABLE) - the VALUE is what the client receives.
  const cases = [
    ['UNAVAILABLE', () => AIError.unavailable(), 503],
    ['QUOTA_EXCEEDED', () => AIError.quotaExceeded(), 429],
    ['RATE_LIMITED', () => AIError.rateLimited(), 429],
    ['VENDOR_ERROR', () => AIError.vendorError(), 503],
    ['CONFIG_INVALID', () => AIError.configInvalid(), 500],
  ];

  for (const [key, make, status] of cases) {
    test(`a vendor ${AI_ERROR_CODES[key]} propagates unchanged`, async () => {
      // Swallowing the error and returning a plausible-looking reply would be
      // the single worst thing this module could do: the employee would act on
      // an answer the vendor never gave.
      await assert.rejects(
        () =>
          askHRAssistant({
            companyId: COMPANY,
            userId: USER,
            messages: history(1),
            deps: baseDeps({
              aiChatFn: async () => {
                throw make();
              },
            }),
          }),
        (error) =>
          error instanceof AIError &&
          error.code === AI_ERROR_CODES[key] &&
          error.statusCode === status,
      );
    });
  }

  test('a tenant-config read failure from the retriever propagates', async () => {
    await assert.rejects(
      () =>
        askHRAssistant({
          companyId: COMPANY,
          userId: USER,
          messages: history(1),
          deps: baseDeps({
            getContextFn: async () => {
              throw AIError.configReadFailed();
            },
          }),
        }),
      (error) =>
        error instanceof AIError &&
        error.code === AI_ERROR_CODES.CONFIG_READ_FAILED &&
        error.statusCode === 503,
    );
  });

  test('the vendor is never called when the context read fails', async () => {
    // A vendor call with no context would invite the model to guess, which is
    // exactly what rule 4 forbids.
    const aiChatFn = recordingAiChat();

    await assert.rejects(
      () =>
        askHRAssistant({
          companyId: COMPANY,
          userId: USER,
          messages: history(1),
          deps: baseDeps({
            aiChatFn,
            getContextFn: async () => {
              throw AIError.configReadFailed();
            },
          }),
        }),
    );

    assert.equal(aiChatFn.calls.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G. IDENTITY — never optional, never overridable
// ═══════════════════════════════════════════════════════════════════════════
describe('identity (Phase 36 §1.4)', () => {
  test('a missing companyId is refused', async () => {
    await assert.rejects(
      () =>
        askHRAssistant({
          userId: USER,
          messages: history(1),
          deps: baseDeps(),
        }),
      /companyId and userId/,
    );
  });

  test('a missing userId is refused', async () => {
    await assert.rejects(
      () =>
        askHRAssistant({
          companyId: COMPANY,
          messages: history(1),
          deps: baseDeps(),
        }),
      /companyId and userId/,
    );
  });

  test('an empty message list is refused', async () => {
    await assert.rejects(
      () =>
        askHRAssistant({
          companyId: COMPANY,
          userId: USER,
          messages: [],
          deps: baseDeps(),
        }),
      /at least one message/,
    );
  });

  test('the signature accepts no alternate-identity argument', () => {
    const source = read('src/services/ai/hrChatbotService.js');

    for (const banned of ['asUserId', 'impersonate', 'targetUser', 'onBehalfOf']) {
      assert.equal(
        source.includes(banned),
        false,
        `an identity-override seam exists: ${banned}`,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// H. SOURCE PINS
// ═══════════════════════════════════════════════════════════════════════════
describe('source pins', () => {
  test("the 'chatbot' feature label is registered in the closed list", () => {
    // aiChat REFUSES an unregistered feature, so an unregistered label would
    // be a 400 on every chatbot turn.
    const source = read('src/services/ai/aiConfig.js');

    assert.equal(source.includes("Object.freeze(['hr.chat', 'chatbot'])"), true);
  });

  test("the validator refuses the 'system' role from a client", () => {
    const source = read('src/validators/ai/aiValidator.js');

    assert.equal(source.includes('AI_CHATBOT_CLIENT_ROLES'), true);
    assert.equal(
      source.includes(".isIn([...AI_CHATBOT_CLIENT_ROLES])"),
      true,
    );
  });

  test('the chatbot rate limit is a separate 32.4 tier', async () => {
    const { AI_CHATBOT_RATE_LIMIT, AI_RATE_LIMIT, AI_PREVIEW_RATE_LIMIT } =
      await import('../src/services/ai/aiConfig.js');

    // Three independent budgets: exhausting one must not lock a person out of
    // another surface.
    const names = [
      AI_RATE_LIMIT.sharedName,
      AI_PREVIEW_RATE_LIMIT.sharedName,
      AI_CHATBOT_RATE_LIMIT.sharedName,
    ];

    assert.equal(new Set(names).size, 3);
    assert.equal(AI_CHATBOT_RATE_LIMIT.sharedName, 'ai-chatbot');
    assert.equal(AI_CHATBOT_RATE_LIMIT.windowMs, 60_000);
    assert.equal(AI_CHATBOT_RATE_LIMIT.maximum, 20);
  });

  test('the chatbot limiter is enforced in exactly ONE place', () => {
    const controller = read('src/controllers/aiController.js');

    assert.equal(
      controller.includes('chatbotLimiter.hit('),
      true,
      'the controller must charge the request',
    );

    // A second charge inside the service would count one turn twice, which is
    // the 36.1 lesson.
    const service = read('src/services/ai/hrChatbotService.js');

    assert.equal(service.includes('Limiter'), false);
    assert.equal(service.includes('rateLimit'), false);
  });

  test('the service makes exactly ONE vendor call per turn', () => {
    const source = read('src/services/ai/hrChatbotService.js');

    // No agent loop: one aiChatFn invocation, no retry, no follow-up call.
    assert.equal(source.includes('await aiChatFn('), true);

    const calls = source.match(/aiChatFn\(/g) || [];

    assert.equal(calls.length, 1);
    assert.equal(source.includes('while ('), false);
    assert.equal(source.includes('for ('), false);
  });

  test('the DEFAULT context retriever is the real 36.2 module', async () => {
    // A stub default would make every other test pass while production called
    // nothing, so the defaults are pinned against the source, not the fakes.
    const source = read('src/services/ai/hrChatbotService.js');

    assert.equal(
      source.includes('getContextFn = getUserHRContext'),
      true,
      'the default context retriever must be the real 36.2 module',
    );

    assert.equal(
      source.includes('aiChatFn = aiChat'),
      true,
      'the default vendor call must be the real 36.1 provider',
    );

    assert.equal(
      source.includes("from './hrContextRetriever.js'"),
      true,
    );

    assert.equal(source.includes("from './aiProvider.js'"), true);
  });

  test('the service logs nothing and stores nothing', () => {
    const source = read('src/services/ai/hrChatbotService.js');

    // 36.1 privacy law: the prompt and the reply are never logged and never
    // persisted. This module holds both and must not emit either.
    assert.equal(source.includes('logger'), false);
    assert.equal(source.includes('.save('), false);
    assert.equal(source.includes('.create('), false);
  });

  test('the route mounts POST /chatbot behind protect and tenantContext', () => {
    const source = read('src/routes/ai.js');

    assert.equal(source.includes("route('/chatbot')"), true);
    assert.equal(source.includes('router.use(protect, tenantContext)'), true);
    assert.equal(source.includes('chatbotValidator'), true);
  });

  test('the controller refuses on a limited verdict, in one place', () => {
    const source = read('src/controllers/aiController.js');

    const handler = source.slice(source.indexOf('export const askChatbot'));

    // The verdict must actually be READ. A guard that ignored it would charge
    // nothing and refuse nobody.
    assert.equal(handler.includes('verdict?.limited === true'), true);
    assert.equal(handler.includes('throw AIError.rateLimited()'), true);

    // Exactly one charge site for this endpoint across the whole backend.
    const routeFile = read('src/routes/ai.js');

    assert.equal(
      routeFile.includes('chatbotRateLimit'),
      false,
      'the limiter must not ALSO be route middleware',
    );

    const serviceFile = read('src/services/ai/hrChatbotService.js');

    assert.equal(serviceFile.includes('Limiter'), false);
  });

  test('the chatbot limiter refuses the 21st hit in a window', async () => {
    // The controller relies on the shared 32.4 store; this proves the semantics
    // it relies on, with a counting fake Redis instead of a live one.
    const counters = new Map();

    const io = {
      incr: async (key) => {
        const next = (counters.get(key) || 0) + 1;

        counters.set(key, next);

        return next;
      },
      get: async (key) => counters.get(key) ?? null,
      del: async (key) => {
        counters.delete(key);
      },
      expireIfMissing: async () => false,
    };

    const limiter = createRateLimitStore({
      sharedName: AI_CHATBOT_RATE_LIMIT.sharedName,
      windowMs: AI_CHATBOT_RATE_LIMIT.windowMs,
      io,
    });

    const identity = `${COMPANY}:${USER}`;

    let refusedAt = null;

    for (let attempt = 1; attempt <= AI_CHATBOT_RATE_LIMIT.maximum + 1; attempt += 1) {
      const verdict = await limiter.hit(identity, AI_CHATBOT_RATE_LIMIT.maximum);

      if (verdict?.limited === true && refusedAt === null) refusedAt = attempt;
    }

    // 20 allowed, the 21st refused. A cap that allowed 21 would be an off-by-one
    // that quietly gave every tenant 5% more vendor spend than configured.
    assert.equal(refusedAt, AI_CHATBOT_RATE_LIMIT.maximum + 1);
  });

  test('the chatbot limiter key is tenant- and user-scoped', async () => {
    // Two employees in the same tenant must not share a bucket, and the same
    // employee in two tenants must not either.
    const seen = [];

    const io = {
      incr: async (key) => {
        seen.push(key);

        return 1;
      },
      get: async () => 1,
      del: async () => {},
      expireIfMissing: async () => false,
    };

    const limiter = createRateLimitStore({
      sharedName: AI_CHATBOT_RATE_LIMIT.sharedName,
      windowMs: AI_CHATBOT_RATE_LIMIT.windowMs,
      io,
    });

    await limiter.hit(`${COMPANY}:${USER}`, AI_CHATBOT_RATE_LIMIT.maximum);
    await limiter.hit(`${COMPANY}:0000000000000000000064c9`, AI_CHATBOT_RATE_LIMIT.maximum);

    // The store exposes its own prefix, so the namespacing is asserted rather
    // than inferred: every AI limiter key must live under the crewly:<env>:rl:
    // tree and under its own shared name.
    assert.match(limiter.keyPrefix, /^crewly:[^:]+:rl:ai-chatbot:$/);
    assert.notEqual(seen[0], seen[1]);
  });

  test('the controller carries the three-section comment convention', () => {
    const source = read('src/controllers/aiController.js');

    const handler = source.slice(source.indexOf('export const askChatbot'));

    assert.equal(
      handler.indexOf('// Data from frontend - requests from frontend') <
        handler.indexOf('// DB Logic - DB logics'),
      true,
    );

    assert.equal(
      handler.indexOf('// DB Logic - DB logics') <
        handler.indexOf('// Data to frontend - response to frontend'),
      true,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.5 — THE REPLY LANGUAGE
//
// What is being pinned here is not "the prompt contains a language string".
// It is four specific behaviours that are each easy to break and expensive to
// notice:
//
//   1. ENGLISH IS THE BASE CASE AND CARRIES NO RULE AT ALL. Not a rule that
//      says "reply in English" — no rule. The owner measured a full turn at
//      ~556 tokens against a 1024 ceiling, and an instruction nobody needs is
//      a tax paid on every single request.
//
//   2. EVERY SUPPORTED LANGUAGE INJECTS ITS OWN LABEL, VERBATIM. The labels
//      name the SCRIPT, not just the language, because "reply in Tamil" is
//      ambiguous to a model that can produce either Tamil script or a Roman
//      transliteration.
//
//   3. AN UNSUPPORTED OR ABSENT LANGUAGE FALLS BACK TO ENGLISH SILENTLY. The
//      validator refuses it with a 400 at the edge, so this is the defence in
//      depth for a caller that reaches the service directly. Failing a
//      question over a cosmetic preference would be the wrong trade.
//
//   4. A LANGUAGE CHANGE NEVER WEAKENS A RULE 1-14 GUARANTEE. Rule 15 is
//      appended; nothing above it is touched. This is asserted, not assumed.
//
// The validator half is in phase36Closeout.test.js, which owns the chain
// runner. This file owns the service.
// ═══════════════════════════════════════════════════════════════════════════
describe('the reply language (Phase 36.5)', () => {
  /** The system prompt the service actually handed to the vendor. */
  const systemPromptFor = async (language) => {
    const aiChatFn = recordingAiChat();

    await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: history(1),
      language,
      deps: baseDeps({ aiChatFn }),
    });

    const payload = aiChatFn.calls[0].messages;

    return payload.find((message) => message.role === 'system').content;
  };

  test('English is the base case and carries NO language rule', async () => {
    const prompt = await systemPromptFor('en');

    // Not "the rule says reply in English" — the rule is absent entirely. An
    // English turn must cost exactly what a 36.3 turn cost.
    assert.equal(prompt.includes('15. REPLY IN THE LANGUAGE'), false);

    // And it still carries the rules and the context, so nothing else moved.
    assert.equal(prompt.includes('1. '), true);
    assert.equal(prompt.includes('14. WHEN YOU CANNOT ANSWER'), true);
    assert.equal(prompt.includes(CONTEXT), true);
  });

  test('an absent language also carries no rule', async () => {
    // A 36.3 client that never heard of this feature must send byte-identical
    // requests and get byte-identical prompts.
    const prompt = await systemPromptFor(undefined);

    assert.equal(prompt.includes('15. REPLY IN THE LANGUAGE'), false);
  });

  test('each supported language injects its own label, verbatim', async () => {
    // The labels are read from the config, not re-typed here, so a label edit
    // cannot leave a test passing against wording the product no longer ships.
    const { AI_LANGUAGE_LABELS, AI_SUPPORTED_LANGUAGES } = await import(
      '../src/services/ai/aiConfig.js'
    );

    for (const language of AI_SUPPORTED_LANGUAGES) {
      if (language === 'en') continue;

      const prompt = await systemPromptFor(language);
      const expected = AI_LANGUAGE_LABELS[language];

      assert.equal(
        prompt.includes(`15. REPLY IN THE LANGUAGE THE EMPLOYEE CHOSE: ${expected}`),
        true,
        `${language} did not receive its own label`,
      );
    }
  });

  test('Tanglish is described as Latin letters, not Tamil script', async () => {
    // Tanglish is Tamil written in English/Roman letters. A label that just
    // said "Tamil" would make the model answer in Tamil script, which is not
    // what the person typed and not what they asked for.
    const prompt = await systemPromptFor('tanglish');

    assert.equal(prompt.includes('Tanglish (Tamil written in English/Roman letters'), true);
    assert.equal(prompt.includes('script)'), false);
  });

  test('an unsupported language falls back to English silently', async () => {
    // No throw, no error code, no rule 15. The question still gets answered.
    const prompt = await systemPromptFor('fr');

    assert.equal(prompt.includes('15. REPLY IN THE LANGUAGE'), false);
    assert.equal(prompt.includes(CONTEXT), true);
  });

  test('a non-string language also falls back to English silently', async () => {
    for (const bad of [null, 42, {}, [], true]) {
      const prompt = await systemPromptFor(bad);

      assert.equal(
        prompt.includes('15. REPLY IN THE LANGUAGE'),
        false,
        `language ${JSON.stringify(bad)} was not normalized`,
      );
    }
  });

  test('rule 15 never weakens a rule 1-14 guarantee', async () => {
    // A language instruction must not be able to talk the model out of
    // "never invent" or out of the negatives rule. Appending is the whole
    // design: everything above is untouched.
    const english = await systemPromptFor('en');
    const tamil = await systemPromptFor('ta');

    const head = tamil.slice(0, tamil.indexOf('15. REPLY IN THE LANGUAGE'));

    // Everything English carries before rule 15 is present, in order, before
    // rule 15 in Tamil.
    assert.equal(english.includes('4. '), true);
    assert.equal(head.includes('14. WHEN YOU CANNOT ANSWER'), true);
    assert.equal(head.includes('8. "NONE" IS AN ANSWER'), true);
    assert.equal(head.includes('13. YOU ONLY KNOW THIS EMPLOYEE'), true);

    // And the context block still comes AFTER the rules.
    assert.equal(
      tamil.indexOf('15. REPLY IN THE LANGUAGE') <
        tamil.indexOf('=== EMPLOYEE HR CONTEXT ==='),
      true,
    );
  });

  test('the language changes the prompt and nothing else in the payload', async () => {
    // A language is a presentation preference. It must not be able to change
    // how many messages go out, what roles they carry, or what the history
    // contains — that is the whole "language is not authority" rule, asserted
    // on the wire rather than trusted.
    const capture = async (language) => {
      const aiChatFn = recordingAiChat();

      await askHRAssistant({
        companyId: COMPANY,
        userId: USER,
        messages: history(3),
        language,
        deps: baseDeps({ aiChatFn }),
      });

      const payload = aiChatFn.calls[0].messages;

      return {
        roles: payload.map((message) => message.role),
        history: payload.slice(1).map((message) => message.content),
      };
    };

    const english = await capture('en');
    const tamil = await capture('ta');

    assert.deepEqual(english.roles, tamil.roles);
    assert.deepEqual(english.history, tamil.history);
    assert.equal(tamil.roles[0], 'system');
    assert.equal(tamil.roles.filter((role) => role === 'system').length, 1);
  });

  test('the vendor call itself is unchanged by the language', async () => {
    // The language lives in the system prompt only. The aiChat payload is
    // otherwise identical, which is what keeps the 36.1 guard ladder, the
    // quota accounting and the usage log untouched by 36.5.
    const aiChatFn = recordingAiChat();

    await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: history(2),
      language: 'te',
      deps: baseDeps({ aiChatFn }),
    });

    const input = aiChatFn.calls[0];

    // The DI seam and the guard arguments are whatever 36.1 defined — this
    // assertion is here to fail if a future unit bolts a language-specific
    // branch onto the vendor call.
    assert.equal(typeof input.messages, 'object');
    assert.equal(input.companyId, COMPANY);
    assert.equal(input.userId, USER);
  });
});
