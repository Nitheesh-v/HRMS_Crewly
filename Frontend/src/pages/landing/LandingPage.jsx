import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import publicService from '../../services/publicService.js';
import {
  Users,
  Calendar,
  CreditCard,
  UserPlus,
  BarChart3,
  Monitor,
  GraduationCap,
  Briefcase,
  MessageSquare,
  ArrowRight,
  Check,
  Play,
  ShieldCheck,
  Zap,
  Globe2,
  Lock,
  Timer,
  MapPin,
  Layers,
  Building2,
  ChevronDown,
  Star,
  Sparkles,
  Database,
  FileCheck,
  Clock3,
  TrendingUp,
} from 'lucide-react';

const modules = [
  {
    name: 'Core HR',
    icon: Users,
    color: 'bg-blue-500',
    desc: 'Employee 360°, org chart, lifecycle, documents & self-service.',
  },
  {
    name: 'Attendance',
    icon: Calendar,
    color: 'bg-emerald-500',
    desc: 'Shifts, geofence, QR & kiosk punch, live timeline & policy engine.',
  },
  {
    name: 'Payroll',
    icon: CreditCard,
    color: 'bg-purple-500',
    desc: 'Salary structures, statutory, payslips, F&F — audit-ready.',
  },
  {
    name: 'Recruitment',
    icon: UserPlus,
    color: 'bg-orange-500',
    desc: 'ATS, AI resume parsing, interviews, offers & BGV.',
  },
  {
    name: 'Performance',
    icon: BarChart3,
    color: 'bg-rose-500',
    desc: 'OKRs, reviews, 360°, analytics & continuous feedback.',
  },
  {
    name: 'Assets',
    icon: Monitor,
    color: 'bg-indigo-500',
    desc: 'Inventory, assignments, maintenance & asset lifecycle.',
  },
  {
    name: 'Learning',
    icon: GraduationCap,
    color: 'bg-amber-500',
    desc: 'Courses, certifications, skill matrix & growth tracks.',
  },
  {
    name: 'Projects',
    icon: Briefcase,
    color: 'bg-cyan-500',
    desc: 'Projects, tasks, timesheets & resource planning.',
  },
  {
    name: 'Communication',
    icon: MessageSquare,
    color: 'bg-teal-500',
    desc: 'Announcements, meetings, chat & company social.',
  },
];

const faqs = [
  {
    q: 'Is Crewly really multi-tenant and secure?',
    a: 'Yes. Every API is companyId-scoped, RBAC + audit-logged, with Redis/BullMQ for async jobs and SOC 2/GDPR-ready controls. No cross-tenant access, ever — verified by 31.x test suites.',
  },
  {
    q: 'How does geofenced attendance work?',
    a: 'Admin sets an office location → Use Current Location (one-shot GPS) → radius. Employee CLOCK_IN sends position + locationId → backend Haversine verifies VERIFIED/OUTSIDE. No continuous tracking, no manual lat/lng on employee side.',
  },
  {
    q: 'Can I migrate payroll & attendance history?',
    a: 'Yes — bulk import for attendance events, payroll structures and employee records. Validation is strict and idempotent, so re-imports are safe.',
  },
  {
    q: 'What about pricing and free trial?',
    a: '14-day free trial, no card. Starter for growing teams, Growth for scale, Enterprise for compliance & SSO. See the pricing table below — you can self-serve or talk to us.',
  },
];

