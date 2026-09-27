// PHASE 34.5 — "… is typing" for the OPEN conversation.
//
// Presentation only: ChatPage resolves the names and passes them in, and the
// component renders nothing when the list is empty. It deliberately says TEXT
// (no emoji, no icon): the last thing this surface may become is a personality
// badge, and a plain sentence is harder to misread than a pictogram.
//
// The three dots are CSS animation, not glyphs, and they carry
// `aria-hidden` — the sentence itself is the accessible content, so a screen
// reader hears "Nitheesh V is typing" instead of punctuation.
const TypingIndicator = ({ names = [] }) => {
  const people = names.filter(Boolean);

  if (people.length === 0) return null;

  const label =
    people.length === 1
      ? `${people[0]} is typing`
      : people.length === 2
        ? `${people[0]} and ${people[1]} are typing`
        : `${people.length} people are typing`;

  return (
    <div
      aria-live="polite"
      className="flex items-center gap-1.5 px-3 pb-1 pt-0.5 text-[11px] text-crewly-dim sm:px-4"
    >
      <span className="flex items-end gap-0.5" aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className="h-1 w-1 animate-pulse rounded-full bg-crewly-dim"
            style={{ animationDelay: `${index * 160}ms` }}
          />
        ))}
      </span>

      <span className="truncate">{label}</span>
    </div>
  );
};

export default TypingIndicator;
