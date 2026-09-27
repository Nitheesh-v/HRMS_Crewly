// PHASE 34.3 — the '@' suggestion list.
//
// SUGGESTIONS COME FROM THE CONVERSATION, NOT A DIRECTORY. The only people
// offered are the members of the conversation being written into — the same
// list the server will accept a mention from. There is no company-wide search
// here on purpose: a picker that can enumerate every employee would be a
// directory-exposure surface, and a mention of somebody who cannot read the
// message would be refused by the server anyway.
//
// Presentation only: the composer owns the query, the keyboard and the insert.
import { AtSign } from 'lucide-react';

import Avatar from './Avatar.jsx';
import { CHAT_MENTION_MAX_PER_MESSAGE } from '../../utils/chatMentions.js';

const MentionAutocomplete = ({ suggestions, activeIndex, onSelect, onHover, full = false }) => {
  if (full) {
    return (
      <div className="absolute bottom-full left-0 z-30 mb-1 w-64 rounded-lg border border-crewly-border bg-crewly-card p-2 shadow-lg">
        <p className="px-1 text-[11px] text-crewly-dim">
          A message can mention at most {CHAT_MENTION_MAX_PER_MESSAGE} people.
        </p>
      </div>
    );
  }

  if (suggestions.length === 0) {
    return (
      <div className="absolute bottom-full left-0 z-30 mb-1 w-64 rounded-lg border border-crewly-border bg-crewly-card p-2 shadow-lg">
        <p className="px-1 text-[11px] text-crewly-dim">
          Nobody in this conversation matches that name.
        </p>
      </div>
    );
  }

  return (
    <ul
      role="listbox"
      aria-label="Mention suggestions"
      className="absolute bottom-full left-0 z-30 mb-1 max-h-56 w-64 overflow-y-auto rounded-lg border border-crewly-border bg-crewly-card py-1 shadow-lg"
    >
      {suggestions.map((suggestion, index) => (
        <li key={suggestion.userId}>
          <button
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            // onMouseDown (not onClick): the press must land before the
            // textarea loses focus, or the selection would close the list.
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(suggestion);
            }}
            onMouseEnter={() => onHover(index)}
            className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors ${
              index === activeIndex ? 'bg-crewly-green/10 text-crewly-green' : 'text-crewly-text'
            }`}
          >
            <Avatar name={suggestion.name} seed={suggestion.userId} size="sm" />
            <span className="truncate">{suggestion.name}</span>
            <AtSign className="ml-auto h-3 w-3 shrink-0 text-crewly-dim" aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
};

export default MentionAutocomplete;
