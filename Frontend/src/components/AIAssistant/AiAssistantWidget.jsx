// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.3 — THE AI ASSISTANT WIDGET (floating button + panel)
//
// 36.3 first shipped the assistant as a full page at /app/ai-assistant with a
// sidebar entry. The owner asked for the pattern used by comparable HR tools
// instead: a floating robot button in the corner that opens the assistant as a
// panel, reachable from ANY screen without leaving what you were doing.
//
// WHAT THIS IS NOT
//   It is not a notification centre. The reference product this is modelled on
//   shows a count badge on its button; this one deliberately does NOT, because
//   there is nothing here that generates a count. A badge that is always zero,
//   or that is decorative, would be a lie told in the corner of every screen.
//
// MOUNTED ONCE, in AppLayout, so it exists on every authenticated page. The
// conversation state lives in the aiChat Redux slice and is therefore SHARED:
// opening the panel on one screen and then on another shows the same
// conversation, and closing the panel does not clear it.
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useState } from 'react';

import { Bot } from 'lucide-react';

import AiAssistantPanel from './AiAssistantPanel.jsx';

const AiAssistantWidget = () => {
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);

  // Escape closes, which is the one keyboard affordance a modal owes. The
  // listener is only attached while the panel is open, so it can never swallow
  // an Escape meant for something else on the page.
  useEffect(() => {
    if (!open) return undefined;

    const onKeyDown = (event) => {
      if (event.key === 'Escape') close();
    };

    window.addEventListener('keydown', onKeyDown);

    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  return (
    <>
      {/* The floating button. Hidden while the panel is open, because the panel
          carries its own close control and two affordances for one action is
          noise. */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="HR Assistant"
          aria-label="Open the HR assistant"
          className="fixed bottom-5 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-crewly-green text-crewly-bg shadow-lg shadow-black/30 transition hover:opacity-90 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green/60"
        >
          <Bot className="h-6 w-6" aria-hidden="true" strokeWidth={1.8} />
        </button>
      )}

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="HR Assistant"
          className="fixed inset-0 z-50 flex items-end justify-end p-3 sm:p-5"
        >
          {/* Dismiss on backdrop click, but NOT on a click inside the panel. */}
          <button
            type="button"
            aria-label="Close the HR assistant"
            onClick={close}
            className="absolute inset-0 cursor-default bg-black/50"
          />

          <div className="relative flex h-[85vh] max-h-[620px] w-full max-w-[420px] flex-col overflow-hidden rounded-xl border border-crewly-border bg-crewly-bg shadow-2xl">
            <AiAssistantPanel onClose={close} />
          </div>
        </div>
      )}
    </>
  );
};

export default AiAssistantWidget;
