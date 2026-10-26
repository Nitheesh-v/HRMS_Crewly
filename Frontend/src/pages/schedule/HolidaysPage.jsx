import { useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  CalendarRange,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Gift,
  Info,
  Link2,
  List,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useSelector } from 'react-redux';
import scheduleService from '../../services/scheduleService';
import { notify } from '../../utils/notify.js';
import EmptyState from '../../components/common/EmptyState.jsx';

const HR = ['COMPANY_ADMIN', 'HR_MANAGER'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const TYPES = [
  {
    key: 'COMPANY',
    label: 'Company wide',
    count: 0,
    dot: 'bg-st-secondary',
    tag: 'bg-st-secondary-fixed/50 text-st-on-secondary-fixed hover:bg-st-secondary-fixed',
    cell: 'bg-st-secondary-container/50 hover:bg-st-secondary-container/80',
    chip: 'bg-st-secondary text-st-on-secondary',
    text: 'text-st-secondary',
  },
  {
    key: 'BRANCH',
    label: 'Branch specific',
    dot: 'bg-st-outline',
    tag: 'bg-st-highest text-st-on hover:bg-st-surface-dim',
    cell: 'bg-st-container/60 hover:bg-st-container',
    chip: 'bg-st-highest text-st-on',
    text: 'text-st-on-variant',
  },
  {
    key: 'DEPARTMENT',
    label: 'Department',
    dot: 'bg-st-primary',
    tag: 'bg-st-primary-fixed/60 text-st-on-primary-fixed hover:bg-st-primary-fixed',
    cell: 'bg-st-primary-fixed/30 hover:bg-st-primary-fixed/60',
    chip: 'bg-st-primary text-st-on-primary',
    text: 'text-st-primary',
  },
  {
    key: 'OPTIONAL',
    label: 'Floating / optional',
    dot: 'bg-st-tertiary',
    tag: 'bg-st-tertiary-fixed/60 text-st-on-tertiary-fixed hover:bg-st-tertiary-fixed',
    cell: 'bg-st-tertiary-fixed/30 hover:bg-st-tertiary-fixed/60',
    chip: 'bg-st-tertiary text-st-on-tertiary',
    text: 'text-st-tertiary',
  },
  {
    key: 'PUBLIC',
    label: 'Public / statutory',
    dot: 'bg-st-error',
    tag: 'bg-st-error-container/70 text-st-on-error-container hover:bg-st-error-container',
    cell: 'bg-st-error-container/40 hover:bg-st-error-container/60',
    chip: 'bg-st-error text-st-on-error',
    text: 'text-st-error',
  },
];
const META = Object.fromEntries(TYPES.map((t) => [t.key, t]));

const dstr = (d) => d.toISOString().slice(0, 10);
const fmtDay = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
};
const fmtWeekday = (iso) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString([], { weekday: 'long' });

const emptyForm = {
  name: '',
  type: 'COMPANY',
  date: '',
  endDate: '',
  description: '',
  branch: '',
  departments: [],
  isOptional: false,
  recurringYearly: false,
};

