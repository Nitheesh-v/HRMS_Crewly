// Initials avatar — no image hosting, no presence, no network.
//
// A chat list with no faces is hard to scan, and the backend deliberately does
// not expose avatars. Initials plus a deterministic tint give every sender a
// stable identity that costs nothing and leaks nothing.

const TINTS = ["#4493f8", "#a371f7", "#3fb950", "#d29922", "#db61a2", "#39c5cf", "#f0883e"];

const initialsOf = (name) => {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();

  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

const tintOf = (seed) => {
  const text = String(seed || "");
  let hash = 0;

  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 999_983;
  }

  return TINTS[hash % TINTS.length];
};

const SIZES = {
  sm: "h-6 w-6 text-[10px]",
  md: "h-8 w-8 text-[11px]",
  lg: "h-10 w-10 text-sm",
};

const Avatar = ({ name, seed, size = "md", className = "" }) => {
  const tint = tintOf(seed ?? name);

  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 select-none items-center justify-center rounded-full font-bold ${SIZES[size] ?? SIZES.md} ${className}`}
      style={{ backgroundColor: `${tint}24`, color: tint }}
    >
      {initialsOf(name)}
    </span>
  );
};

export default Avatar;
