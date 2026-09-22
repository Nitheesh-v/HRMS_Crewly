import { Link } from "react-router-dom";
import heroImage from "../assets/login-hero.jpg";

// ═══════════════════════════════════════════════════════════════════════════
// AuthLayout — the shared shell for Crewly's authentication screens.
//
//   variant="split"   — marketing visual on one side, form on the other
//   variant="centered" — centered card column on a patterned dark canvas
//
// Presentation only: pages keep every piece of their own logic.
// ═══════════════════════════════════════════════════════════════════════════

const Logo = () => (
  <Link to="/login" className="flex items-center gap-2.5">
    <img src="/logo-crewly.png" alt="" className="h-7 w-7 object-contain" />
    <span className="text-lg font-semibold tracking-tight text-white">
      Crewly
    </span>
  </Link>
);

const Footer = () => (
  <p className="text-center text-xs text-slate-500">
    © {new Date().getFullYear()} Crewly · All rights reserved
    <span className="mx-2 text-slate-700">|</span>
    <span className="cursor-default text-slate-500">Terms &amp; Conditions</span>
    <span className="mx-1.5"></span>
    <span className="cursor-default text-slate-500">Privacy Policy</span>
  </p>
);

const Dots = ({ active = 0, total = 3 }) => (
  <div className="flex gap-2">
    {Array.from({ length: total }).map((_, i) => (
      <span
        key={i}
        className={`h-1 w-8 rounded-full ${i === active ? "bg-white" : "bg-white/25"}`}
      />
    ))}
  </div>
);

// CSS mini-dashboard for the signup panel — no screenshot asset, pure markup.
const DashboardVisual = () => (
  <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0e1526]/90 p-4 shadow-2xl backdrop-blur">
    <div className="flex items-center justify-between">
      <p className="text-sm font-semibold text-white">Hi, Priya 👋</p>
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

const AuthLayout = ({
  variant = "split",
  visualSide = "left",
  headline,
  quote,
  quoteAuthor,
  quoteRole,
  activeDot = 0,
  children,
}) => {
  const photoPanel = (
    <div className="relative hidden min-h-screen flex-col justify-between overflow-hidden lg:flex lg:w-[46%]">
      <img
        src={heroImage}
        alt=""
        className="absolute inset-0 h-full w-full object-cover"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-[#0b1120] via-[#0b1120]/55 to-[#0b1120]/35" />
      <div className="relative p-10">
        <Logo />
      </div>
      <div className="relative p-10">
        <h2 className="max-w-md text-4xl font-bold leading-tight text-white">
          {headline}
        </h2>
        <p className="mt-4 max-w-md text-sm leading-relaxed text-slate-200/90">
          “{quote}”
        </p>
        <div className="mt-8 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/20 text-sm font-bold text-emerald-300">
            {(quoteAuthor || "C")[0]}
          </span>
          <div>
            <p className="text-sm font-semibold text-white">{quoteAuthor}</p>
            <p className="text-xs text-slate-300">{quoteRole}</p>
          </div>
        </div>
        <div className="mt-8">
          <Dots active={activeDot} />
        </div>
      </div>
    </div>
  );

  const greenPanel = (
    <div className="relative hidden min-h-screen flex-col items-center justify-center overflow-hidden bg-gradient-to-br from-emerald-500 via-emerald-600 to-teal-700 lg:flex lg:w-[46%]">
      <div className="absolute -left-24 -top-24 h-72 w-72 rounded-full bg-white/10 blur-3xl" />
      <div className="absolute -bottom-32 -right-16 h-96 w-96 rounded-full bg-black/10 blur-3xl" />
      <div className="relative mb-8 max-w-sm text-center">
        <h2 className="text-3xl font-bold leading-tight text-white">
          Let’s empower your employees today.
        </h2>
        <p className="mt-2 text-sm text-emerald-50/90">
          Onboarding, attendance, payroll and hiring — one workspace.
        </p>
      </div>
      <div className="relative">
        <DashboardVisual />
      </div>
    </div>
  );

  if (variant === "centered") {
    return (
      <div className="auth-wave-bg flex min-h-screen flex-col bg-[#0b1120]">
        <div className="flex flex-1 flex-col items-center justify-center px-4 py-12">
          <div className="mb-8 flex flex-col items-center">
            <Logo />
          </div>
          <div className="w-full max-w-md">{children}</div>
        </div>
        <div className="px-4 pb-6">
          <Footer />
        </div>
      </div>
    );
  }

  const visual = visualSide === "right" ? greenPanel : photoPanel;
  const formSide = (
    <div className="flex min-h-screen flex-1 flex-col">
      <div className="p-6 lg:hidden">
        <Logo />
      </div>
      <div className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="w-full max-w-md">{children}</div>
      </div>
      <div className="px-6 pb-6">
        <Footer />
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-[#0b1120] text-slate-200">
      {visualSide === "right" ? (
        <>
          {formSide}
          {visual}
        </>
      ) : (
        <>
          {visual}
          {formSide}
        </>
      )}
    </div>
  );
};

export default AuthLayout;
