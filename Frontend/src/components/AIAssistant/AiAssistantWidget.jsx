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

      {/*
        36.7-fix — THE PANEL IS NOT MODAL, AND THAT IS THE WHOLE POINT.

        It used to be `fixed inset-0` with a full-screen `bg-black/50`
        backdrop behind it, which dimmed and blocked the entire page. Opening
        the assistant to ask about a leave balance meant losing sight of the
        leave page you were reading — the exact thing you opened it for. An
        admin who opened it from AI Settings lost the settings.

        So the panel now sits in the corner where the button was, sized to the
        viewport, and the page behind it stays live and clickable. Closing is
        the X in the header or the Escape key.

        Clicking the page does NOT close it. A panel that vanishes the moment
        you click your own work is a panel you stop trusting — you would have
        to reopen it after every glance at what is behind it.

        No `aria-modal`, because it is not one. There was never a focus trap,
        so the old markup claimed a modality it did not enforce.

        Sized with `calc(100vh-8rem)` so the top edge clears the viewport on a
        short screen, and `max-h` so it does not become a full-height column on
        a tall one. Both forms are already used elsewhere in this codebase.
      */}
      {open && (
        <div
          role="dialog"
          aria-label="HR Assistant"
          className="fixed bottom-5 right-5 z-50 flex h-[calc(100vh-8rem)] max-h-[600px] w-[420px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-xl border border-crewly-border bg-crewly-bg shadow-2xl"
        >
          <AiAssistantPanel onClose={close} />
        </div>
      )}
    </>
  );
};

export default AiAssistantWidget;
