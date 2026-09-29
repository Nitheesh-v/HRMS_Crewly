// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.3 — QUICK PROMPT PILLS
//
// The prompt DATA lives in ./chatPrompts.js so a test can import it without a
// JSX transform. Read the note there before adding a prompt: every pill must be
// answerable from the four categories the retriever actually fills.
//
// Hidden once the conversation has started, so the panel reads as an
// introduction rather than a permanent toolbar.
//
// No emojis — lucide-react icons only.
// ═══════════════════════════════════════════════════════════════════════════

import { QUICK_PROMPTS } from './chatPrompts.js';

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
