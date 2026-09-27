// PHASE 34.3 — the message body with its mentions highlighted.
//
// TEXT NODES ONLY. The body is split into plain strings and <span>s, so a
// message can never inject markup: every fragment is rendered by React as text.
// The only styling is a background tint on the tokens the SERVER stored, plus a
// slightly stronger tint when the mention is of the signed-in user.
//
// THE TOKEN IS THE AUTHORITY. Highlighting matches the exact stored token
// ('@Alice Rao'), not a name guessed from the member list, so two members with
// the same name cannot produce a wrong highlight and a token the server did not
// verify is never marked. A token also has to start at a word boundary, so
// "boss@alice" in an email address is not highlighted.
import { useMemo } from 'react';

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MentionText = ({ text, mentions = [], meId = null, className = '' }) => {
  const parts = useMemo(() => {
    const value = String(text ?? '');
    const rows = (mentions ?? []).filter((mention) => mention?.token);

    if (value.length === 0 || rows.length === 0) return [{ text: value, mention: null }];

    // Longest token first, so '@Alice Rao' wins over a hypothetical '@Alice'.
    const tokens = [...new Set(rows.map((mention) => mention.token))].sort(
      (a, b) => b.length - a.length
    );

    const pattern = new RegExp(`(${tokens.map(escapeRegExp).join('|')})`, 'g');

    const chunks = value.split(pattern);
    const built = [];

    let cursor = 0;

    for (const chunk of chunks) {
      if (chunk === '') continue;

      const mention = rows.find((row) => row.token === chunk) ?? null;
      const start = cursor;
      cursor += chunk.length;

      if (!mention) {
        built.push({ text: chunk, mention: null });
        continue;
      }

      // A boundary check the regex cannot express: the token must not be glued
      // to a preceding word character (that would be an email, not a mention).
      const before = start > 0 ? value[start - 1] : '';

      if (before && !/\s/.test(before)) {
        built.push({ text: chunk, mention: null });
        continue;
      }

      built.push({ text: chunk, mention });
    }

    return built;
  }, [text, mentions]);

  return (
    <p className={`whitespace-pre-wrap break-words text-sm leading-relaxed text-crewly-text ${className}`}>
      {parts.map((part, index) => {
        if (!part.mention) return <span key={index}>{part.text}</span>;

        const isMe = meId && String(part.mention.userId) === String(meId);

        return (
          <span
            key={index}
            title={isMe ? 'You were mentioned' : undefined}
            className={`rounded px-0.5 font-medium ${
              isMe ? 'bg-crewly-green/25 text-crewly-green' : 'bg-crewly-green/10 text-crewly-text'
            }`}
          >
            {part.text}
          </span>
        );
      })}
    </p>
  );
};

export default MentionText;
