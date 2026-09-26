// PHASE 34.1 — the reaction pills that sit UNDER a message bubble.
//
// One pill per type that has at least one reaction on this message. A pill
// shows the icon and the count, and is highlighted when the signed-in user is
// one of the reactors (`mine`, computed server-side on the REST path and from
// the broadcast on the realtime path).
//
// Clicking a pill TOGGLES: mine -> remove, not mine -> add. The parent owns
// that decision and the socket call; this component only reports the type.
import ReactionIcon from './ReactionIcon.jsx';
import { reactionLabel } from '../../utils/chatReactions.js';

const ReactionBar = ({ reactions = [], onToggle, disabled = false }) => {
  if (reactions.length === 0) return null;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {reactions.map((reaction) => {
        const label = reactionLabel(reaction.type);

        return (
          <button
            key={reaction.type}
            type="button"
            disabled={disabled}
            title={
              reaction.mine
                ? `Remove your ${label.toLowerCase()} reaction`
                : `React with ${label.toLowerCase()}`
            }
            aria-label={
              reaction.mine
                ? `Remove your ${label.toLowerCase()} reaction, ${reaction.count} total`
                : `React with ${label.toLowerCase()}, ${reaction.count} total`
            }
            aria-pressed={Boolean(reaction.mine)}
            onClick={() => onToggle(reaction.type)}
            className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green/40 disabled:opacity-50 ${
              reaction.mine
                ? 'border-crewly-green/50 bg-crewly-green/15 text-crewly-green'
                : 'border-crewly-border bg-crewly-card text-crewly-dim hover:border-crewly-green/40 hover:text-crewly-green'
            }`}
          >
            <ReactionIcon type={reaction.type} />
            <span className="tabular-nums">{reaction.count}</span>
          </button>
        );
      })}
    </div>
  );
};

export default ReactionBar;
