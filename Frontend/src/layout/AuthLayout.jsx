import { useState } from "react";
import { Link } from "react-router-dom";
import { Moon, Sun } from "lucide-react";
import heroImage from "../assets/login-hero.jpg";

// ═══════════════════════════════════════════════════════════════════════════
// AuthLayout — the shared shell for Crewly's authentication screens.
//
//   Figma desktop composition (dark + light):
//     visual="photo"  login    — approved hero photo over a navy brand
//                                block on the left, form on the right.
//     visual="green"  register — form on the left, emerald panel with a
//                                CSS product preview on the right.
//     (none)          forgot / reset / success — single centered column.
//   On <lg every variant collapses to the centered mobile column.
//
//   The preview in the green panel follows the landing page's convention
//   (DashboardPreview): illustrative UI, aria-hidden as a whole block, so
//   no assistive technology is read a decorative preview as real data.
//   The fabricated testimonial of the pre-redesign shell stays removed.
//
//   Theming: the root div carries data-theme. `.auth-root` in style.css
//   defines every surface colour as a custom property for dark (default),
//   and `[data-theme="light"]` redefines the same properties, so the Sun/
//   Moon toggle flips ONLY the auth subtree. The preference persists under
//   "crewly.theme" — a presentation setting, never sensitive.
//
//   Legacy call sites pass variant/headline/quote props; they are accepted
//   and ignored so those pages keep rendering inside the new shell.
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

const Logo = ({ onDark = false }) => (
  <Link
    to="/login"
    className="inline-flex items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--auth-ring)]"
  >
    <img src="/logo-crewly.png" alt="" className="h-8 w-8 object-contain" />
    <span
      className={`text-lg font-semibold tracking-tight ${
        onDark ? "text-white" : "auth-heading"
      }`}
    >
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

// Login's left panel: the Crewly-owned hero photo above a navy brand block.
// Deliberately contains no testimonials and no numbers.
const PhotoPanel = () => (
  <div className="relative hidden lg:flex lg:w-[46%] flex-col">
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <img
        src={heroImage}
        alt=""
        className="absolute inset-0 h-full w-full object-cover"
      />
    </div>
    <div className="auth-panel-navy border-t-4 border-[color:var(--auth-accent-strong)] p-10">
      <Logo onDark />
      <h2 className="mt-6 max-w-md text-4xl font-bold leading-tight text-white">
        Let’s empower your employees today.
      </h2>
      <p className="mt-4 max-w-md text-sm leading-relaxed text-slate-300">
        Onboarding, attendance, payroll and hiring — one workspace.
      </p>
    </div>
  </div>
);

// CSS mini-dashboard for the register panel — no screenshot asset, pure
// markup. ILLUSTRATIVE VALUES, not claims: the whole block is aria-hidden
// (same convention as the landing page's DashboardPreview).
const DashboardVisual = () => (
  <div className="w-full rounded-2xl border border-white/10 bg-[#0e1526]/90 p-4 shadow-2xl backdrop-blur">
    <div className="flex items-center justify-between">
      <p className="text-sm font-semibold text-white">Hi, Priya</p>
      <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-[10px] font-medium text-emerald-300">
        HR report
      </span>
    </div>
    <div className="mt-3 grid grid-cols-2 gap-2.5">
      {[
        { label: "Total Employees", value: "3,540", delta: "+28.5%", up: true },
        { label: "Job Applicants", value: "1,150", delta: "+14.0%", up: true },
        { label: "New Employees", value: "500", delta: "+15.1%", up: true },
        { label: "Resigned", value: "93", delta: "+25.5%", up: false },
      ].map((stat) => (
        <div key={stat.label} className="rounded-xl bg-white/[0.04] p-3">
          <p className="text-lg font-bold text-white">{stat.value}</p>
          <p className="text-[10px] text-slate-400">{stat.label}</p>
          <span
            className={`mt-1 inline-block rounded px-1.5 py-0.5 text-[9px] font-semibold ${
              stat.up
                ? "bg-emerald-500/15 text-emerald-300"
                : "bg-rose-500/15 text-rose-300"
            }`}
          >
            {stat.delta}
          </span>
        </div>
      ))}
    </div>
    <div className="mt-2.5 rounded-xl bg-white/[0.04] p-3">
      <p className="text-[10px] font-medium text-slate-400">Attendance today</p>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div className="h-full w-[86%] rounded-full bg-gradient-to-r from-emerald-500 to-emerald-300" />
      </div>
      <p className="mt-1.5 text-[10px] text-emerald-300">86% checked in</p>
    </div>
  </div>
);

const GreenPanel = () => (
  <div className="relative hidden lg:flex lg:w-[46%] flex-col items-center justify-center overflow-hidden bg-gradient-to-br from-emerald-500 via-emerald-600 to-teal-700 p-10">
    <div className="absolute -left-24 -top-24 h-72 w-72 rounded-full bg-white/10 blur-3xl" />
    <div className="absolute -bottom-32 -right-16 h-96 w-96 rounded-full bg-black/10 blur-3xl" />
    <div className="relative max-w-sm text-center">
      <h2 className="text-3xl font-bold leading-tight text-white">
        Let’s empower your employees today.
      </h2>
      <p className="mt-2 text-sm text-emerald-50/90">
        Onboarding, attendance, payroll and hiring — one workspace.
      </p>
    </div>
    <div aria-hidden="true" className="relative mt-8 w-full max-w-sm">
      <DashboardVisual />
    </div>
  </div>
);

const AuthLayout = ({ children, centerLogo = false, visual = null }) => {
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

  const formSide = (
    <div className="relative flex min-h-screen flex-1 flex-col">
      <header
        className={`relative mx-auto flex w-full max-w-md items-center px-6 pt-6 sm:pt-8 lg:hidden ${
          centerLogo ? "justify-center" : "justify-between"
        }`}
      >
        <Logo />
        <div className={centerLogo ? "absolute right-6 top-6 sm:top-8" : ""}>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <div className="absolute right-6 top-6 hidden lg:block">
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </div>

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

  return (
    <div
      data-theme={theme}
      className="auth-root flex min-h-screen flex-col lg:flex-row"
    >
      {visual === "photo" && <PhotoPanel />}
      {formSide}
      {visual === "green" && <GreenPanel />}
    </div>
  );
};

export default AuthLayout;
