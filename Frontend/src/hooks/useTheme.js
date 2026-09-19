import { useCallback, useEffect, useState } from 'react';

const THEME_KEY = 'crewly_theme'; // 'light' | 'dark'
const THEME_EVENT = 'crewly:theme-change';

const getInitial = () => {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    return 'light';
  } catch {
    return 'light';
  }
};

const broadcast = (theme) => {
  try {
    window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme }));
  } catch {}
};

export const useTheme = () => {
  const [theme, setTheme] = useState(getInitial);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {}
    broadcast(theme);
  }, [theme]);

  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === THEME_KEY && (e.newValue === 'light' || e.newValue === 'dark')) {
        setTheme(e.newValue);
      }
    };
    const onCustom = (e) => {
      const t = e.detail;
      if (t === 'light' || t === 'dark') setTheme(t);
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(THEME_EVENT, onCustom);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(THEME_EVENT, onCustom);
    };
  }, []);

  const toggle = useCallback(() => {
    setTheme((t) => (t === 'light' ? 'dark' : 'light'));
  }, []);

  const setLight = useCallback(() => setTheme('light'), []);
  const setDark = useCallback(() => setTheme('dark'), []);

  return { theme, toggle, setLight, setDark, isLight: theme === 'light', isDark: theme === 'dark' };
};

export default useTheme;
