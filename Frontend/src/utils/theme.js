// ═══════════════════════════════════════════════════════════════════════════
// THEME — one attribute, two palettes.
//
// The app is dark by default; the light theme is the warm paper one described in
// style.css (block 12b). Everything the components know about the theme is this
// file: which theme is current, how to change it, and how to remember it.
//
// The value is stored under one localStorage key and mirrored onto
// <html data-theme="…">. index.html reads that key with a few lines of vanilla
// script before the first paint, so this module is the *runtime* half of the
// switch, never the thing that decides what the first frame looks like.
// ═══════════════════════════════════════════════════════════════════════════

export const THEME_STORAGE_KEY = 'crewly-theme';
export const DARK = 'dark';
export const LIGHT = 'light';
export const DEFAULT_THEME = DARK;

/** The window's chrome follows the page, not a background app. */
const THEME_COLOR = {
  [DARK]: '#0d1117',
  [LIGHT]: '#f6efe4',
};

const listeners = new Set();

const isTheme = (value) => value === DARK || value === LIGHT;

/**
 * What the user asked for last time, if storage is readable at all. Safari in a
 * private window and some embedded webviews throw on access rather than
 * returning null, which is why this is a try/catch and not a `?.`.
 */
export const readStoredTheme = () => {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
};

/**
 * The theme the page is actually painted in. The attribute is the source of
 * truth once index.html has run: it is already there on the first frame, and a
 * second read of storage could disagree with it mid-session.
 */
export const getTheme = () => {
  if (typeof document === 'undefined') return DEFAULT_THEME;
  const applied = document.documentElement.getAttribute('data-theme');
  return isTheme(applied) ? applied : readStoredTheme();
};

const notify = () => listeners.forEach((listener) => listener());

/**
 * Apply + persist. Returns the theme that was actually set, so a caller can use
 * the result without re-reading the DOM.
 */
export const setTheme = (theme) => {
  const next = isTheme(theme) ? theme : DEFAULT_THEME;

  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    if (next === DARK) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', next);

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLOR[next]);
  }

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // Storage is a convenience, not a requirement — the switch still works for
    // this session, it just will not survive a reload.
  }

  notify();
  return next;
};

/**
 * Subscribe for useSyncExternalStore. The `storage` listener keeps two open
 * tabs in step: changing the theme in one should not leave the other half-dark.
 */
export const subscribeTheme = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    if (!isTheme(event.newValue)) return;
    if (event.newValue === getTheme()) return;
    setTheme(event.newValue);
  });
}
