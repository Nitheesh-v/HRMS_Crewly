import { useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  CalendarRange,
  Check,
  ChevronLeft,
  ChevronRight,
  Gift,
  Globe2,
  Layers,
  List,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { useSelector } from 'react-redux';
import scheduleService from '../../services/scheduleService';
import { notify } from '../../utils/notify.js';
import EmptyState from '../../components/common/EmptyState.jsx';

const HR = ['COMPANY_ADMIN', 'HR_MANAGER'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const TYPES = [
  { key: 'COMPANY', label: 'Company wide', dot: 'bg-crewly-green' },
  { key: 'BRANCH', label: 'Branch specific', dot: 'bg-crewly-orange' },
  { key: 'DEPARTMENT', label: 'Department', dot: 'bg-crewly-accent' },
  { key: 'OPTIONAL', label: 'Floating / optional', dot: 'bg-crewly-selected' },
  { key: 'PUBLIC', label: 'Public / statutory', dot: 'bg-crewly-red' },
];
const TYPE_META = Object.fromEntries(TYPES.map((t) => [t.key, t]));

const TYPE_CHIP = {
  COMPANY: 'bg-crewly-green/15 text-crewly-green',
  BRANCH: 'bg-crewly-orange/15 text-crewly-orange',
  DEPARTMENT: 'bg-crewly-accent/15 text-crewly-orange',
  OPTIONAL: 'bg-crewly-selected/60 text-crewly-text',
  PUBLIC: 'bg-crewly-red/15 text-crewly-red',
};

const dstr = (d) => d.toISOString().slice(0, 10);
const fmtDay = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
};

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
      /* the same year as the viewer sees it — this is where "claimed" comes from */
      const personal = await scheduleService.listHolidays({ year });
      setMine(personal.holidays || []);
      const up = await scheduleService.upcoming(150);
      setUpcoming((up.holidays || []).slice(0, 4));
    } catch {
      /* api.js reports every failed request */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let alive = true;
    /* deferred one tick so the fetch never sets state during render commit */
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
    const inMonth = holidays.filter((h) => String(h.date).slice(0, 7) === `${year}-${String(month).padStart(2, '0')}`);
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
      .filter((h) => (needle ? `${h.name} ${h.branch || ''} ${(h.departments || []).map((d) => d.name).join(' ')}`.toLowerCase().includes(needle) : true))
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
  const nextHoliday = useMemo(
    () =>
      [...upcoming]
        .filter((h) => String(h.date).slice(0, 10) >= dstr(new Date()))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0] || null,
    [upcoming],
  );

  const yearMonths = useMemo(() => {
    return MONTHS.map((name, index) => ({
      name,
      month: index + 1,
      items: holidays
        .filter((h) => String(h.date).slice(0, 7) === `${year}-${String(index + 1).padStart(2, '0')}`)
        .sort((a, b) => String(a.date).localeCompare(String(b.date))),
    }));
  }, [holidays, year]);

  return (
    <div className="space-y-5">
      {/* ── title ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-crewly-dim">
            Time &amp; leave
            <span className="mx-2 text-crewly-border">•</span>
            {year} calendar
          </p>
          <h1 className="mt-1 text-2xl font-bold sm:text-[28px]">Holiday calendar</h1>
          <p className="mt-1 max-w-2xl text-sm text-crewly-dim">
            Company, branch, department, and the optional days you can still claim — each one lands
            on the attendance record as a non-working day.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-xl border border-crewly-border bg-crewly-inset p-1" role="tablist" aria-label="Calendar view">
            {[
              ['month', 'Month', CalendarDays],
              ['year', 'Year', CalendarRange],
              ['list', 'List', List],
            ].map(([key, label, Icon]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={view === key}
                onClick={() => setView(key)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                  view === key ? 'bg-crewly-card text-crewly-text shadow-sm' : 'text-crewly-dim hover:text-crewly-text'
                }`}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>

          {isHR ? (
            <button type="button" onClick={openCreate} className="btn-primary inline-flex items-center gap-2 whitespace-nowrap px-3.5 py-2 text-xs font-bold">
              <Plus className="h-4 w-4" aria-hidden="true" /> Add holiday
            </button>
          ) : null}
        </div>
      </div>

      {/* ── type tags with their counts ───────────────────────────────── */}
      <div className="card">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-crewly-dim">
            <Layers className="h-3.5 w-3.5" aria-hidden="true" /> Filter tags
          </span>
          <button
            type="button"
            onClick={() => setTypeFilter('')}
            className={`rounded-full px-2.5 py-1 text-[11px] font-bold transition ${
              typeFilter ? 'border border-crewly-border text-crewly-dim' : 'bg-crewly-inset-strong text-crewly-text'
            }`}
          >
            All ({holidays.length})
          </button>
          {TYPES.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTypeFilter(typeFilter === t.key ? '' : t.key)}
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                typeFilter === t.key ? 'bg-crewly-inset-strong text-crewly-text' : 'border border-crewly-border text-crewly-dim hover:text-crewly-text'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} aria-hidden="true" />
              {t.label}
              <span className="rounded-full bg-crewly-inset px-1.5 text-[10px] font-bold">{counts[t.key]}</span>
            </button>
          ))}
          <label className="relative ml-auto block min-w-[170px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-crewly-dim" aria-hidden="true" />
            <input
              className="input w-full py-1.5 pl-7 text-xs"
              placeholder="Search holidays"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search holidays"
            />
          </label>
        </div>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {/* ── month ─────────────────────────────────────────────────── */}
          {view === 'month' ? (
            <section className="card p-0">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-crewly-border px-4 py-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => nav(-1)}
                    className="rounded-lg border border-crewly-border p-1.5 transition hover:bg-crewly-inset"
                    aria-label="Previous month"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <p className="min-w-[130px] text-center text-sm font-bold">
                    {MONTHS[month - 1]} {year}
                  </p>
                  <button
                    type="button"
                    onClick={() => nav(1)}
                    className="rounded-lg border border-crewly-border p-1.5 transition hover:bg-crewly-inset"
                    aria-label="Next month"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const t = new Date();
                      setYear(t.getUTCFullYear());
                      setMonth(t.getUTCMonth() + 1);
                    }}
                    className="rounded-lg bg-crewly-inset px-2.5 py-1 text-[11px] font-bold"
                  >
                    Today
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-3 text-[11px] text-crewly-dim">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-crewly-red" aria-hidden="true" />
                    {monthStats.public} gazetted public
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-crewly-green" aria-hidden="true" />
                    {monthStats.company} corporate paid
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-crewly-selected" aria-hidden="true" />
                    {monthStats.optional} optional
                  </span>
                </div>
              </div>

              <div className="p-3">
                <div className="grid grid-cols-7 gap-1.5 text-center text-[9px] font-bold uppercase tracking-wide text-crewly-dim">
                  {WEEKDAY.map((d) => (
                    <span key={d}>{d}</span>
                  ))}
                </div>
                <div className="mt-1.5 grid grid-cols-7 gap-1.5">
                  {cells.map((cell) => {
                    const items = byDate[cell.date] || [];
                    const date = new Date(`${cell.date}T00:00:00Z`);
                    const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
                    const isToday = cell.date === dstr(new Date());
                    const primary = items[0];
                    return (
                      <div
                        key={cell.key}
                        className={`min-h-[74px] rounded-lg border p-1.5 text-left transition ${
                          cell.outside
                            ? 'border-transparent bg-crewly-inset/30 opacity-50'
                            : primary
                              ? 'border-crewly-border bg-crewly-card'
                              : weekend
                                ? 'border-transparent bg-crewly-inset/50'
                                : 'border-crewly-border/60 bg-crewly-card'
                        } ${isToday ? 'ring-2 ring-crewly-accent' : ''}`}
                        title={primary ? primary.name : weekend ? 'Weekend' : 'Regular shift'}
                      >
                        <div className="flex items-start justify-between">
                          <span className={`text-[11px] font-bold ${isToday ? 'text-crewly-orange' : ''}`}>
                            {String(cell.day).padStart(2, '0')}
                          </span>
                          {isToday ? (
                            <span className="rounded bg-crewly-accent/20 px-1 text-[8px] font-bold uppercase text-crewly-orange">
                              Today
                            </span>
                          ) : null}
                        </div>
                        {items.slice(0, 2).map((h) => (
                          <div key={h.id} className="mt-0.5">
                            <p className="line-clamp-2 text-[10px] font-semibold leading-tight">{h.name}</p>
                            <span className={`mt-0.5 inline-block rounded px-1 text-[8px] font-bold uppercase ${TYPE_CHIP[h.type] || ''}`}>
                              {TYPE_META[h.type]?.label.split(' ')[0] || h.type}
                            </span>
                          </div>
                        ))}
                        {!items.length ? (
                          <p className="mt-1 text-[9px] text-crewly-dim">{weekend ? 'Weekend' : 'Regular shift'}</p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-crewly-border bg-crewly-inset/40 px-4 py-2.5 text-[11px] text-crewly-dim">
                <span>
                  {holidays.length
                    ? `${holidays.length} ${holidays.length === 1 ? 'holiday' : 'holidays'} read for ${MONTHS[month - 1]}`
                    : `No holidays recorded in ${MONTHS[month - 1]}`}
                  {loading ? ' · reading…' : ''}
                </span>
                <span>Each one is treated as a non-working day for attendance.</span>
              </div>
            </section>
          ) : null}

          {/* ── year ──────────────────────────────────────────────────── */}
          {view === 'year' ? (
            <section className="card">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">Annual view</p>
                  <h2 className="card-title text-base font-bold">{year} at a glance</h2>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => setYear((y) => y - 1)} className="rounded-lg border border-crewly-border p-1.5" aria-label="Previous year">
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="text-sm font-bold">{year}</span>
                  <button type="button" onClick={() => setYear((y) => y + 1)} className="rounded-lg border border-crewly-border p-1.5" aria-label="Next year">
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="mt-3 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                {yearMonths.map((m) => (
                  <div key={m.month} className="rounded-xl border border-crewly-border p-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold">{m.name}</span>
                      <span className="text-[10px] text-crewly-dim">{m.items.length}</span>
                    </div>
                    {m.items.length ? (
                      <ul className="mt-1 space-y-1">
                        {m.items.slice(0, 3).map((h) => (
                          <li key={h.id} className="flex items-center gap-1.5 text-[10px]">
                            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TYPE_META[h.type]?.dot || 'bg-crewly-dim'}`} aria-hidden="true" />
                            <span className="truncate">{h.name}</span>
                            <span className="ml-auto shrink-0 text-crewly-dim">{String(h.date).slice(8, 10)}</span>
                          </li>
                        ))}
                        {m.items.length > 3 ? (
                          <li className="text-[10px] text-crewly-dim">+{m.items.length - 3} more</li>
                        ) : null}
                      </ul>
                    ) : (
                      <p className="mt-1 text-[10px] text-crewly-dim">No holidays</p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/* ── list ──────────────────────────────────────────────────── */}
          {view === 'list' ? (
            <section className="card overflow-hidden p-0">
              <div className="flex items-center justify-between gap-2 border-b border-crewly-border bg-crewly-inset/40 px-4 py-2.5">
                <h2 className="card-title text-sm font-bold">Holidays in {year}</h2>
                <span className="text-[11px] text-crewly-dim">{filteredList.length} listed</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[600px] text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-crewly-border text-[10px] uppercase tracking-[0.1em] text-crewly-dim">
                      <th className="whitespace-nowrap px-4 py-2.5 font-semibold">Date</th>
                      <th className="px-3 py-2.5 font-semibold">Holiday</th>
                      <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Type</th>
                      <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Scope</th>
                      {isHR ? <th className="px-4 py-2.5 text-right font-semibold">Actions</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredList.map((h) => (
                      <tr key={h.id} className="border-b border-crewly-border/50 last:border-0">
                        <td className="whitespace-nowrap px-4 py-2.5 font-semibold">{fmtDay(String(h.date).slice(0, 10))}</td>
                        <td className="px-3 py-2.5">
                          <p className="font-semibold">{h.name}</p>
                          {h.description ? <p className="text-[11px] text-crewly-dim">{h.description}</p> : null}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5">
                          <span className={`badge ${TYPE_CHIP[h.type] || ''}`}>{TYPE_META[h.type]?.label || h.type}</span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-[11px] text-crewly-dim">
                          {h.branch || (h.departments || []).map((d) => d.name).join(', ') || 'Everyone'}
                        </td>
                        {isHR ? (
                          <td className="whitespace-nowrap px-4 py-2.5 text-right">
                            <div className="inline-flex gap-1">
                              <button type="button" onClick={() => openEdit(h)} className="rounded-lg border border-crewly-border p-1.5 hover:bg-crewly-inset" aria-label={`Edit ${h.name}`}>
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button type="button" onClick={() => deactivate(h)} className="rounded-lg border border-crewly-border p-1.5 text-crewly-red hover:bg-crewly-red/10" aria-label={`Remove ${h.name}`}>
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                    {!filteredList.length ? (
                      <tr>
                        <td colSpan={isHR ? 5 : 4} className="px-4 py-6">
                          <EmptyState illustration="calendar" title="Nothing here yet" description="No holidays match this filter for the year." size="sm" />
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {view === 'month' ? (
            <div className="flex items-start gap-2.5 rounded-xl border border-crewly-border bg-crewly-inset/40 px-3.5 py-3 text-[11px] leading-relaxed">
              <Globe2 className="mt-0.5 h-4 w-4 shrink-0 text-crewly-dim" aria-hidden="true" />
              <p className="min-w-0">
                <span className="font-semibold">Compliance note:</span> a public holiday is a
                non-working day for everyone the holiday applies to. Work logged on one is kept on
                the record and flagged for review rather than silently counted as ordinary time.
              </p>
            </div>
          ) : null}
        </div>

        {/* ── right rail ─────────────────────────────────────────────── */}
        <div className="space-y-4">
          <section className="card">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">
                  My entitlement
                </p>
                <h2 className="card-title text-base font-bold">Optional holidays</h2>
              </div>
              <span className="rounded-full bg-crewly-green/12 px-2 py-0.5 text-[10px] font-bold text-crewly-green">
                {year}
              </span>
            </div>

            <p className="mt-2 flex items-baseline gap-2">
              <span className="text-3xl font-bold">{optionalMine.length - claimed}</span>
              <span className="text-sm text-crewly-dim">of {optionalMine.length} still unclaimed</span>
            </p>

            <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-crewly-inset-strong">
              <span
                className="block h-full rounded-full bg-crewly-green"
                style={{ width: `${optionalMine.length ? (claimed / optionalMine.length) * 100 : 0}%` }}
              />
            </span>
            <p className="mt-1 text-[11px] text-crewly-dim">
              {optionalMine.length
                ? `You have claimed ${claimed} of ${optionalMine.length} optional days this year.`
                : 'No optional holidays are published for this year.'}
            </p>

            {nextHoliday ? (
              <div className="mt-3 rounded-xl bg-crewly-inset/60 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-crewly-dim">Next holiday</p>
                <p className="mt-0.5 text-sm font-bold">{nextHoliday.name}</p>
                <p className="text-[11px] text-crewly-dim">{fmtDay(String(nextHoliday.date).slice(0, 10))}</p>
                {nextHoliday.isOptional ? (
                  <button
                    type="button"
                    onClick={() => togglePick(nextHoliday)}
                    className="btn-primary mt-2 inline-flex w-full items-center justify-center gap-2 px-3 py-1.5 text-[11px] font-bold"
                  >
                    {nextHoliday.picked ? (
                      <>
                        <Check className="h-3.5 w-3.5" aria-hidden="true" /> Claimed — remove
                      </>
                    ) : (
                      <>
                        <Gift className="h-3.5 w-3.5" aria-hidden="true" /> Claim this holiday
                      </>
                    )}
                  </button>
                ) : (
                  <p className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-crewly-green">
                    <Check className="h-3 w-3" aria-hidden="true" /> Applies to everyone
                  </p>
                )}
              </div>
            ) : null}
          </section>

          <section className="card">
            <div className="flex items-center justify-between gap-2">
              <h2 className="card-title text-base font-bold">Upcoming</h2>
              <Sparkles className="h-4 w-4 text-crewly-dim" aria-hidden="true" />
            </div>
            <p className="mt-0.5 text-[11px] text-crewly-dim">Next scheduled closures, newest first.</p>
            <ul className="mt-2.5 space-y-2">
              {upcoming.map((h) => (
                <li key={h.id} className="flex items-center gap-2.5 rounded-xl bg-crewly-inset/50 p-2.5">
                  <span className="flex w-10 shrink-0 flex-col items-center rounded-lg bg-crewly-card px-1 py-1">
                    <span className="text-[9px] font-bold uppercase text-crewly-dim">
                      {MONTHS[Number(String(h.date).slice(5, 7)) - 1]?.slice(0, 3)}
                    </span>
                    <span className="text-sm font-bold leading-none">{String(h.date).slice(8, 10)}</span>
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-semibold">{h.name}</span>
                    <span className="block text-[10px] text-crewly-dim">
                      {TYPE_META[h.type]?.label || h.type}
                    </span>
                  </span>
                </li>
              ))}
              {!upcoming.length ? (
                <li className="rounded-xl border border-dashed border-crewly-border px-3 py-4 text-center text-[11px] text-crewly-dim">
                  Nothing scheduled ahead.
                </li>
              ) : null}
            </ul>
            {isHR ? (
              <button
                type="button"
                onClick={openCreate}
                className="btn-ghost mt-3 inline-flex w-full items-center justify-center gap-2 px-3 py-2 text-xs font-bold"
              >
                <Plus className="h-4 w-4" aria-hidden="true" /> Add holiday
              </button>
            ) : null}
          </section>

          {isHR ? (
            <section className="card">
              <h2 className="card-title flex items-center gap-2 text-sm font-bold">
                <Users className="h-4 w-4 text-crewly-dim" aria-hidden="true" />
                Coverage by type
              </h2>
              <ul className="mt-2 space-y-1.5 text-[11px]">
                {TYPES.map((t) => (
                  <li key={t.key} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-crewly-dim">
                      <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} aria-hidden="true" />
                      {t.label}
                    </span>
                    <span className="font-bold">{counts[t.key]}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>

      {/* ── editor ────────────────────────────────────────────────────── */}
      {modal ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={() => setModal(null)}>
          <div
            className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-crewly-border bg-crewly-card sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-crewly-border px-5 py-3.5">
              <div>
                <h3 className="card-title text-base font-bold">
                  {modal.mode === 'create' ? 'Add holiday' : 'Edit holiday'}
                </h3>
                <p className="text-[11px] text-crewly-dim">
                  Saved to {year} and applied to the attendance record.
                </p>
              </div>
              <button type="button" onClick={() => setModal(null)} className="rounded-lg p-1 text-crewly-dim hover:text-crewly-text" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
              <label className="block text-xs">
                <span className="mb-1 block font-semibold text-crewly-dim">Name</span>
                <input
                  className="input w-full"
                  value={modal.form.name}
                  onChange={(e) => setModal({ ...modal, form: { ...modal.form, name: e.target.value } })}
                  placeholder="Diwali"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-xs">
                  <span className="mb-1 block font-semibold text-crewly-dim">Date</span>
                  <input
                    type="date"
                    className="input w-full"
                    value={modal.form.date}
                    onChange={(e) => setModal({ ...modal, form: { ...modal.form, date: e.target.value } })}
                  />
                </label>
                <label className="block text-xs">
                  <span className="mb-1 block font-semibold text-crewly-dim">Ends (optional)</span>
                  <input
                    type="date"
                    className="input w-full"
                    value={modal.form.endDate}
                    onChange={(e) => setModal({ ...modal, form: { ...modal.form, endDate: e.target.value } })}
                  />
                </label>
              </div>
              <label className="block text-xs">
                <span className="mb-1 block font-semibold text-crewly-dim">Type</span>
                <select
                  className="input w-full"
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
              {modal.form.type === 'BRANCH' ? (
                <label className="block text-xs">
                  <span className="mb-1 block font-semibold text-crewly-dim">Branch</span>
                  <input
                    className="input w-full"
                    value={modal.form.branch}
                    onChange={(e) => setModal({ ...modal, form: { ...modal.form, branch: e.target.value } })}
                    placeholder="Coimbatore HQ"
                  />
                </label>
              ) : null}
              {modal.form.type === 'DEPARTMENT' ? (
                <div>
                  <span className="mb-1 block text-xs font-semibold text-crewly-dim">Departments</span>
                  <div className="flex flex-wrap gap-1.5">
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
                          className={`rounded-lg px-2.5 py-1 text-[11px] font-bold transition ${
                            on ? 'bg-crewly-accent/15 text-crewly-orange' : 'border border-crewly-border text-crewly-dim'
                          }`}
                        >
                          {d.name}
                        </button>
                      );
                    })}
                    {!departments.length ? (
                      <span className="text-[11px] text-crewly-dim">No departments found.</span>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <label className="block text-xs">
                <span className="mb-1 block font-semibold text-crewly-dim">Note</span>
                <input
                  className="input w-full"
                  value={modal.form.description}
                  onChange={(e) => setModal({ ...modal, form: { ...modal.form, description: e.target.value } })}
                  placeholder="Optional"
                />
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={modal.form.isOptional}
                  onChange={(e) => setModal({ ...modal, form: { ...modal.form, isOptional: e.target.checked } })}
                />
                Optional (people claim it from their own list)
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={modal.form.recurringYearly}
                  onChange={(e) => setModal({ ...modal, form: { ...modal.form, recurringYearly: e.target.checked } })}
                />
                Repeats every year
              </label>
            </div>

            <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-crewly-border px-5 py-3 sm:flex-row sm:justify-end">
              <button type="button" className="btn-ghost px-4 py-2 text-xs font-bold" onClick={() => setModal(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary px-4 py-2 text-xs font-bold disabled:opacity-50"
                disabled={saving || !modal.form.name || !modal.form.date}
                onClick={save}
              >
                {saving ? 'Saving…' : 'Save holiday'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default HolidaysPage;
