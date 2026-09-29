// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.3 — THE QUICK PROMPTS (data only)
//
// Kept in a .js module, separate from the JSX component, so a test can import
// it without a JSX transform.
//
// 36.3-fix — EVERY PROMPT MUST BE ANSWERABLE.
//
// This list first shipped with a "Leave policy" prompt. There is NO
// leave-policy document source in this repository: 36.2's `policies` category
// carries upcoming holidays and recent announcement titles, and nothing else.
// So the assistant correctly refused — "I do not have that information. Please
// contact your HR team." — which is exactly the designed behaviour, but the
// pill had promised something the context cannot deliver. A quick prompt that
// is guaranteed to fail is worse than no quick prompt at all.
//
// A prompt is only allowed if its answer can be assembled from one of the four
// categories the retriever actually fills:
//   profile     — name, designation, department, date of joining, employee code
//   leaves      — balances per type, pending leave requests
//   attendance  — today's status, the current shift, this week's work hours
//   policies    — upcoming holidays, recent announcement titles  (NOTHING ELSE)
//
// Frontend/test/aiChatPills.test.js enforces this.
// ═══════════════════════════════════════════════════════════════════════════

export const QUICK_PROMPTS = Object.freeze([
  {
    label: 'My leave balance',
    prompt: 'What is my current leave balance?',
  },
  {
    label: 'Am I present today',
    prompt: 'What is my attendance status for today?',
  },
  {
    label: 'Upcoming holidays',
    prompt: 'Which holidays are coming up next?',
  },
  {
    label: 'My shift timing',
    prompt: 'What are my shift timings?',
  },
  {
    label: 'My profile',
    prompt: 'What details do you have about my profile?',
  },
  {
    label: 'Latest announcements',
    prompt: 'What are the latest announcements?',
  },
]);

export default QUICK_PROMPTS;
