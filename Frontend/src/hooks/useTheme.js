import { useCallback, useSyncExternalStore } from 'react';
import { getTheme, setTheme, subscribeTheme, DEFAULT_THEME } from '../utils/theme.js';

/**
 * The current theme, and the one control that changes it.
 *
 * `useSyncExternalStore` rather than local state because the attribute can be
 * changed from outside React — the pre-paint script in index.html, or another
 * tab — and every toggle on the page must agree about what is on screen.
 *
 * The server snapshot is the default night theme: this app is client-rendered,
 * but the hook stays honest if it is ever rendered without a document.
 */
export default function useTheme() {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, () => DEFAULT_THEME);

  const toggleTheme = useCallback(() => {
    setTheme(getTheme() === 'light' ? 'dark' : 'light');
  }, []);

  return {
    theme,
    isLight: theme === 'light',
    setTheme,
    toggleTheme,
  };
}