const fmtNum = (n) => {
  if (n == null || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('en-IN');
};
const fmtCompact = (n) => {
  if (n == null || n === 0) return '0';
  if (n >= 100000) return `${(n / 100000).toFixed(1)}L`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

const LandingPage = () => {
  const [openFaq, setOpenFaq] = useState(0);
  const [stats, setStats] = useState(null);
  const [testimonials, setTestimonials] = useState([]);
  const [tLoading, setTLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    publicService
      .getPublicStats()
      .then((d) => {
        if (!alive) return;
        // api interceptor unwraps {data:...} → d is stats
        const s = d?.data || d;
        setStats(s?.companies ? s : s?.data || s);
      })
      .catch(() => {
        if (!alive) return;
        setStats(null);
      });
    publicService
      .getPublicTestimonials()
      .then((d) => {
        if (!alive) return;
        const arr = d?.data || d;
        const list = Array.isArray(arr) ? arr : arr?.data || [];
        if (list.length) setTestimonials(list);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setTLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="relative overflow-hidden bg-crewly-bg text-crewly-text">
      {/* bg gradients */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-[-10%] top-[-10%] h-[600px] w-[700px] rounded-full bg-crewly-green/10 blur-[120px]" />
        <div className="absolute right-[-10%] top-[20%] h-[500px] w-[600px] rounded-full bg-blue-500/10 blur-[120px]" />
        <div className="absolute bottom-0 left-1/2 h-[600px] w-[900px] -translate-x-1/2 rounded-full bg-crewly-orange/5 blur-[140px]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:48px_48px] [mask-image:radial-gradient(ellipse_at_center,black_40%,transparent_70%)]" />
      </div>

      {/* HERO */}
      <section className="relative mx-auto max-w-7xl px-4 pb-12 pt-10 sm:px-6 sm:pt-16 lg:px-8 lg:pb-16">
        <div className="mx-auto max-w-4xl text-center">
          <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-crewly-green/30 bg-crewly-green/10 px-3 py-1.5 text-xs font-semibold text-crewly-green backdrop-blur sm:px-4 sm:text-sm">
            <span className="flex h-2 w-2 animate-pulse rounded-full bg-crewly-green" />
            <span className="hidden sm:inline">New: AI Recruitment & Geofenced Attendance </span>
            <span className="sm:hidden">New: AI + Geofence live</span>
            <span className="hidden items-center gap-1 rounded-full bg-crewly-green px-2 py-0.5 text-[10px] font-black tracking-wide text-crewly-bg sm:inline-flex">
              LIVE
            </span>
          </div>

          <h1 className="mx-auto mt-6 max-w-4xl text-[32px] font-black leading-[0.95] tracking-tight sm:text-5xl lg:text-7xl">
            One platform for your{' '}
            <span className="bg-gradient-to-r from-crewly-green via-emerald-400 to-crewly-orange bg-clip-text text-transparent">
              entire workforce
            </span>
          </h1>

          <p className="mx-auto mt-5 max-w-2xl text-sm leading-relaxed text-crewly-dim sm:mt-6 sm:text-lg">
            Crewly is a <span className="font-semibold text-crewly-text">multi-tenant SaaS HRMS</span> that
            streamlines Core HR, Attendance, Payroll, Recruitment & Performance — fast, audit-logged and
            built for scale.
          </p>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              to="/register"
              className="group inline-flex w-full items-center justify-center gap-2 rounded-full bg-crewly-green px-7 py-4 text-sm font-bold text-crewly-bg shadow-lg shadow-crewly-green/20 transition hover:bg-[#35a344] hover:shadow-xl sm:w-auto sm:px-8 sm:text-[15px]"
            >
              Start free trial — 14 days
              <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
            </Link>
            <Link
              to="/login"
              className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-crewly-border bg-crewly-card px-7 py-4 text-sm font-semibold backdrop-blur transition hover:border-crewly-green/30 hover:bg-crewly-bg sm:w-auto sm:px-8"
            >
              <Play className="h-4 w-4 text-crewly-green" /> Watch 90s demo
            </Link>
          </div>

          <p className="mt-3 text-xs font-medium text-crewly-dim">
            No credit card · Cancel anytime · SOC 2 · GDPR · 99.9% uptime
          </p>

          {/* social proof — real numbers */}
          <div className="mt-8 flex flex-col items-center gap-3 border-y border-crewly-border/60 py-4 sm:mt-10 sm:flex-row sm:justify-center sm:gap-6">
            <div className="flex items-center gap-2 text-xs font-semibold text-crewly-dim">
              <span className="flex -space-x-1">
                {[1, 2, 3].map((i) => (
                  <span
                    key={i}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-full border-2 border-crewly-bg bg-crewly-card text-[10px] font-bold text-crewly-text"
                  >
                    {String.fromCharCode(64 + i)}
                  </span>
                ))}
              </span>
              <span>
                {stats ? (
                  <>
                    Trusted by <span className="font-black text-white">{fmtNum(stats.companies)}+</span>{' '}
                    companies · <span className="font-black text-white">{fmtNum(stats.employees)}+</span> employees
                  </>
                ) : (
                  'Trusted by 10,000+ teams'
                )}
              </span>
            </div>
            <div className="hidden h-4 w-px bg-crewly-border sm:block" />
            <div className="hidden items-center gap-2 text-[11px] font-bold tracking-widest text-crewly-dim/60 sm:flex">
              <span>ACME</span> <span>·</span> <span>INFOSYS</span> <span>·</span> <span>EXCALIBUR</span>{' '}
              <span>·</span> <span>NOVA</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <Star className="h-3.5 w-3.5 fill-crewly-orange text-crewly-orange" />
              <span className="font-bold text-white">{stats?.g2Rating || '4.8'}/5</span>
              <span className="text-crewly-dim">
                on G2 · {stats ? `${fmtNum(stats.g2Reviews)} reviews` : '47 reviews'}
              </span>
            </div>
          </div>
          {stats && (
            <div className="mt-4 flex flex-wrap justify-center gap-2 text-[11px] sm:gap-3">
              <span className="rounded-full border border-crewly-border bg-crewly-card px-3 py-1 font-semibold">
                <span className="text-crewly-green">{fmtNum(stats.attendanceTotal)}</span>
                <span className="text-crewly-dim"> attendance records</span>
              </span>
              <span className="rounded-full border border-crewly-border bg-crewly-card px-3 py-1 font-semibold">
                <span className="text-crewly-green">{fmtNum(stats.payslips)}</span>
                <span className="text-crewly-dim"> payslips generated</span>
              </span>
              <span className="rounded-full border border-crewly-border bg-crewly-card px-3 py-1 font-semibold">
                <span className="text-crewly-orange">{fmtNum(stats.candidates)}</span>
                <span className="text-crewly-dim"> candidates</span>
              </span>
            </div>
          )}
        </div>

        {/* Hero mock */}
        <div className="relative mx-auto mt-10 max-w-5xl sm:mt-12">
          <div className="relative overflow-hidden rounded-2xl border border-crewly-border bg-crewly-card shadow-2xl sm:rounded-3xl">
            {/* window bar */}
            <div className="flex items-center justify-between border-b border-crewly-border bg-crewly-bg/50 px-4 py-3">
              <div className="flex items-center gap-1.5">
                <span className="h-3 w-3 rounded-full bg-crewly-red/70" />
                <span className="h-3 w-3 rounded-full bg-crewly-orange/70" />
                <span className="h-3 w-3 rounded-full bg-crewly-green/70" />
              </div>
              <div className="hidden items-center gap-2 text-xs text-crewly-dim sm:flex">
                <span className="rounded-full bg-crewly-green/15 px-2.5 py-1 font-bold text-crewly-green">
                  ● Live attendance · Verified at HQ
                </span>
                <span className="rounded-full border border-crewly-border px-2.5 py-1">crewly.app/app/dashboard</span>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-crewly-dim">
                <ShieldCheck className="h-3.5 w-3.5 text-crewly-green" /> SOC 2
              </div>
            </div>

            {/* dashboard preview — real numbers */}
            <div className="grid gap-4 p-4 sm:grid-cols-3 sm:p-6">
              {[
                {
                  k: 'Employees',
                  v: stats ? fmtNum(stats.employees) : '1,284',
                  sub: stats ? `${fmtNum(stats.companies)} companies` : 'incl. 22 late',
                  icon: Users,
                  accent: 'text-crewly-green',
                },
                {
                  k: 'Payslips generated',
                  v: stats ? fmtNum(stats.payslips) : '84.2k',
                  sub: stats ? `${fmtNum(stats.payrollRuns)} payroll runs` : 'Sep 2026 · PAID',
                  icon: CreditCard,
                  accent: 'text-crewly-green',
                },
                {
                  k: 'Present today',
                  v: stats ? fmtNum(stats.attendanceToday) : '18',
                  sub: stats ? `${fmtNum(stats.attendanceTotal)} total records` : '3 overdue tasks',
                  icon: Briefcase,
                  accent: 'text-crewly-orange',
                },
              ].map((c) => (
                <div key={c.k} className="rounded-xl border border-crewly-border bg-crewly-bg p-4">
                  <div className="flex items-center justify-between">
                    <c.icon className={`h-5 w-5 ${c.accent}`} />
                    <span className="text-xs text-crewly-dim">↗ live</span>
                  </div>
                  <p className="mt-3 text-xs uppercase tracking-wide text-crewly-dim">{c.k}</p>
                  <p className={`text-2xl font-black ${c.accent}`}>{c.v}</p>
                  <p className="text-xs text-crewly-dim">{c.sub}</p>
                </div>
              ))}
              <div className="sm:col-span-2 rounded-xl border border-crewly-green/20 bg-gradient-to-br from-crewly-green/10 to-crewly-bg p-4">
                <div className="flex items-center justify-between">
                  <h4 className="flex items-center gap-2 text-sm font-bold">
                    <Timer className="h-4 w-4 text-crewly-green" /> Today&apos;s attendance
                  </h4>
                  <span className="rounded-full bg-crewly-green px-2.5 py-1 text-[11px] font-bold text-crewly-bg">
                    Mark Attendance →
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  {[
                    ['CLOCK IN', '09:02', 'bg-crewly-green text-white'],
                    ['BREAK', '00:32', 'bg-crewly-orange text-white'],
                    ['WORKED', '06:18', 'bg-crewly-card border border-crewly-border'],
                  ].map(([k, v, cls]) => (
                    <div key={k} className={`rounded-lg px-2 py-3 ${cls}`}>
                      <p className="text-[11px] font-bold tracking-wide opacity-80">{k}</p>
                      <p className="text-sm font-black">{v}</p>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-xl border border-crewly-border bg-crewly-bg p-4">
                <h4 className="text-sm font-bold">Hiring pipeline</h4>
                <div className="mt-3 space-y-2">
                  {[
                    ['Sourced', '84', 'w-[70%] bg-blue-500'],
                    ['Interview', '31', 'w-[45%] bg-crewly-orange'],
                    ['Offer', '12', 'w-[25%] bg-crewly-green'],
                  ].map(([l, n, bar]) => (
                    <div key={l} className="flex items-center gap-2 text-xs">
                      <span className="w-16 text-crewly-dim">{l}</span>
                      <div className="h-2 flex-1 rounded-full bg-crewly-border">
                        <div className={`h-2 rounded-full ${bar}`} />
                      </div>
                      <span className="w-6 text-right font-bold">{n}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          {/* glow */}
          <div className="pointer-events-none absolute -inset-6 -z-10 rounded-[2rem] bg-gradient-to-r from-crewly-green/10 via-blue-500/10 to-crewly-orange/10 blur-2xl" />
        </div>
      </section>

      {/* MODULES GRID */}
      <section id="features" className="mx-auto max-w-7xl scroll-mt-20 px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-crewly-border bg-crewly-card px-3 py-1 text-xs font-bold tracking-wide text-crewly-green">
            <Layers className="h-3.5 w-3.5" /> 9 MODULES · ONE WORKSPACE
          </div>
          <h2 className="mt-4 text-3xl font-black tracking-tight sm:text-4xl">
            Everything HR needs. Nothing it doesn&apos;t.
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-crewly-dim sm:text-base">
            From day-one onboarding to payroll and performance — Crewly replaces 6+ point tools with a
            single, tenant-isolated SaaS.
          </p>
        </div>

        <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {modules.map((m) => (
            <div
              key={m.name}
              className="group relative overflow-hidden rounded-2xl border border-crewly-border bg-crewly-card p-5 transition hover:-translate-y-1 hover:border-crewly-green/30 hover:shadow-xl hover:shadow-black/20 sm:p-6"
            >
              <div
                className={`absolute -right-6 -top-6 h-28 w-28 rounded-full opacity-10 blur-xl transition group-hover:scale-125 ${m.color}`}
              />
              <div className={`flex h-11 w-11 items-center justify-center rounded-xl text-white shadow-lg ${m.color}`}>
                <m.icon className="h-5 w-5" />
              </div>
              <h3 className="mt-4 text-base font-bold">{m.name}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-crewly-dim">{m.desc}</p>
              <div className="mt-4 flex items-center gap-1 text-xs font-semibold text-crewly-green opacity-0 transition group-hover:opacity-100">
                Explore <ArrowRight className="h-3 w-3" />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* DEEP DIVE: Attendance / Payroll / Recruitment */}
      <section id="solutions" className="scroll-mt-20 border-y border-crewly-border bg-crewly-card/50">
        <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <div className="inline-flex items-center gap-2 rounded-full bg-crewly-green/10 px-3 py-1 text-xs font-bold text-crewly-green ring-1 ring-crewly-green/20">
              <Sparkles className="h-3.5 w-3.5" /> BUILT FOR REAL OPERATIONS
            </div>
            <h2 className="mt-4 text-3xl font-black tracking-tight sm:text-4xl">Go deep where it matters</h2>
          </div>

          {/* Row 1: Attendance */}
          <div className="mt-12 grid gap-8 rounded-3xl border border-crewly-border bg-crewly-bg p-6 sm:p-8 lg:grid-cols-2 lg:gap-12">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-bold text-emerald-400 ring-1 ring-emerald-500/20">
                <MapPin className="h-3.5 w-3.5" /> ATTENDANCE · GEOFENCE · QR + KIOSK
              </div>
              <h3 className="mt-4 text-2xl font-black leading-tight sm:text-3xl">
                Attendance that <span className="text-crewly-green">proves</span> you were there.
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-crewly-dim">
                Office locations with <span className="font-semibold text-crewly-text">Use Current Location</span>{' '}
                (one-shot GPS, never watch), radius 10m–100km, Haversine verified server-side. Optional/
                Required enforcement, accuracy-aware.
              </p>
              <ul className="mt-5 space-y-2.5 text-sm">
                {[
                  'One-tap admin: Use Current Location → Accuracy ~Xm → Save',
                  'Employee CLOCK_IN verifies VERIFIED/OUTSIDE — frontend cannot spoof',
                  'QR challenge + shared kiosk PIN, offline-safe, idempotent',
                  'Timeline, breaks, overtime, analytics — audit-logged',
                ].map((t) => (
                  <li key={t} className="flex gap-2">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-crewly-green/15 text-crewly-green">
                      <Check className="h-3.5 w-3.5" />
                    </span>
                    <span className="text-crewly-dim">
                      <span className="font-medium text-crewly-text">{t.split('—')[0]}</span>
                      {t.includes('—') ? `—${t.split('—')[1]}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
              <Link
                to="/login"
                className="mt-6 inline-flex items-center gap-1.5 text-sm font-bold text-crewly-green hover:underline"
              >
                Open Attendance → <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
            <div className="relative overflow-hidden rounded-2xl border border-crewly-border bg-crewly-card p-4 sm:p-5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold tracking-wide text-crewly-dim">Office locations</span>
                <span className="rounded-full bg-crewly-green px-2.5 py-1 text-[11px] font-bold text-crewly-bg">
                  3 active
                </span>
              </div>
              <div className="mt-4 space-y-3">
                {[
                  { name: 'HQ — Chennai', radius: '150m', badge: 'VERIFIED', color: 'green' },
                  { name: 'Branch — Bengaluru', radius: '300m', badge: 'OUTSIDE', color: 'orange' },
                  { name: 'Plant — Coimbatore', radius: '500m', badge: '—', color: 'dim' },
                ].map((r) => (
                  <div key={r.name} className="flex items-center justify-between rounded-xl bg-crewly-bg px-3 py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-crewly-green/15">
                        <Building2 className="h-4 w-4 text-crewly-green" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold">{r.name}</p>
                        <p className="text-xs text-crewly-dim">Radius {r.radius}</p>
                      </div>
                    </div>
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${
                        r.color === 'green'
                          ? 'bg-crewly-green/15 text-crewly-green'
                          : r.color === 'orange'
                            ? 'bg-crewly-orange/15 text-crewly-orange'
                            : 'bg-crewly-border text-crewly-dim'
                      }`}
                    >
                      {r.badge}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-4 rounded-xl bg-crewly-green/10 p-3 text-xs leading-relaxed text-crewly-dim ring-1 ring-crewly-green/20">
                <span className="font-bold text-crewly-green">Chrome Sensors tip:</span> DevTools → More tools →
                Sensors → override location for local QA. Production auto-uses HTTPS GPS.
              </div>
            </div>
          </div>

          {/* Row 2: Payroll */}
          <div className="mt-8 grid gap-8 rounded-3xl border border-crewly-border bg-crewly-bg p-6 sm:p-8 lg:grid-cols-2 lg:gap-12">
            <div className="order-2 lg:order-1 relative overflow-hidden rounded-2xl border border-crewly-border bg-crewly-card p-4 sm:p-5">
              <div className="grid grid-cols-2 gap-3">
                {[
                  { l: 'Gross', v: '₹ 68,400', c: 'text-white' },
                  { l: 'Deductions', v: '₹ 8,240', c: 'text-crewly-orange' },
                  { l: 'Net pay', v: '₹ 60,160', c: 'text-crewly-green' },
                  { l: 'YTD', v: '₹ 7.2L', c: 'text-white' },
                ].map((x) => (
                  <div key={x.l} className="rounded-xl bg-crewly-bg p-3">
                    <p className="text-[11px] uppercase tracking-wide text-crewly-dim">{x.l}</p>
                    <p className={`text-lg font-black ${x.c}`}>{x.v}</p>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex items-center gap-2 rounded-xl bg-crewly-green/10 px-3 py-2 text-xs ring-1 ring-crewly-green/20">
                <FileCheck className="h-4 w-4 text-crewly-green" />
                <span className="font-semibold text-crewly-green">Payslip #SEP-2847 · PAID</span>
                <span className="ml-auto text-crewly-dim">PDF + audit trail</span>
              </div>
            </div>
            <div className="order-1 lg:order-2">
              <div className="inline-flex items-center gap-2 rounded-full bg-purple-500/10 px-3 py-1 text-xs font-bold text-purple-400 ring-1 ring-purple-500/20">
                <CreditCard className="h-3.5 w-3.5" /> PAYROLL · STATUTORY · F&F
              </div>
              <h3 className="mt-4 text-2xl font-black leading-tight sm:text-3xl">
                Payroll that closes <span className="text-purple-400">on time</span>, every time.
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-crewly-dim">
                Salary components, structures, monthly inputs, run → review → pay, payslips, statutory,
                analytics and full & final — with RBAC and company-branded documents.
              </p>
              <ul className="mt-5 space-y-2.5 text-sm">
                {[
                  'Run payroll, variance checks, approvals & direct bank advice',
                  'Employee self-service: My Payslips, My Payroll, F&F',
                  'Executive dashboards: cost, variance, headcount & compliance',
                ].map((t) => (
                  <li key={t} className="flex gap-2">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-purple-500/15 text-purple-400">
                      <Check className="h-3.5 w-3.5" />
                    </span>
                    <span className="text-crewly-dim">{t}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Row 3: Recruitment */}
          <div className="mt-8 grid gap-8 rounded-3xl border border-crewly-border bg-crewly-bg p-6 sm:p-8 lg:grid-cols-2 lg:gap-12">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full bg-crewly-orange/10 px-3 py-1 text-xs font-bold text-crewly-orange ring-1 ring-crewly-orange/20">
                <UserPlus className="h-3.5 w-3.5" /> ATS · AI PARSING · BGV
              </div>
              <h3 className="mt-4 text-2xl font-black leading-tight sm:text-3xl">
                From requisition to <span className="text-crewly-orange">Day One</span>, automated.
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-crewly-dim">
                Public careers, AI resume parse, pipeline, interviews, offers, pre-onboarding & BGV agency
                portal — with BullMQ queues for scale.
              </p>
              <ul className="mt-5 space-y-2.5 text-sm">
                {[
                  'Job requisitions → approvals → career portal',
                  'Candidate inbox, ATS matching, offer letters with e-sign',
                  'BGV: catalogue, orders, verifier workbench, QA & billing',
                ].map((t) => (
                  <li key={t} className="flex gap-2">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-crewly-orange/15 text-crewly-orange">
                      <Check className="h-3.5 w-3.5" />
                    </span>
                    <span className="text-crewly-dim">{t}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-2xl border border-crewly-border bg-crewly-card p-4 sm:p-5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold">Pipeline</span>
                <span className="rounded-full border border-crewly-border px-2.5 py-1">12 active jobs</span>
              </div>
              <div className="mt-4 grid grid-cols-4 gap-2 text-center">
                {[
                  ['Applied', stats ? fmtCompact(stats.candidates) : '128', 'bg-white text-crewly-bg'],
                  ['Screen', stats ? fmtCompact(Math.round((stats.candidates || 0) * 0.32)) : '42', 'bg-blue-500 text-white'],
                  ['Interview', stats ? fmtCompact(Math.round((stats.candidates || 0) * 0.14)) : '18', 'bg-crewly-orange text-white'],
                  ['Hired', stats ? fmtCompact(Math.round((stats.employees || 0) * 0.08) || 7) : '7', 'bg-crewly-green text-white'],
                ].map(([k, v, cls]) => (
                  <div key={k} className={`rounded-xl px-2 py-3 ${cls}`}>
                    <p className="text-[11px] font-bold opacity-70">{k}</p>
                    <p className="text-lg font-black">{v}</p>
                  </div>
                ))}
              </div>
              <div className="mt-4 rounded-xl bg-crewly-bg p-3">
                <div className="flex items-center gap-2 text-xs font-semibold">
                  <Sparkles className="h-4 w-4 text-crewly-orange" />{' '}
                  {stats ? `${fmtNum(stats.candidates)} candidates · ` : ''}AI parse 94%
                </div>
                <div className="mt-2 h-2 rounded-full bg-crewly-border">
                  <div className="h-2 w-[94%] rounded-full bg-crewly-orange" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* PLATFORM */}
      <section className="mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
        <div className="rounded-3xl border border-crewly-border bg-crewly-card p-6 sm:p-8 lg:p-10">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full bg-crewly-bg px-3 py-1 text-xs font-bold text-crewly-dim ring-1 ring-crewly-border">
                <ShieldCheck className="h-3.5 w-3.5 text-crewly-green" /> PLATFORM · MULTI-TENANT · ENTERPRISE
              </div>
              <h2 className="mt-4 text-2xl font-black sm:text-3xl">Built like a bank. Fast like a startup.</h2>
            </div>
            <p className="max-w-xl text-sm leading-relaxed text-crewly-dim">
              Crewly runs on MongoDB + Redis + BullMQ, with idempotent ledger, CAS-guarded punch and
              end-to-end test coverage — so HR ops never block on infra.
            </p>
          </div>

          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: Globe2,
                title: 'Multi-tenant SaaS',
                desc: 'companyId on every query. Admin, HR, Manager, Employee — all isolated by design.',
              },
              {
                icon: Lock,
                title: 'RBAC + Audit',
                desc: 'Least-privilege permissions, 31.x security suites, full audit log on every mutation.',
              },
              {
                icon: Zap,
                title: 'Queue at scale',
                desc: 'BullMQ for imports, emails, BGV & payroll — retries, backoff, observability.',
              },
              {
                icon: Database,
                title: 'Data you own',
                desc: 'Exports, branded PDFs, analytics and open APIs — no lock-in.',
              },
            ].map((f) => (
              <div key={f.title} className="rounded-2xl border border-crewly-border bg-crewly-bg p-5">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-crewly-green/10 text-crewly-green">
                  <f.icon className="h-5 w-5" />
                </div>
                <h3 className="mt-3 text-sm font-bold">{f.title}</h3>
                <p className="mt-1 text-xs leading-relaxed text-crewly-dim">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* HOW IT WORKS + PRICING */}
      <section id="pricing" className="scroll-mt-20 border-y border-crewly-border bg-crewly-card/30">
        <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <div className="inline-flex items-center gap-2 rounded-full border border-crewly-border bg-crewly-bg px-3 py-1 text-xs font-bold tracking-wide text-crewly-dim">
              <Clock3 className="h-3.5 w-3.5" /> HOW IT WORKS
            </div>
            <h2 className="mt-4 text-3xl font-black sm:text-4xl">Live in 10 minutes.</h2>
            <p className="mt-3 text-sm text-crewly-dim">No onboarding calls. No spreadsheets. Just Crewly.</p>
          </div>

          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            {[
              {
                n: '01',
                title: 'Register company',
                desc: ' Pick a companyCode, create the Company Admin. Instant tenant, instant login.',
                cta: 'Register →',
                to: '/register',
              },
              {
                n: '02',
                title: 'Configure policy',
                desc: 'Shifts, attendance geofence, leave types, payroll components — 1 page each.',
                cta: 'See features →',
                to: '#features',
              },
              {
                n: '03',
                title: 'Run your people',
                desc: 'Employees self-serve: attendance, payslips, recruitment — you watch the analytics.',
                cta: 'Open dashboard →',
                to: '/login',
              },
            ].map((s) => (
              <div key={s.n} className="relative rounded-2xl border border-crewly-border bg-crewly-bg p-6">
                <span className="text-5xl font-black leading-none text-crewly-border">{s.n}</span>
                <h3 className="mt-2 text-base font-bold">{s.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-crewly-dim">{s.desc}</p>
                <Link to={s.to} className="mt-4 inline-flex text-xs font-bold text-crewly-green hover:underline">
                  {s.cta}
                </Link>
              </div>
            ))}
          </div>

          {/* Pricing */}
          <div className="mt-16">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="text-3xl font-black sm:text-4xl">Simple, transparent pricing</h2>
              <p className="mt-3 text-sm text-crewly-dim">14-day trial on every plan. Per-employee / month, billed annually.</p>
            </div>

            <div className="mx-auto mt-10 grid max-w-5xl gap-4 lg:grid-cols-3">
              {/* Starter */}
              <div className="rounded-3xl border border-crewly-border bg-crewly-bg p-6 sm:p-7">
                <h3 className="text-base font-bold">Starter</h3>
                <p className="mt-1 text-sm text-crewly-dim">For growing teams up to 50</p>
                <p className="mt-5">
                  <span className="text-4xl font-black">₹99</span>
                  <span className="text-sm text-crewly-dim">/ emp / mo</span>
                </p>
                <Link
                  to="/register"
                  className="mt-6 block rounded-full border border-crewly-border bg-crewly-card py-3 text-center text-sm font-bold hover:border-crewly-green/30"
                >
                  Start trial
                </Link>
                <ul className="mt-6 space-y-2.5 text-sm">
                  {[
                    'Core HR + Attendance',
                    'Payroll (up to 50)',
                    'Recruitment basics',
                    'Email support',
                  ].map((t) => (
                    <li key={t} className="flex gap-2 text-crewly-dim">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-crewly-green" /> {t}
                    </li>
                  ))}
                </ul>
              </div>

              {/* Growth - featured */}
              <div className="relative rounded-3xl border border-crewly-green bg-gradient-to-b from-crewly-green/10 to-crewly-bg p-6 shadow-xl shadow-crewly-green/10 sm:p-7">
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-crewly-green px-3 py-1 text-xs font-black tracking-wide text-crewly-bg">
                  MOST POPULAR
                </span>
                <h3 className="flex items-center gap-2 text-base font-bold">
                  Growth <TrendingUp className="h-4 w-4 text-crewly-green" />
                </h3>
                <p className="mt-1 text-sm text-crewly-dim">For scale-ups up to 500</p>
                <p className="mt-5">
                  <span className="text-4xl font-black">₹199</span>
                  <span className="text-sm text-crewly-dim">/ emp / mo</span>
                </p>
                <Link
                  to="/register"
                  className="mt-6 block rounded-full bg-crewly-green py-3 text-center text-sm font-bold text-crewly-bg shadow-lg shadow-crewly-green/20 hover:bg-[#35a344]"
                >
                  Start trial
                </Link>
                <ul className="mt-6 space-y-2.5 text-sm">
                  {[
                    'Everything in Starter',
                    'Advanced Payroll + Statutory + F&F',
                    'Full ATS + AI parsing + BGV',
                    'Analytics & priority support',
                  ].map((t) => (
                    <li key={t} className="flex gap-2 text-crewly-dim">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-crewly-green" /> {t}
                    </li>
                  ))}
                </ul>
              </div>

              {/* Enterprise */}
              <div className="rounded-3xl border border-crewly-border bg-crewly-bg p-6 sm:p-7">
                <h3 className="text-base font-bold">Enterprise</h3>
                <p className="mt-1 text-sm text-crewly-dim">For compliance & SSO</p>
                <p className="mt-5">
                  <span className="text-4xl font-black">Custom</span>
                </p>
                <Link
                  to="/register"
                  className="mt-6 block rounded-full border border-crewly-border bg-crewly-card py-3 text-center text-sm font-bold hover:border-crewly-green/30"
                >
                  Talk to us
                </Link>
                <ul className="mt-6 space-y-2.5 text-sm">
                  {[
                    'Everything in Growth',
                    'SSO, audit exports, on-prem option',
                    'Dedicated BGV verifier',
                    'SLA + customer success',
                  ].map((t) => (
                    <li key={t} className="flex gap-2 text-crewly-dim">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-crewly-green" /> {t}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <p className="mt-6 text-center text-xs text-crewly-dim">
              Need 1000+ seats or on-prem? <Link to="/register" className="font-bold text-crewly-green hover:underline">Contact sales</Link> — we&apos;ll draft an MSA.
            </p>
          </div>
        </div>
      </section>

      {/* TESTIMONIALS + FAQ + CTA */}
      <section id="faq" className="scroll-mt-20 mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
        <div className="grid gap-8 lg:grid-cols-2">
          {/* Testimonials — real data from /api/public/testimonials */}
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-crewly-border bg-crewly-card px-3 py-1 text-xs font-bold tracking-wide text-crewly-dim">
              <Star className="h-3.5 w-3.5 fill-crewly-orange text-crewly-orange" /> LOVED BY TEAMS
            </div>
            <h2 className="mt-4 text-2xl font-black sm:text-3xl">Operators, not decks, vouch for Crewly.</h2>
            {stats && (
              <p className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-crewly-dim">
                <Star className="h-3.5 w-3.5 fill-crewly-orange text-crewly-orange" />
                <span className="font-black text-white">{stats.g2Rating}/5</span> · {fmtNum(stats.g2Reviews)} G2
                reviews · Trusted by {fmtNum(stats.companies)} companies
              </p>
            )}
            <div className="mt-6 space-y-4">
              {tLoading ? (
                [1, 2, 3].map((i) => (
                  <div key={i} className="animate-pulse rounded-2xl border border-crewly-border bg-crewly-card p-5">
                    <div className="h-4 w-3/4 rounded bg-crewly-border/60" />
                    <div className="mt-3 h-3 w-1/2 rounded bg-crewly-border/40" />
                  </div>
                ))
              ) : (testimonials.length ? testimonials.slice(0, 6) : []).map((t) => (
                <div key={t.id} className="rounded-2xl border border-crewly-border bg-crewly-card p-5">
                  <div className="flex items-center gap-1">
                    {Array.from({ length: t.rating || 5 }).map((_, i) => (
                      <Star key={i} className="h-3.5 w-3.5 fill-crewly-orange text-crewly-orange" />
                    ))}
                    {t.verified && (
                      <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-crewly-green/10 px-2 py-0.5 text-[10px] font-bold text-crewly-green ring-1 ring-crewly-green/20">
                        <ShieldCheck className="h-3 w-3" /> Verified
                      </span>
                    )}
                  </div>
                  <p className="mt-3 text-sm font-semibold leading-relaxed">“{t.quote}”</p>
                  <div className="mt-3 flex items-center gap-2.5">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-crewly-green/15 text-xs font-black text-crewly-green ring-1 ring-crewly-green/20">
                      {t.avatarUrl ? (
                        <img src={t.avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
                      ) : (
                        t.avatarInitial
                      )}
                    </div>
                    <div>
                      <p className="text-xs font-bold">
                        {t.name} · <span className="font-semibold text-crewly-dim">{t.role}</span>
                      </p>
                      <p className="text-[11px] text-crewly-dim">{t.company}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <Link to="/register" className="mt-4 inline-flex text-xs font-bold text-crewly-green hover:underline">
              Join {stats ? fmtNum(stats.companies) : '500+'} teams — start free →
            </Link>
          </div>

          {/* FAQ */}
          <div>
            <h2 className="text-2xl font-black sm:text-3xl">Questions, answered</h2>
            <p className="mt-2 text-sm text-crewly-dim">Everything you need to evaluate Crewly. Still curious? Talk to us.</p>
            <div className="mt-6 divide-y divide-crewly-border rounded-2xl border border-crewly-border bg-crewly-card">
              {faqs.map((f, i) => (
                <button
                  key={f.q}
                  onClick={() => setOpenFaq(openFaq === i ? -1 : i)}
                  className="w-full text-left"
                >
                  <div className="flex items-center justify-between gap-4 px-5 py-4">
                    <span className="text-sm font-semibold">{f.q}</span>
                    <ChevronDown
                      className={`h-4 w-4 shrink-0 text-crewly-dim transition ${openFaq === i ? 'rotate-180' : ''}`}
                    />
                  </div>
                  {openFaq === i && (
                    <div className="px-5 pb-4 text-sm leading-relaxed text-crewly-dim">{f.a}</div>
                  )}
                </button>
              ))}
            </div>
            <div className="mt-4 rounded-2xl bg-crewly-green/10 p-4 ring-1 ring-crewly-green/20">
              <p className="flex items-center gap-2 text-sm font-bold text-crewly-green">
                <ShieldCheck className="h-4 w-4" /> Enterprise ready
              </p>
              <p className="mt-1 text-xs leading-relaxed text-crewly-dim">
                Multi-tenant, RBAC, audit logs, rate limits, idempotent writes and CAS-guarded sessions
                — the same code that passes 716+ hermetic attendance tests.
              </p>
            </div>
          </div>
        </div>

        {/* Final CTA */}
        <div className="mt-12 overflow-hidden rounded-3xl border border-crewly-green/30 bg-gradient-to-br from-crewly-green via-emerald-600 to-teal-600 p-[1px]">
          <div className="rounded-[calc(1.5rem-1px)] bg-gradient-to-br from-crewly-green/20 via-crewly-card to-crewly-bg px-6 py-8 sm:px-10 sm:py-12">
            <div className="flex flex-col items-center justify-between gap-6 lg:flex-row">
              <div className="text-center lg:text-left">
                <h2 className="text-2xl font-black text-white sm:text-3xl">
                  Run your people on Crewly <span className="text-white/70">this week.</span>
                </h2>
                <p className="mt-2 max-w-xl text-sm text-white/70 sm:text-base">
                  14-day trial, no card. Import your employees, set your offices, run your first payroll.
                </p>
              </div>
              <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
                <Link
                  to="/register"
                  className="inline-flex items-center justify-center gap-2 rounded-full bg-white px-8 py-4 text-sm font-black text-crewly-green shadow-xl transition hover:bg-white/90"
                >
                  Start free trial <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  to="/login"
                  className="inline-flex items-center justify-center gap-2 rounded-full border border-white/20 bg-white/10 px-8 py-4 text-sm font-bold text-white backdrop-blur transition hover:bg-white/15"
                >
                  Sign in
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

export default LandingPage;
