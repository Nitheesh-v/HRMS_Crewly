// Small, dependency-free formatting helpers for the chat surface.
//
// Everything here is LOCAL time on purpose: a day separator that says
// "Yesterday" because the ISO string crossed midnight in UTC is a bug a user
// reads as "the app lost my message".

const pad = (value) => String(value).padStart(2, "0");

// Local calendar key (YYYY-MM-DD). Never toISOString() — that is UTC.
export const dayKey = (value) => {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export const timeOf = (value) => {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

// "Today" / "Yesterday" / a weekday inside the last week / a short date.
export const dayLabel = (value) => {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  const today = startOfDay(new Date());
  const day = startOfDay(date);
  const diffDays = Math.round((today - day) / 86_400_000);

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays > 1 && diffDays < 7) {
    return date.toLocaleDateString([], { weekday: "long" });
  }

  return date.toLocaleDateString([], {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
};

// Short stamp for a conversation row: "now", "12m", "3h", "Yesterday", "12 Mar".
export const relativeTime = (value) => {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  const seconds = Math.round((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;

  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);

  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return date.toLocaleDateString([], { weekday: "short" });

  return date.toLocaleDateString([], { day: "numeric", month: "short" });
};

// Two messages belong together when they are from the same sender and close in
// time. Kept deliberately simple: no server state, no "is typing".
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

export const shouldGroup = (previous, current) => {
  if (!previous || !current) return false;
  if (String(previous.senderUserId) !== String(current.senderUserId)) return false;
  if (previous.type === "SYSTEM" || current.type === "SYSTEM") return false;

  const gap = new Date(current.createdAt) - new Date(previous.createdAt);

  return Number.isFinite(gap) && gap >= 0 && gap <= GROUP_WINDOW_MS;
};
