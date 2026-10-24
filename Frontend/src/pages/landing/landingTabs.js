// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE — the one wire between the header's platform menu and the
// platform section's tabs.
//
// Both components are siblings in LandingPage, and the header's menu items must
// be able to say "open the Payroll tab" without adding a state library, a
// context or a router query. A DOM CustomEvent does that in three lines and keeps
// the anchors real: every menu item is still `<a href="#platform">`, so it works
// with JavaScript, keyboard and middle-click alike.
// ═══════════════════════════════════════════════════════════════════════════

export const PLATFORM_TAB_EVENT = 'crewly:landing-platform-tab';

export const requestPlatformTab = (key) => {
  if (typeof window === 'undefined' || !key) return;

  window.dispatchEvent(new CustomEvent(PLATFORM_TAB_EVENT, { detail: { key } }));
};

export const onPlatformTabRequested = (handler) => {
  if (typeof window === 'undefined') return () => {};

  const listener = (event) => handler(event?.detail?.key);
  window.addEventListener(PLATFORM_TAB_EVENT, listener);

  return () => window.removeEventListener(PLATFORM_TAB_EVENT, listener);
};
