// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.3 — QUICK PROMPT PILLS
//
// These are starting points, not a menu of features: each one is a question the
// assistant can already answer from the employee's own HR context. They are
// hidden once the conversation has started, so the panel reads as an
// introduction rather than a permanent toolbar.
//
// No emojis — lucide-react icons only.
// ═══════════════════════════════════════════════════════════════════════════

const QUICK_PROMPTS = Object.freeze([
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
    label: 'Leave policy',
    prompt: 'Explain the leave policy to me.',
  },
]);

const QuickPromptPills = ({ onSelect, disabled = false }) => (
  <div className="flex flex-wrap gap-2">
    {QUICK_PROMPTS.map((item) => (
      <button
        key={item.label}
        type="button"
        disabled={disabled}
        onClick={() => onSelect(item.prompt)}
        className="rounded-full border border-crewly-border bg-crewly-card px-3 py-1.5 text-[12px] text-crewly-dim transition hover:border-crewly-green hover:text-crewly-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green/40 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {item.label}
      </button>
    ))}
  </div>
);

export { QUICK_PROMPTS };

export default QuickPromptPills;
