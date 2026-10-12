import { useState } from "react";
import { Link } from "react-router-dom";
import { Moon, Sun } from "lucide-react";

// ═══════════════════════════════════════════════════════════════════════════
// AuthLayout — the shared shell for Crewly's authentication screens.
//
//   Figma redesign (Auth & Onboarding set): one centered column — logo,
//   headline, form, links, footer — on a themed canvas. The decorative
//   side panels of the old shell (stock photo, fabricated testimonial,
//   fake-stat dashboard) are gone: security/truth rules say the auth
//   screens carry no invented customers, numbers or social proof.
//
//   Theming: the root div carries data-theme. `.auth-root` in style.css
//   defines every surface colour as a custom property for dark (default),
//   and `[data-theme="light"]` redefines the same properties, so the Sun/
//   Moon toggle flips ONLY the auth subtree. The preference persists under
//   "crewly.theme" — a presentation setting, never sensitive.
//
//   Legacy call sites (ForgotPasswordPage, ResetPasswordPage) pass
//   variant/headline/quote props; they are accepted and ignored so those
//   pages keep rendering inside the new shell with zero edits.
// ═══════════════════════════════════════════════════════════════════════════

const THEME_KEY = "crewly.theme";

const initialTheme = () => {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* storage unavailable (private mode) — fall through to default */
  }
  return "dark";
};

const Logo = () => (
  <Link
    to="/login"
    className="inline-flex items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--auth-ring)]"
  >
    <img src="/logo-crewly.png" alt="" className="h-8 w-8 object-contain" />
    <span className="auth-heading text-lg font-semibold tracking-tight">
      Crewly
    </span>
  </Link>
);

const ThemeToggle = ({ theme, onToggle }) => (
  <button
    type="button"
    onClick={onToggle}
    className="auth-theme-toggle"
    aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    aria-pressed={theme === "light"}
    title={theme === "dark" ? "Light mode" : "Dark mode"}
  >
    {theme === "dark" ? (
      <Sun className="h-4 w-4" aria-hidden="true" />
    ) : (
      <Moon className="h-4 w-4" aria-hidden="true" />
    )}
  </button>
);

const AuthLayout = ({ children }) => {
  const [theme, setTheme] = useState(initialTheme);

  const toggleTheme = () => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        /* non-fatal: the toggle still works for this visit */
      }
      return next;
    });
  };

  return (
    <div data-theme={theme} className="auth-root flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-md items-center justify-between px-6 pt-6 sm:pt-8">
        <Logo />
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </header>

      <main className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="w-full max-w-md">{children}</div>
      </main>

      <footer className="px-6 pb-6">
        <p className="auth-sub text-center text-xs">
          © {new Date().getFullYear()} Crewly · All rights reserved
        </p>
      </footer>
    </div>
  );
};

export default AuthLayout;
