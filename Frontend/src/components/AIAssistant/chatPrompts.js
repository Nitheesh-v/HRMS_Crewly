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
// A prompt is only allowed if its answer can be assembled from a category the
// retriever actually fills. 36.4 widened that list, so the pills widened with
// it — but the rule did not change, and it is enforced by test:
//
//   profile           — name, designation, department, DOJ, employee code
//   payslips          — WHICH months exist and their status (no figures)
//   expenses          — own claims: date, category, amount, status
//   tasks             — own tasks: title, status, due date
//   projects          — own projects
//   documents         — own documents: name, category
//   leave-requests    — full history including rejected
//   leaves            — balances per type, pending requests
//   attendance        — today's status, current shift, this week's hours
//   attendance-month  — month-to-date rollup
//   policies          — upcoming holidays, recent announcement titles
//   capabilities      — HOW to do things (needs no data at all)
//
// Frontend/test/aiChatPills.test.js enforces this.
// ═══════════════════════════════════════════════════════════════════════════

export const QUICK_PROMPTS = Object.freeze([
  {
    label: 'My leave balance',
    prompt: 'What is my current leave balance?',
  },
  {
    label: 'My leave history',
    prompt: 'Show me my recent leave requests.',
  },
  {
    label: 'Am I present today',
    prompt: 'What is my attendance status for today?',
  },
  {
    label: 'My shift timing',
    prompt: 'What are my shift timings?',
  },
  {
    label: 'This month so far',
    prompt: 'How has my attendance been this month so far?',
  },
  {
    label: 'Upcoming holidays',
    prompt: 'Which holidays are coming up next?',
  },
  {
    label: 'My profile',
    prompt: 'What details do you have about my profile?',
  },
  {
    label: 'My tasks',
    prompt: 'What tasks are assigned to me?',
  },
  {
    label: 'My expenses',
    prompt: 'What is the status of my expense claims?',
  },
  {
    label: 'My payslips',
    prompt: 'Which payslips do I have?',
  },
  {
    label: 'My projects',
    prompt: 'Which projects am I on?',
  },
  {
    label: 'My documents',
    prompt: 'What documents do you have for me?',
  },
  {
    label: 'How do I apply for leave',
    prompt: 'How do I apply for leave?',
  },
  {
    label: 'How do I fix a missed punch',
    prompt: 'How do I fix a missed or wrong punch?',
  },
  {
    label: 'Latest announcements',
    prompt: 'What are the latest announcements?',
  },
]);

export default QUICK_PROMPTS;
