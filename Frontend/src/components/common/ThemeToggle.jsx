import { Moon, Sun } from 'lucide-react';
import useTheme from '../../hooks/useTheme.js';

// ═══════════════════════════════════════════════════════════════════════════
// THEME TOGGLE — the day/night switch in the app header.
//
// It shows the theme you are *in* (a sun on paper, a moon in the dark) and its
// accessible name says what pressing it will do, because "Moon" alone tells a
// screen-reader user nothing about a state they cannot see.
//
// Sits in the header next to the notification bell: one control, reachable on
// every screen and on mobile, where the header collapses to icons anyway.
// ═══════════════════════════════════════════════════════════════════════════

const ThemeToggle = ({ className = '' }) => {
  const { theme, isLight, toggleTheme } = useTheme();
  const next = isLight ? 'dark' : 'light';

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-crewly-border bg-crewly-bg text-crewly-dim transition hover:border-crewly-green hover:text-crewly-text ${className}`}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      data-theme-state={theme}
    >
      {isLight ? (
        <Sun className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Moon className="h-4 w-4" aria-hidden="true" />
      )}
    </button>
  );
};

export default ThemeToggle;