const HolidaysPage = () => {
  const user = useSelector((s) => s.auth.user);
  const isHR = HR.includes(user?.role);
  const now = new Date();
  const [view, setView] = useState('month');
  const [year, setYear] = useState(now.getUTCFullYear());
  const [month, setMonth] = useState(now.getUTCMonth() + 1);
  const [typeFilter, setTypeFilter] = useState('');
  const [query, setQuery] = useState('');
  const [holidays, setHolidays] = useState([]);
  const [mine, setMine] = useState([]);
  const [upcoming, setUpcoming] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const params = view === 'month' ? { year, month } : { year };
      if (isHR) params.scope = 'all';
      if (typeFilter) params.type = typeFilter;
      const d = await scheduleService.listHolidays(params);
      setHolidays(d.holidays || []);
      const personal = await scheduleService.listHolidays({ year });
      setMine(personal.holidays || []);
      const up = await scheduleService.upcoming(150);
      setUpcoming((up.holidays || []).slice(0, 6));
    } catch {
      /* api.js reports every failed request */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => {
      if (alive) load();
    });
    return () => {
      alive = false;
    };
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [view, year, month, typeFilter, isHR]);

  useEffect(() => {
    let alive = true;
    if (!isHR) return undefined;
    scheduleService.getDepartments().then((d) => {
      if (alive) setDepartments(d.departments || []);
    });
    return () => {
      alive = false;
    };
  }, [isHR]);

  const byDate = useMemo(() => {
    const map = {};
    holidays.forEach((h) => {
      const dates = h.dates && h.dates.length ? h.dates : [h.date];
      dates.forEach((d) => {
        const key = String(d || '').slice(0, 10);
        if (key) (map[key] = map[key] || []).push(h);
      });
    });
    return map;
  }, [holidays]);

  const counts = useMemo(() => {
    const base = Object.fromEntries(TYPES.map((t) => [t.key, 0]));
    holidays.forEach((h) => {
      if (base[h.type] !== undefined) base[h.type] += 1;
    });
    return base;
  }, [holidays]);

  const monthStats = useMemo(() => {
    const inMonth = holidays.filter(
      (h) => String(h.date).slice(0, 7) === `${year}-${String(month).padStart(2, '0')}`,
    );
    return {
      public: inMonth.filter((h) => h.type === 'PUBLIC').length,
      company: inMonth.filter((h) => h.type === 'COMPANY').length,
      optional: inMonth.filter((h) => h.type === 'OPTIONAL').length,
    };
  }, [holidays, year, month]);

  const cells = useMemo(() => {
    const first = new Date(Date.UTC(year, month - 1, 1));
    const start = first.getUTCDay();
    const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const arr = [];
    for (let i = 0; i < start; i += 1) {
      const prev = new Date(Date.UTC(year, month - 1, 1 - (start - i)));
      arr.push({ key: `pre-${i}`, date: dstr(prev), outside: true, day: prev.getUTCDate() });
    }
    for (let d = 1; d <= dim; d += 1) {
      const date = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      arr.push({ key: date, date, outside: false, day: d });
    }
    while (arr.length % 7) {
      const last = new Date(`${arr[arr.length - 1].date}T00:00:00Z`);
      last.setUTCDate(last.getUTCDate() + 1);
      arr.push({ key: `post-${arr.length}`, date: dstr(last), outside: true, day: last.getUTCDate() });
    }
    return arr;
  }, [year, month]);

  const filteredList = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return holidays
      .filter((h) => (typeFilter ? h.type === typeFilter : true))
      .filter((h) =>
        needle
          ? `${h.name} ${h.branch || ''} ${(h.departments || []).map((d) => d.name).join(' ')}`
              .toLowerCase()
              .includes(needle)
          : true,
      )
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }, [holidays, typeFilter, query]);

  const nav = (dir) => {
    let m = month + dir;
    let y = year;
    if (m < 1) {
      m = 12;
      y -= 1;
    }
    if (m > 12) {
      m = 1;
      y += 1;
    }
    setMonth(m);
    setYear(y);
  };

  const openCreate = () => setModal({ mode: 'create', form: { ...emptyForm, date: dstr(new Date()) } });
  const openEdit = (h) =>
    setModal({
      mode: 'edit',
      id: h.id,
      form: {
        name: h.name,
        type: h.type === 'OPTIONAL' ? 'COMPANY' : h.type,
        date: String(h.date).slice(0, 10),
        endDate: String(h.endDate || h.date).slice(0, 10),
        description: h.description || '',
        branch: h.branch || '',
        departments: (h.departments || []).map((d) => d.id || d),
        isOptional: !!h.isOptional,
        recurringYearly: !!h.recurringYearly,
      },
    });

  const save = async () => {
    setSaving(true);
    try {
      const f = modal.form;
      const payload = { ...f, endDate: f.endDate || f.date };
      const r =
        modal.mode === 'create'
          ? await scheduleService.createHoliday(payload)
          : await scheduleService.updateHoliday(modal.id, payload);
      notify.successFrom(r, 'Holiday saved.');
      setModal(null);
      load();
    } catch {
      /* api.js reports every failed request */
    }
    setSaving(false);
  };

  const deactivate = async (h) => {
    if (!window.confirm(`Deactivate “${h.name}”?`)) return;
    try {
      const r = await scheduleService.deleteHoliday(h.id);
      notify.successFrom(r, 'Holiday deactivated.');
      load();
    } catch {
      /* api.js reports every failed request */
    }
  };

  const togglePick = async (h) => {
    try {
      const r = h.picked ? await scheduleService.unpick(h.id) : await scheduleService.pick(h.id);
      notify.successFrom(r, h.picked ? 'Removed from your holidays.' : 'Holiday claimed.');
      load();
    } catch {
      /* api.js reports every failed request */
    }
  };

  const optionalMine = mine.filter((h) => h.isOptional);
  const claimed = optionalMine.filter((h) => h.picked).length;

  const nextOptional = useMemo(() => {
    const today = dstr(new Date());
    return (
      [...optionalMine]
        .filter((h) => String(h.date).slice(0, 10) >= today && !h.picked)
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0] || null
    );
  }, [optionalMine]);

  const upcomingList = useMemo(() => {
    const today = dstr(new Date());
    return [...upcoming]
      .filter((h) => String(h.date).slice(0, 10) >= today)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(0, 3);
  }, [upcoming]);

  const yearMonths = useMemo(
    () =>
      MONTHS.map((name, index) => ({
        name,
        month: index + 1,
        items: holidays
          .filter((h) => String(h.date).slice(0, 7) === `${year}-${String(index + 1).padStart(2, '0')}`)
          .sort((a, b) => String(a.date).localeCompare(String(b.date))),
      })),
    [holidays, year],
  );

  const cellCounts = (key) => counts[key] || 0;
  const nextQuarter = `Q${Math.floor((month - 1) / 3) + 1}`;

  return (
    <div className="st-surface min-h-screen">
      <div className="flex flex-col gap-6">
        {/* ── header deck ───────────────────────────────────────────────── */}
        <div className="flex flex-col justify-between gap-4 rounded-xl bg-st-lowest p-6 shadow-sm lg:flex-row lg:items-center">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-st-secondary-container px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider text-st-on-secondary-container">
                Time &amp; leave
              </span>
              <span className="text-xs font-medium text-st-on-variant">
                • Fiscal year {year}
                {loading ? ' · reading…' : ''}
              </span>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-st-on lg:text-3xl">Holiday calendar</h1>
            <p className="max-w-2xl text-sm font-normal text-st-on-variant">
              Company • branch • department • optional &amp; public holidays, regional statutory
              compliances, and floating quotas.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center rounded-lg bg-st-low p-1">
              {[
                ['month', 'Month', CalendarDays],
                ['year', 'Year', CalendarRange],
                ['list', 'List view', List],
              ].map(([key, label, Icon]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setView(key)}
                  className={`flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-xs transition-all ${
                    view === key
                      ? 'bg-st-lowest font-semibold text-st-primary shadow-sm'
                      : 'font-medium text-st-on-variant hover:text-st-on'
                  }`}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>

            <label className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-st-outline"
                aria-hidden="true"
              />
              <input
                className="w-44 appearance-none rounded-lg bg-st-low py-2 pl-9 pr-3 text-xs font-semibold text-st-on placeholder:text-st-on-variant/60 focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                placeholder="Search holidays…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search holidays"
              />
            </label>

            {isHR ? (
              <button
                type="button"
                onClick={openCreate}
                className="flex items-center gap-2 rounded-lg bg-st-primary px-4 py-2 text-xs font-bold text-st-on-primary shadow-sm transition-all hover:bg-st-primary-container hover:text-st-on-primary-container"
              >
                <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
                Add holiday
              </button>
            ) : null}
          </div>
        </div>

        {/* ── filter tags ───────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-st-low px-5 py-3">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-st-on-variant">
              Filter tags:
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {TYPES.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTypeFilter(typeFilter === t.key ? '' : t.key)}
                className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                  typeFilter === t.key ? `${t.tag} ring-2 ring-st-primary/30` : t.tag
                }`}
              >
                <span className={`h-2.5 w-2.5 rounded-full ${t.dot}`} />
                {t.label}
                <span className="rounded-full bg-st-lowest/70 px-1.5 py-0.5 font-mono text-[10px] font-bold text-st-on">
                  {cellCounts(t.key)}
                </span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => setTypeFilter('')}
              className="ml-2 text-xs font-bold text-st-primary hover:underline"
            >
              Show all
            </button>
          </div>
        </div>

        {/* ── calendar + rail ───────────────────────────────────────────── */}
        <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-12">
          <div className="flex flex-col space-y-4 xl:col-span-9">
            {view === 'month' ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-st-lowest px-6 py-4 shadow-sm">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => nav(-1)}
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-st-on-variant transition-colors hover:bg-st-container hover:text-st-on"
                      aria-label="Previous month"
                    >
                      <ChevronLeft className="h-5 w-5" />
                    </button>
                    <div className="px-3 py-1 text-lg font-bold tracking-tight text-st-on">
                      {MONTHS[month - 1]} {year}
                    </div>
                    <button
                      type="button"
                      onClick={() => nav(1)}
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-st-on-variant transition-colors hover:bg-st-container hover:text-st-on"
                      aria-label="Next month"
                    >
                      <ChevronRight className="h-5 w-5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const t = new Date();
                        setYear(t.getUTCFullYear());
                        setMonth(t.getUTCMonth() + 1);
                      }}
                      className="rounded-md bg-st-primary-fixed/40 px-2.5 py-1 text-xs font-semibold text-st-primary transition-colors hover:bg-st-primary-fixed/80"
                    >
                      Today
                    </button>
                  </div>
                  <div className="hidden items-center gap-4 text-xs font-medium text-st-on-variant sm:flex">
                    <span className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-st-error" /> {monthStats.public} gazetted public
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-st-secondary" /> {monthStats.company} corporate paid
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-st-tertiary" /> {monthStats.optional} optional
                    </span>
                  </div>
                </div>

                <div className="overflow-hidden rounded-xl bg-st-lowest p-4 shadow-sm">
                  <div className="grid grid-cols-7 pb-3 text-center">
                    {WEEKDAY.map((d) => (
                      <div
                        key={d}
                        className={`text-xs font-bold uppercase tracking-wider ${
                          d === 'Sun' || d === 'Sat' ? 'text-st-outline' : 'text-st-on-variant'
                        }`}
                      >
                        {d}
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-7 gap-2">
                    {cells.map((cell) => {
                      const items = byDate[cell.date] || [];
                      const date = new Date(`${cell.date}T00:00:00Z`);
                      const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
                      const isToday = cell.date === dstr(new Date());
                      const primary = items[0];
                      const meta = primary ? META[primary.type] : null;

                      if (cell.outside) {
                        return (
                          <div
                            key={cell.key}
                            className="flex min-h-[104px] flex-col justify-between rounded-lg bg-st-low/40 p-2 opacity-50"
                          >
                            <span className="font-mono text-xs font-bold text-st-outline">{cell.day}</span>
                          </div>
                        );
                      }

                      if (primary) {
                        return (
                          <div
                            key={cell.key}
                            className={`flex min-h-[104px] flex-col justify-between rounded-lg p-2 transition-colors ${meta.cell}`}
                            title={items.map((h) => h.name).join(', ')}
                          >
                            <div className="flex items-center justify-between">
                              <span className={`font-mono text-xs font-bold ${meta.text}`}>
                                {String(cell.day).padStart(2, '0')}
                              </span>
                              <span
                                className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${meta.chip}`}
                              >
                                {primary.type === 'PUBLIC' ? 'Mandated' : primary.type === 'COMPANY' ? 'Company' : primary.type === 'OPTIONAL' ? 'Optional' : primary.type.slice(0, 4)}
                              </span>
                            </div>
                            <div className="rounded bg-st-lowest/90 p-1.5 shadow-sm backdrop-blur-sm">
                              <div className="text-xs font-bold leading-snug text-st-on">
                                {primary.name}
                              </div>
                              <div className={`mt-0.5 flex items-center gap-1 text-[10px] font-semibold ${meta.text}`}>
                                <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                                <span className="truncate">
                                  {items.length > 1 ? `+${items.length - 1} more` : primary.isOptional ? 'Floating opt-in' : 'Non-working day'}
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      }

                      if (isToday) {
                        return (
                          <div
                            key={cell.key}
                            className="relative flex min-h-[104px] flex-col justify-between overflow-hidden rounded-lg bg-st-primary-fixed/30 p-2 shadow-sm"
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5">
                                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-st-primary font-mono text-xs font-bold text-st-on-primary shadow-sm">
                                  {cell.day}
                                </span>
                                <span className="text-[10px] font-bold uppercase tracking-wider text-st-on-primary-fixed">
                                  Today
                                </span>
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 rounded bg-st-lowest/80 p-1.5 text-[11px] font-medium text-st-on-variant">
                              <Check className="h-3.5 w-3.5 text-st-primary" aria-hidden="true" />
                              <span>{weekend ? 'Weekend' : 'Regular shift'}</span>
                            </div>
                          </div>
                        );
                      }

                      if (weekend) {
                        return (
                          <div
                            key={cell.key}
                            className="flex min-h-[104px] flex-col justify-between rounded-lg bg-st-high/40 p-2"
                          >
                            <span className="font-mono text-xs font-bold text-st-outline">
                              {String(cell.day).padStart(2, '0')}
                            </span>
                            <span className="text-[10px] font-semibold text-st-outline">Weekend</span>
                          </div>
                        );
                      }

                      return (
                        <div
                          key={cell.key}
                          className="flex min-h-[104px] flex-col justify-between rounded-lg bg-st-low p-2 transition-colors hover:bg-st-container"
                        >
                          <span className="font-mono text-xs font-bold text-st-on">
                            {String(cell.day).padStart(2, '0')}
                          </span>
                          <span className="text-[10px] italic text-st-on-variant/70">Regular shift</span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="flex flex-col items-start justify-between gap-3 rounded-xl bg-st-low p-4 sm:flex-row sm:items-center">
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-st-highest text-st-primary">
                      <Info className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <div className="text-xs leading-relaxed text-st-on-variant">
                      <strong className="font-semibold text-st-on">Statutory note:</strong> a public
                      holiday is a non-working day for everyone the holiday applies to. Work logged on
                      one stays on the record and is flagged for review rather than counted as ordinary
                      time.
                    </div>
                  </div>
                  <a
                    href="/app/attendance/report"
                    className="whitespace-nowrap text-xs font-bold text-st-primary hover:underline"
                  >
                    View attendance record
                  </a>
                </div>
              </>
            ) : null}

            {view === 'year' ? (
              <div className="rounded-xl bg-st-lowest p-6 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-st-secondary">
                      Annual view
                    </p>
                    <h2 className="text-lg font-bold text-st-on">{year} at a glance</h2>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setYear((y) => y - 1)}
                      className="rounded-lg border border-st-high p-1.5 text-st-on-variant hover:bg-st-container"
                      aria-label="Previous year"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <span className="text-sm font-bold text-st-on">{year}</span>
                    <button
                      type="button"
                      onClick={() => setYear((y) => y + 1)}
                      className="rounded-lg border border-st-high p-1.5 text-st-on-variant hover:bg-st-container"
                      aria-label="Next year"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div className="mt-3 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                  {yearMonths.map((m) => (
                    <div key={m.month} className="rounded-xl border border-st-high p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-st-on">{m.name}</span>
                        <span className="text-[10px] text-st-on-variant">{m.items.length}</span>
                      </div>
                      {m.items.length ? (
                        <ul className="mt-1 space-y-1">
                          {m.items.slice(0, 3).map((h) => (
                            <li key={h.id} className="flex items-center gap-1.5 text-[10px]">
                              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${META[h.type]?.dot || 'bg-st-outline'}`} />
                              <span className="truncate text-st-on">{h.name}</span>
                              <span className="ml-auto shrink-0 text-st-on-variant">
                                {String(h.date).slice(8, 10)}
                              </span>
                            </li>
                          ))}
                          {m.items.length > 3 ? (
                            <li className="text-[10px] text-st-on-variant">+{m.items.length - 3} more</li>
                          ) : null}
                        </ul>
                      ) : (
                        <p className="mt-1 text-[10px] text-st-on-variant">No holidays</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {view === 'list' ? (
              <div className="overflow-hidden rounded-xl bg-st-lowest shadow-sm">
                <div className="flex items-center justify-between gap-2 border-b border-st-high px-5 py-3">
                  <h2 className="text-sm font-bold text-st-on">Holidays in {year}</h2>
                  <span className="text-xs text-st-on-variant">{filteredList.length} listed</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] border-collapse text-left">
                    <thead>
                      <tr className="bg-st-low text-[11px] font-bold uppercase tracking-wider text-st-outline">
                        <th className="px-5 py-3">Date</th>
                        <th className="px-4 py-3">Holiday</th>
                        <th className="px-4 py-3">Type</th>
                        <th className="px-4 py-3">Scope</th>
                        {isHR ? <th className="px-5 py-3 text-right">Actions</th> : null}
                      </tr>
                    </thead>
                    <tbody className="text-xs">
                      {filteredList.map((h) => (
                        <tr key={h.id} className="border-b border-st-high/60 transition hover:bg-st-low/60 last:border-0">
                          <td className="whitespace-nowrap px-5 py-3 font-semibold text-st-on">
                            {fmtDay(String(h.date).slice(0, 10))}
                            <span className="block text-[10px] font-normal text-st-on-variant">
                              {fmtWeekday(String(h.date).slice(0, 10))}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <p className="font-semibold text-st-on">{h.name}</p>
                            {h.description ? (
                              <p className="text-[11px] text-st-on-variant">{h.description}</p>
                            ) : null}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3">
                            <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${META[h.type]?.tag || ''}`}>
                              {META[h.type]?.label || h.type}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-[11px] text-st-on-variant">
                            {h.branch || (h.departments || []).map((d) => d.name).join(', ') || 'Everyone'}
                          </td>
                          {isHR ? (
                            <td className="whitespace-nowrap px-5 py-3 text-right">
                              <div className="inline-flex gap-1">
                                <button
                                  type="button"
                                  onClick={() => openEdit(h)}
                                  className="rounded-lg border border-st-high p-1.5 text-st-on-variant hover:bg-st-container"
                                  aria-label={`Edit ${h.name}`}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => deactivate(h)}
                                  className="rounded-lg border border-st-high p-1.5 text-st-error hover:bg-st-error-container"
                                  aria-label={`Remove ${h.name}`}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </td>
                          ) : null}
                        </tr>
                      ))}
                      {!filteredList.length ? (
                        <tr>
                          <td colSpan={isHR ? 5 : 4} className="px-5 py-6">
                            <EmptyState
                              illustration="calendar"
                              title="Nothing here yet"
                              description="No holidays match this filter for the year."
                              size="sm"
                            />
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </div>

          {/* ── rail ────────────────────────────────────────────────────── */}
          <div className="flex flex-col space-y-6 xl:col-span-3">
            <div className="space-y-4 rounded-xl bg-st-lowest p-6 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-st-outline">
                  My entitlement
                </span>
                <span className="rounded-full bg-st-tertiary-fixed px-2 py-0.5 text-xs font-semibold text-st-on-tertiary-fixed">
                  FY {year}
                </span>
              </div>
              <div className="space-y-2">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-xl font-bold text-st-on">Floating leave</h3>
                  <span className="font-mono text-2xl font-bold text-st-primary">
                    {optionalMine.length - claimed}{' '}
                    <span className="text-sm font-normal text-st-on-variant">
                      / {optionalMine.length} remaining
                    </span>
                  </span>
                </div>
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-st-container">
                  <div
                    className="h-full rounded-full bg-st-primary-container transition-all duration-500"
                    style={{
                      width: `${optionalMine.length ? (claimed / optionalMine.length) * 100 : 0}%`,
                    }}
                  />
                </div>
                <p className="text-xs text-st-on-variant">
                  {optionalMine.length
                    ? `You have claimed ${claimed} of ${optionalMine.length} optional days this year.`
                    : 'No optional holidays are published for this year.'}
                </p>
              </div>
              <div className="space-y-2 rounded-lg bg-st-low p-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-st-on">Next eligible day:</span>
                  <span className="font-bold text-st-tertiary">
                    {nextOptional ? `${fmtDay(String(nextOptional.date).slice(0, 10))}` : 'None pending'}
                  </span>
                </div>
                <button
                  type="button"
                  disabled={!nextOptional}
                  onClick={() => nextOptional && togglePick(nextOptional)}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-st-secondary py-2 text-xs font-bold text-st-on-secondary shadow-sm transition-colors hover:bg-st-secondary/90 disabled:opacity-50"
                >
                  <Gift className="h-4 w-4" aria-hidden="true" />
                  Claim this holiday
                </button>
              </div>
            </div>

            <div className="space-y-4 rounded-xl bg-st-lowest p-6 shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-bold tracking-tight text-st-on">Upcoming in {nextQuarter}</h3>
                  <p className="text-xs text-st-on-variant">Next scheduled closures</p>
                </div>
                <Sparkles className="h-5 w-5 text-st-outline" aria-hidden="true" />
              </div>
              <div className="space-y-3">
                {upcomingList.map((h) => {
                  const meta = META[h.type] || META.COMPANY;
                  return (
                    <div
                      key={h.id}
                      className="flex items-start justify-between gap-3 rounded-xl bg-st-low p-3 transition-all hover:bg-st-container"
                    >
                      <div className="flex items-center gap-3">
                        <div className={`flex h-10 w-10 flex-col items-center justify-center rounded-lg font-mono ${meta.tag}`}>
                          <span className="text-[9px] font-bold uppercase leading-none">
                            {MONTHS[Number(String(h.date).slice(5, 7)) - 1]?.slice(0, 3)}
                          </span>
                          <span className="text-sm font-bold leading-tight">{String(h.date).slice(8, 10)}</span>
                        </div>
                        <div className="space-y-0.5">
                          <h4 className="text-xs font-bold text-st-on">{h.name}</h4>
                          <div className="flex items-center gap-1 text-[11px] text-st-on-variant">
                            <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                            <span>
                              {fmtWeekday(String(h.date).slice(0, 10))} • {meta.label}
                            </span>
                          </div>
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 shrink-0 text-st-outline" aria-hidden="true" />
                    </div>
                  );
                })}
                {!upcomingList.length ? (
                  <p className="rounded-xl border border-dashed border-st-high px-3 py-4 text-center text-[11px] text-st-on-variant">
                    Nothing scheduled ahead.
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => setView('year')}
                className="w-full py-2 text-center text-xs font-bold text-st-primary transition-colors hover:text-st-primary-container"
              >
                View full {year} schedule →
              </button>
            </div>

            {isHR ? (
              <div className="space-y-3 rounded-xl bg-st-container p-5">
                <div className="flex items-center gap-2 text-st-on">
                  <ShieldCheck className="h-5 w-5 text-st-primary" aria-hidden="true" />
                  <h4 className="text-xs font-bold uppercase tracking-wider">Coverage by type</h4>
                </div>
                <p className="text-xs leading-relaxed text-st-on-variant">
                  How the {year} register is split between statutory and discretionary days.
                </p>
                <ul className="space-y-1.5 text-[11px]">
                  {TYPES.map((t) => (
                    <li key={t.key} className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-st-on-variant">
                        <span className={`h-2 w-2 rounded-full ${t.dot}`} />
                        {t.label}
                      </span>
                      <span className="font-bold text-st-on">{counts[t.key]}</span>
                    </li>
                  ))}
                </ul>
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    disabled
                    title="Calendar feeds are not published by this workspace yet."
                    className="flex flex-1 cursor-not-allowed items-center justify-center gap-1 rounded-lg bg-st-lowest/60 py-1.5 text-xs font-semibold text-st-on-variant/70"
                  >
                    <Download className="h-4 w-4" aria-hidden="true" /> iCal
                  </button>
                  <button
                    type="button"
                    disabled
                    title="Calendar feeds are not published by this workspace yet."
                    className="flex flex-1 cursor-not-allowed items-center justify-center gap-1 rounded-lg bg-st-lowest/60 py-1.5 text-xs font-semibold text-st-on-variant/70"
                  >
                    <Link2 className="h-4 w-4" aria-hidden="true" /> Feed URL
                  </button>
                </div>
                <p className="text-[10px] leading-relaxed text-st-on-variant/80">
                  Feed subscriptions need a published endpoint — nothing is minted here until the
                  company turns one on.
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* ── editor ──────────────────────────────────────────────────────── */}
      {modal ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-st-inverse/50 p-0 backdrop-blur-sm sm:items-center sm:p-4"
          onClick={() => setModal(null)}
        >
          <div
            className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-st-lowest shadow-2xl sm:rounded-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-start justify-between gap-2 border-b border-st-high bg-st-low px-6 py-4">
              <div>
                <h3 className="text-base font-bold text-st-on">
                  {modal.mode === 'create' ? 'Add new holiday' : `Edit ${modal.form.name}`}
                </h3>
                <p className="text-xs text-st-on-variant">Publishes a calendar entry for payroll &amp; rosters.</p>
              </div>
              <button
                type="button"
                onClick={() => setModal(null)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-st-outline hover:bg-st-container hover:text-st-on"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
              <label className="block">
                <span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-st-on">
                  Holiday title
                </span>
                <input
                  className="w-full rounded-lg bg-st-container px-3.5 py-2.5 text-sm text-st-on placeholder:text-st-on-variant/50 focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                  value={modal.form.name}
                  onChange={(e) => setModal({ ...modal, form: { ...modal.form, name: e.target.value } })}
                  placeholder="e.g. Founder's Day observance"
                />
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-st-on">
                    Date
                  </span>
                  <input
                    type="date"
                    className="w-full rounded-lg bg-st-container px-3.5 py-2.5 font-mono text-sm text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                    value={modal.form.date}
                    onChange={(e) => setModal({ ...modal, form: { ...modal.form, date: e.target.value } })}
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-st-on">
                    Category
                  </span>
                  <select
                    className="w-full rounded-lg bg-st-container px-3.5 py-2.5 text-sm text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                    value={modal.form.type}
                    onChange={(e) => setModal({ ...modal, form: { ...modal.form, type: e.target.value } })}
                  >
                    {TYPES.filter((t) => t.key !== 'OPTIONAL').map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="block">
                <span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-st-on">
                  Ends (optional)
                </span>
                <input
                  type="date"
                  className="w-full rounded-lg bg-st-container px-3.5 py-2.5 font-mono text-sm text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                  value={modal.form.endDate}
                  onChange={(e) => setModal({ ...modal, form: { ...modal.form, endDate: e.target.value } })}
                />
              </label>

              {modal.form.type === 'BRANCH' ? (
                <label className="block">
                  <span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-st-on">
                    Branch
                  </span>
                  <input
                    className="w-full rounded-lg bg-st-container px-3.5 py-2.5 text-sm text-st-on placeholder:text-st-on-variant/50 focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                    value={modal.form.branch}
                    onChange={(e) => setModal({ ...modal, form: { ...modal.form, branch: e.target.value } })}
                    placeholder="Coimbatore HQ"
                  />
                </label>
              ) : null}

              {modal.form.type === 'DEPARTMENT' ? (
                <div>
                  <span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-st-on">
                    Departments
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {departments.map((d) => {
                      const id = String(d._id || d.id);
                      const on = (modal.form.departments || []).includes(id);
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() =>
                            setModal({
                              ...modal,
                              form: {
                                ...modal.form,
                                departments: on
                                  ? modal.form.departments.filter((x) => x !== id)
                                  : [...(modal.form.departments || []), id],
                              },
                            })
                          }
                          className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                            on
                              ? 'bg-st-primary-fixed text-st-on-primary-fixed-variant'
                              : 'bg-st-container text-st-on-variant'
                          }`}
                        >
                          {d.name}
                        </button>
                      );
                    })}
                    {!departments.length ? (
                      <span className="text-xs text-st-on-variant">No departments found.</span>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <label className="block">
                <span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-st-on">
                  Description &amp; payroll note
                </span>
                <textarea
                  className="w-full rounded-lg bg-st-container px-3.5 py-2.5 text-sm text-st-on placeholder:text-st-on-variant/50 focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                  rows={2}
                  value={modal.form.description}
                  onChange={(e) => setModal({ ...modal, form: { ...modal.form, description: e.target.value } })}
                  placeholder="Optional notes for employees, shift compensation guidelines…"
                />
              </label>

              <label className="flex items-center gap-2 text-xs font-medium text-st-on">
                <input
                  type="checkbox"
                  className="accent-st-primary"
                  checked={modal.form.isOptional}
                  onChange={(e) => setModal({ ...modal, form: { ...modal.form, isOptional: e.target.checked } })}
                />
                Optional (people claim it from their own list)
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-st-on">
                <input
                  type="checkbox"
                  className="accent-st-primary"
                  checked={modal.form.recurringYearly}
                  onChange={(e) => setModal({ ...modal, form: { ...modal.form, recurringYearly: e.target.checked } })}
                />
                Repeats every year
              </label>
            </div>

            <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-st-high bg-st-low px-6 py-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                className="rounded-lg bg-st-container px-4 py-2 text-xs font-semibold text-st-on transition hover:bg-st-high"
                onClick={() => setModal(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-lg bg-st-primary px-5 py-2 text-xs font-bold text-st-on-primary shadow-sm transition hover:bg-st-primary-container hover:text-st-on-primary-container disabled:opacity-50"
                disabled={saving || !modal.form.name || !modal.form.date}
                onClick={save}
              >
                {saving ? 'Saving…' : 'Publish holiday'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default HolidaysPage;
