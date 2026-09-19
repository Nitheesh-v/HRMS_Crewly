import { Moon, Sun } from 'lucide-react';
import useTheme from '../hooks/useTheme.js';

const ThemeToggle = ({ className = '' }) => {
  const { theme, toggle, isLight } = useTheme();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${isLight ? 'dark' : 'light'} mode`}
      title={isLight ? 'Switch to dark' : 'Switch to light'}
      className={`inline-flex h-9 w-14 items-center rounded-full border border-crewly-border bg-crewly-card p-1 transition hover:border-crewly-green/30 ${className}`}
    >
      <span
        className={`flex h-7 w-7 items-center justify-center rounded-full bg-crewly-bg text-crewly-text shadow-sm transition-all ${isLight ? 'translate-x-0 bg-crewly-green text-white' : 'translate-x-5 bg-crewly-card'}`}
      >
        {isLight ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
      </span>
      <span className="sr-only">{theme}</span>
    </button>
  );
};

// Compact icon-only variant for tight headers (Figma pill Light/Dark)
export const FigmaThemePill = () => {
  const { isLight, setLight, setDark } = useTheme();
  return (
    <div className="inline-flex items-center gap-1 rounded-full border border-crewly-border bg-crewly-card p-1">
      <button
        type="button"
        onClick={setLight}
        className={`rounded-full px-3 py-1 text-xs font-semibold transition ${isLight ? 'bg-crewly-green text-white shadow' : 'text-crewly-dim hover:text-crewly-text'}`}
      >
        Light
      </button>
      <button
        type="button"
        onClick={setDark}
        className={`rounded-full px-3 py-1 text-xs font-semibold transition ${!isLight ? 'bg-crewly-bg text-crewly-text shadow border border-crewly-border' : 'text-crewly-dim hover:text-crewly-text'}`}
      >
        Dark
      </button>
    </div>
  );
};

export default ThemeToggle;
