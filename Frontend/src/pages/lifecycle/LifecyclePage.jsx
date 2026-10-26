// ============================================================
// Employee Lifecycle (Phase 15)
// HR: stage census + journey console + promote/transfer
// Employee: own journey + timeline
//
// The census tiles and the "due soon" tab are read from the same two payloads
// the page already used — GET /lifecycle/overview (counts + probation radar) and
// GET /lifecycle/company (the records). Nothing here is a score: the tiles count
// people, and the only date arithmetic is "within 30 days", which the overview
// endpoint itself uses for its probation radar.
// ============================================================
import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Briefcase, Check, CheckCircle2, ChevronRight,
  DoorOpen, Download, Dna, FileText, GraduationCap, History, Hourglass, Inbox,
  Info, PartyPopper, Repeat, Rocket, ScrollText, Users,
} from 'lucide-react';
import { useSelector } from 'react-redux';
import {
  getMyJourney, getCompanyLifecycles, getUserJourney, getOverview,
  setStage, promoteUser, transferUser, getDepartments,
} from '../../services/lifecycleService.js';
import Modal from '../../components/Modal.jsx';
import { notify } from '../../utils/notify.js';
import EmptyState from '../../components/common/EmptyState.jsx';

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const daysTo = (d) => (d ? Math.ceil((new Date(d) - Date.now()) / 86400000) : null);
// Designation and department are the same string for plenty of people in this
// data; print it once rather than twice.
const uniqueParts = (parts) => parts.filter((part, i) => part && parts.indexOf(part) === i);

const initials = (name = '') => name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '—';

// Every stage keeps a tone from the app palette rather than a hue of its own:
// olive for settled states, gold for time-bound ones, clay for movement, red for
// the exit, sage for the quiet ones.
const STAGE_META = {
  PRE_JOINING: { label: 'Pre-joining', Icon: Inbox, cls: 'bg-crewly-inset-strong text-crewly-dim' },
  ONBOARDING: { label: 'Onboarding', Icon: Briefcase, cls: 'bg-crewly-accent/20 text-crewly-text' },
  PROBATION: { label: 'Probation', Icon: Hourglass, cls: 'bg-crewly-orange/15 text-crewly-orange' },
  CONFIRMED: { label: 'Confirmed', Icon: CheckCircle2, cls: 'bg-crewly-green/15 text-crewly-green' },
  NOTICE_PERIOD: { label: 'Notice period', Icon: FileText, cls: 'bg-crewly-accent/20 text-crewly-orange' },
  EXITED: { label: 'Exited', Icon: DoorOpen, cls: 'bg-crewly-red/15 text-crewly-red' },
  ALUMNI: { label: 'Alumni', Icon: GraduationCap, cls: 'bg-crewly-inset-strong text-crewly-dim' },
};
const STEPPER = ['ONBOARDING', 'PROBATION', 'CONFIRMED', 'NOTICE_PERIOD', 'EXITED', 'ALUMNI'];

// Mirrors canTransition() in Backend/src/controllers/lifecycleController.js.
// It is shown, not enforced: the server is the authority and rejects a bad move.
const TRANSITIONS = {
  PRE_JOINING: ['ONBOARDING'],
  ONBOARDING: ['PROBATION', 'CONFIRMED', 'NOTICE_PERIOD', 'EXITED'],
  PROBATION: ['CONFIRMED', 'PROBATION (extend)', 'NOTICE_PERIOD', 'EXITED'],
  CONFIRMED: ['NOTICE_PERIOD', 'EXITED'],
  NOTICE_PERIOD: ['EXITED'],
  EXITED: ['ALUMNI'],
  ALUMNI: [],
};

const EVENT_ICONS = { PROMOTED: Rocket, TRANSFERRED: Repeat, JOINED: Inbox, CONFIRMED: PartyPopper };

const StageBadge = ({ stage }) => {
  const m = STAGE_META[stage] || STAGE_META.CONFIRMED;
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${m.cls}`}>
      <m.Icon className="mr-1 h-3 w-3" />
      {m.label}
    </span>
  );
};

// Short labels under the icons — the full stage name is in the tooltip, but a
// track nobody can read is just decoration.
const STEP_SHORT = {
  ONBOARDING: 'Onboard',
  PROBATION: 'Probation',
  CONFIRMED: 'Confirmed',
  NOTICE_PERIOD: 'Notice',
  EXITED: 'Exit',
  ALUMNI: 'Alumni',
};

const Stepper = ({ stage }) => {
  const idx = STEPPER.indexOf(stage);
  // A single track that scrolls on a phone rather than wrapping into a ragged
  // second line with one icon on it.
  return (
    <div className="-mx-1 flex w-fit max-w-full items-start gap-1 overflow-x-auto px-1 pb-1">
      {STEPPER.map((s, i) => {
        const m = STAGE_META[s];
        const done = idx >= 0 && i < idx;
        const current = i === idx;
        return (
          <div key={s} className="flex shrink-0 items-start gap-1">
            {i > 0 && (
              <span className={`mt-[18px] h-px w-3 sm:w-4 ${done || current ? 'bg-crewly-green' : 'bg-crewly-border'}`} />
            )}
            <div className="flex w-14 flex-col items-center gap-1.5">
              <span
                title={m.label}
                className={`flex h-9 w-9 items-center justify-center rounded-full border ${
                  current
                    ? 'border-crewly-green bg-crewly-selected text-crewly-selected-text ring-2 ring-crewly-green/30'
                    : done
                      ? 'border-crewly-green/50 bg-crewly-green/10 text-crewly-green'
                      : 'border-crewly-border bg-crewly-inset text-crewly-dim opacity-60'
                }`}
              >
                {done ? <Check className="h-4 w-4" /> : <m.Icon className="h-4 w-4" />}
              </span>
              <span
                className={`text-center text-[10px] leading-tight ${
                  current ? 'font-semibold text-crewly-text' : 'text-crewly-dim'
                }`}
              >
                {STEP_SHORT[s]}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
};

// One sentence about where this person is, built only from dates the API
// returned. No milestone is promised that the record does not contain.
const stageNarrative = (journey) => {
  const left = daysTo;
  if (!journey) return '';
  const stage = journey.stage;
  if (stage === 'PROBATION' && journey.probationEndsOn) {
    const d = left(journey.probationEndsOn);
    return d === null
      ? ''
      : d >= 0
        ? `On probation until ${fmtDate(journey.probationEndsOn)} — ${d} day${d === 1 ? '' : 's'} to review.`
        : `Probation ended ${fmtDate(journey.probationEndsOn)} — confirmation is overdue.`;
  }
  if (stage === 'CONFIRMED' && journey.confirmedOn) {
    return `Confirmed on ${fmtDate(journey.confirmedOn)}${journey.joinedOn ? `, after joining on ${fmtDate(journey.joinedOn)}` : ''}.`;
  }
  if (stage === 'NOTICE_PERIOD' && journey.noticeEndsOn) {
    const d = left(journey.noticeEndsOn);
    return d === null ? '' : `Notice period ends ${fmtDate(journey.noticeEndsOn)} — ${Math.max(0, d)} day${d === 1 ? '' : 's'} left.`;
  }
  if (stage === 'EXITED' && journey.exitedOn) return `Left the company on ${fmtDate(journey.exitedOn)}.`;
  if (stage === 'ALUMNI' && journey.alumniSince) return `Alumni since ${fmtDate(journey.alumniSince)}.`;
  if (stage === 'ONBOARDING' && journey.joinedOn) return `Joined ${fmtDate(journey.joinedOn)} — onboarding in progress.`;
  return '';
};

const Timeline = ({ events = [] }) => (
  <div>
    {[...events].sort((a, b) => new Date(b.at) - new Date(a.at)).map((e) => {
      const Icon = EVENT_ICONS[e.type] || History;
      return (
        <div key={e._id} className="relative border-l-2 border-crewly-border pb-4 pl-5">
          <span className="absolute -left-[9px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-crewly-inset-strong text-crewly-dim">
            <Icon className="h-2.5 w-2.5" />
          </span>
          <p className="text-sm font-semibold">{e.title}</p>
          {e.note ? <p className="text-xs text-crewly-dim">“{e.note}”</p> : null}
          <p className="text-[11px] text-crewly-dim">{fmtDate(e.at)}{e.by?.name ? ` · by ${e.by.name}` : ''}</p>
        </div>
      );
    })}
  </div>
);

// "Review in 4 days" / "Notice ends in 6 days" — the one clock that matters for
// the stages that have one. Nothing is shown for stages that do not.
const timingOf = (record) => {
  if (!record) return '';
  if (record.stage === 'PROBATION' && record.probationEndsOn) {
    const d = daysTo(record.probationEndsOn);
    if (d === null) return '';
    return d >= 0 ? `Review in ${d}d` : `Overdue ${Math.abs(d)}d`;
  }
  if (record.stage === 'NOTICE_PERIOD' && record.noticeEndsOn) {
    const d = daysTo(record.noticeEndsOn);
    return d === null ? '' : `Notice ends in ${Math.max(0, d)}d`;
  }
  return '';
};

const JourneyCard = ({ journey, actionsSlot }) => {
  if (!journey) return null;
  const u = journey.user || {};
  const meta = [
    journey.probationEndsOn && ['Probation ends', journey.probationEndsOn],
    journey.confirmedOn && ['Confirmed', journey.confirmedOn],
    journey.noticeEndsOn && ['Notice ends', journey.noticeEndsOn],
    journey.exitedOn && ['Exited', journey.exitedOn],
    journey.alumniSince && ['Alumni since', journey.alumniSince],
  ].filter(Boolean);

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex flex-wrap items-start gap-3">
          {u.avatarUrl ? (
            <img src={u.avatarUrl} alt="" className="h-12 w-12 shrink-0 rounded-xl object-cover ring-1 ring-crewly-border" />
          ) : (
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-crewly-green/15 text-base font-bold text-crewly-green">
              {initials(u.name)}
            </span>
          )}
          <div className="min-w-[12rem] flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-bold">{u.name || 'My journey'}</h2>
              <StageBadge stage={journey.stage} />
            </div>
            <p className="mt-0.5 text-xs text-crewly-dim">
              {uniqueParts([u.designation || u.role, u.department?.name, journey.joinedOn ? `joined ${fmtDate(journey.joinedOn)}` : null])
                .join(' · ')}
            </p>
            {u.employeeCode || u.email ? (
              <p className="mt-0.5 text-[11px] text-crewly-dim">
                {[u.employeeCode ? `ID ${u.employeeCode}` : null, u.email].filter(Boolean).join(' · ')}
              </p>
            ) : null}
          </div>
        </div>

        <div className="mt-4 rounded-xl bg-crewly-inset/60 p-3">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">Current journey track</p>
            <p className="text-[11px] font-semibold text-crewly-dim">
              Stage {STEPPER.indexOf(journey.stage) + 1} of {STEPPER.length}
            </p>
          </div>
          <Stepper stage={journey.stage} />
          {stageNarrative(journey) ? (
            <p className="mt-2 flex items-start gap-2 text-xs leading-relaxed text-crewly-dim">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {stageNarrative(journey)}
            </p>
          ) : null}
        </div>

        {meta.length > 0 && (
          <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
            {meta.map(([label, value]) => (
              <div key={label} className="rounded-lg border border-crewly-border px-3 py-2">
                <dt className="text-[11px] uppercase tracking-wide text-crewly-dim">{label}</dt>
                <dd className="mt-0.5 font-semibold">{fmtDate(value)}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      {actionsSlot}

      <div className="card">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-bold">
          <History className="h-4 w-4 text-crewly-dim" />Timeline
        </h3>
        {journey.events?.length ? (
          <Timeline events={journey.events} />
        ) : (
          <p className="text-sm text-crewly-dim">No events recorded yet. Stage changes, promotions and transfers appear here.</p>
        )}
      </div>
    </div>
  );
};

const Tile = ({ icon: Icon, label, value, sub, active, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`flex items-start gap-3 p-4 text-left transition sm:p-5 ${
      active ? 'bg-crewly-selected' : 'bg-crewly-card hover:bg-crewly-inset'
    }`}
  >
    <div className="min-w-0 flex-1">
      <p className={`text-[11px] font-semibold uppercase tracking-[0.1em] ${active ? 'text-crewly-selected-text' : 'text-crewly-dim'}`}>{label}</p>
      <p className="mt-1.5 text-xl font-bold leading-tight sm:text-2xl">{value}</p>
      {sub ? <p className={`mt-1 text-xs leading-snug ${active ? 'text-crewly-selected-text/80' : 'text-crewly-dim'}`}>{sub}</p> : null}
    </div>
    <Icon className="mt-0.5 h-4 w-4 shrink-0 opacity-70" aria-hidden="true" />
  </button>
);

export default function LifecyclePage() {
  const me = useSelector((s) => s.auth.user);
  const isHR = ['COMPANY_ADMIN', 'HR_MANAGER'].includes(me?.role);

  const [list, setList] = useState([]);
  const [overview, setOverview] = useState(null);
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState('');
  const [tab, setTab] = useState('ALL');
  const [journey, setJourney] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [busy, setBusy] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [action, setAction] = useState(null);
  const [form, setForm] = useState({ note: '', probationMonths: 3, noticeDays: 30, designation: '', role: '', departmentId: '' });

  const flash = (ok, text) => {
    const body = typeof text === 'string' && text ? text : '';

    if (!body) return;

    if (ok) notify.success(body);
    else notify.error(body);
  };

  const loadList = async () => setList(await getCompanyLifecycles(stageFilter || undefined));
  useEffect(() => { if (isHR) loadList(); }, [isHR, stageFilter]);
  useEffect(() => { if (isHR) getOverview().then(setOverview).catch(() => setOverview(null)); }, [isHR]);
  useEffect(() => { if (!isHR) getMyJourney().then(setJourney).catch(() => {}); }, [isHR]);
  useEffect(() => { if (isHR) getDepartments().then(setDepartments); }, [isHR]);

  const openJourney = async (userId) => {
    setBusy(true);
    try { setJourney(await getUserJourney(userId)); }
    catch { flash(false, 'Could not open journey'); }
    finally { setBusy(false); }
  };

  const run = async () => {
    const uid = journey?.user?._id;
    if (!uid) return;
    setBusy(true);
    try {
      const note = form.note.trim();
      let res;
      if (action === 'promote') res = await promoteUser(uid, { designation: form.designation, role: form.role, note });
      else if (action === 'transfer') res = await transferUser(uid, { departmentId: form.departmentId, note });
      else if (action === 'confirm') res = await setStage(uid, { to: 'CONFIRMED', note });
      else if (action === 'probation') res = await setStage(uid, { to: 'PROBATION', note, probationMonths: form.probationMonths });
      else if (action === 'extend') res = await setStage(uid, { to: 'PROBATION', note, probationMonths: form.probationMonths });
      else if (action === 'notice') res = await setStage(uid, { to: 'NOTICE_PERIOD', note, noticeDays: form.noticeDays });
      else if (action === 'exit') res = await setStage(uid, { to: 'EXITED', note });
      else if (action === 'alumni') res = await setStage(uid, { to: 'ALUMNI', note });
      const data = res?.data ?? res;
      setJourney((data?.data ?? data) || journey);
      setAction(null);
      setForm({ note: '', probationMonths: 3, noticeDays: 30, designation: '', role: '', departmentId: '' });
      flash(true, 'Done — employee notified');
      loadList();
      getOverview().then(setOverview).catch(() => {});
    } catch (e) {
      flash(false, e?.response?.data?.message || 'Action failed');
    } finally { setBusy(false); }
  };

  const actions = useMemo(() => {
    if (!journey) return [];
    const s = journey.stage;
    const A = [];
    if (['ONBOARDING', 'CONFIRMED'].includes(s)) A.push({ id: 'probation', label: 'Start probation', Icon: Hourglass, cls: 'btn-ghost' });
    if (['ONBOARDING', 'PROBATION'].includes(s)) A.push({ id: 'confirm', label: 'Confirm employment', Icon: PartyPopper, cls: 'bg-crewly-green/15 text-crewly-green hover:bg-crewly-green/25 border border-crewly-green/30' });
    if (s === 'PROBATION') A.push({ id: 'extend', label: 'Extend probation', Icon: Hourglass, cls: 'btn-ghost' });
    if (['ONBOARDING', 'PROBATION', 'CONFIRMED'].includes(s)) {
      A.push({ id: 'promote', label: 'Promote', Icon: Rocket, cls: 'btn-primary' });
      A.push({ id: 'transfer', label: 'Transfer', Icon: Repeat, cls: 'btn-ghost' });
      A.push({ id: 'notice', label: 'Start notice', Icon: FileText, cls: 'bg-crewly-orange/15 text-crewly-orange hover:bg-crewly-orange/25 border border-crewly-orange/30' });
    }
    if (['NOTICE_PERIOD', 'ONBOARDING', 'PROBATION', 'CONFIRMED'].includes(s)) {
      A.push({ id: 'exit', label: 'Complete exit', Icon: DoorOpen, cls: 'bg-crewly-red/15 text-crewly-red hover:bg-crewly-red/25 border border-crewly-red/30' });
    }
    if (s === 'EXITED') A.push({ id: 'alumni', label: 'Mark alumni (FnF done)', Icon: GraduationCap, cls: 'btn-ghost' });
    return A;
  }, [journey]);

  const dueSoon = (rec) => {
    if (rec.stage === 'PROBATION') {
      const d = daysTo(rec.probationEndsOn);
      return d !== null && d <= 30;
    }
    if (rec.stage === 'NOTICE_PERIOD') {
      const d = daysTo(rec.noticeEndsOn);
      return d !== null && d <= 30;
    }
    return false;
  };

  const inTab = (rec) => {
    if (tab === 'ALL') return true;
    if (tab === 'CONFIRMED') return rec.stage === 'CONFIRMED';
    if (tab === 'SOON') return dueSoon(rec);
    return true;
  };

  const filtered = list
    .filter(inTab)
    .filter((r) => `${r.user?.name || ''} ${r.user?.email || ''} ${r.user?.designation || ''}`.toLowerCase().includes(search.toLowerCase()));

  const counts = overview?.counts || {};
  const total = overview?.total ?? list.length;
  const countOf = (stage) => counts[stage] ?? list.filter((r) => r.stage === stage).length;
  const probationRadar = overview?.probationEnding?.length ?? list.filter(dueSoon).length;
  const offboarding = countOf('NOTICE_PERIOD') + countOf('EXITED') + countOf('ALUMNI');
  const confirmedPct = total ? Math.round((countOf('CONFIRMED') / total) * 100) : 0;
  const soonCount = list.filter(dueSoon).length;

  const exportMatrix = () => {
    const rows = [
      ['Name', 'Role', 'Department', 'Stage', 'Joined', 'Probation ends', 'Confirmed on', 'Notice ends'],
      ...filtered.map((r) => [
        r.user?.name || '',
        r.user?.role || '',
        r.user?.department?.name || '',
        STAGE_META[r.stage]?.label || r.stage,
        r.joinedOn ? String(r.joinedOn).slice(0, 10) : '',
        r.probationEndsOn ? String(r.probationEndsOn).slice(0, 10) : '',
        r.confirmedOn ? String(r.confirmedOn).slice(0, 10) : '',
        r.noticeEndsOn ? String(r.noticeEndsOn).slice(0, 10) : '',
      ]),
    ];
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `lifecycle-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /* ───────── EMPLOYEE VIEW ───────── */
  if (!isHR) {
    return (
      <div className="mx-auto max-w-3xl space-y-5">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-crewly-green/15 text-crewly-green">
            <Dna className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-xl font-bold sm:text-2xl">My Journey</h1>
            <p className="mt-1 text-sm text-crewly-dim">Where you are in the employee lifecycle, and what happened to get you there.</p>
          </div>
        </div>
        {journey ? (
          <JourneyCard journey={journey} />
        ) : (
          <p className="card p-8 text-center text-sm text-crewly-dim">Loading your journey…</p>
        )}
      </div>
    );
  }

  /* ───────── HR CONSOLE ───────── */
  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-crewly-green/15 text-crewly-green">
            <Dna className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold sm:text-2xl">Employee Lifecycle</h1>
              {total > 0 ? (
                <span className="rounded-full bg-crewly-green/15 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-crewly-green">
                  {total} active track{total === 1 ? '' : 's'}
                </span>
              ) : null}
            </div>
            <p className="mt-1 max-w-xl text-sm leading-relaxed text-crewly-dim">
              Every active track — who is onboarding, who is on probation, who is confirmed, and who is
              on their way out. Stage changes notify the employee.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
          <button type="button" className="btn-ghost w-full justify-center gap-2 text-sm sm:w-auto" onClick={() => setRulesOpen(true)}>
            <ScrollText className="h-4 w-4" />Stage rules
          </button>
          <button type="button" className="btn-primary w-full justify-center gap-2 text-sm sm:w-auto" onClick={exportMatrix}>
            <Download className="h-4 w-4" />Export matrix
          </button>
        </div>
      </div>

      {/* ── stage census ───────────────────────────────────────────────── */}
      <div className="card grid grid-cols-2 gap-px overflow-hidden border-crewly-border bg-crewly-border p-0 sm:grid-cols-2 xl:grid-cols-4">
        <Tile
          icon={Briefcase}
          label="Onboarding"
          value={countOf('ONBOARDING')}
          sub="Starting with the company"
          active={stageFilter === 'ONBOARDING'}
          onClick={() => { setTab('ALL'); setStageFilter(stageFilter === 'ONBOARDING' ? '' : 'ONBOARDING'); }}
        />
        <Tile
          icon={Hourglass}
          label="Probation"
          value={countOf('PROBATION')}
          sub={probationRadar ? `${probationRadar} ending within 30 days` : 'None ending in 30 days'}
          active={stageFilter === 'PROBATION'}
          onClick={() => { setTab('ALL'); setStageFilter(stageFilter === 'PROBATION' ? '' : 'PROBATION'); }}
        />
        <Tile
          icon={CheckCircle2}
          label="Confirmed"
          value={countOf('CONFIRMED')}
          sub={`${confirmedPct}% of ${total} track${total === 1 ? '' : 's'}`}
          active={stageFilter === 'CONFIRMED'}
          onClick={() => { setTab('CONFIRMED'); setStageFilter(''); }}
        />
        <Tile
          icon={DoorOpen}
          label="Offboarding"
          value={offboarding}
          sub="Notice, exited and alumni"
          active={stageFilter === 'NOTICE_PERIOD'}
          onClick={() => { setTab('ALL'); setStageFilter(stageFilter === 'NOTICE_PERIOD' ? '' : 'NOTICE_PERIOD'); }}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[340px_1fr]">
        {/* ── people ───────────────────────────────────────────────────── */}
        <aside className="card h-fit p-3">
          <div className="relative mb-2">
            <Users className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-crewly-dim" />
            <input
              className="input pl-9"
              placeholder="Search name, role or email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search employees"
            />
          </div>

          <select
            className="input mb-2 py-2 text-sm"
            value={stageFilter}
            onChange={(e) => { setTab('ALL'); setStageFilter(e.target.value); }}
            aria-label="Filter by stage"
          >
            <option value="">All stages</option>
            {Object.entries(STAGE_META).map(([value, meta]) => (
              <option key={value} value={value}>{meta.label}</option>
            ))}
          </select>

          <div className="-mx-1 mb-2 flex items-center gap-1 overflow-x-auto px-1 pb-1">
            {[
              ['ALL', 'All', list.length],
              ['SOON', 'Due soon', soonCount],
              ['CONFIRMED', 'Confirmed', countOf('CONFIRMED')],
            ].map(([id, label, count]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                aria-pressed={tab === id}
                className={`shrink-0 rounded-lg px-2.5 py-1 text-xs transition ${
                  tab === id ? 'bg-crewly-selected font-semibold text-crewly-selected-text' : 'text-crewly-dim hover:bg-crewly-inset'
                }`}
              >
                {label} ({count})
              </button>
            ))}
          </div>

          <div className="max-h-[56vh] space-y-1 overflow-y-auto">
            {filtered.map((r) => {
              const active = journey?.user?._id === r.user?._id;
              return (
                <button
                  key={r._id}
                  type="button"
                  onClick={() => openJourney(r.user?._id)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition ${
                    active ? 'bg-crewly-selected' : 'hover:bg-crewly-inset'
                  }`}
                >
                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold ${
                    active ? 'bg-crewly-card text-crewly-selected-text' : 'bg-crewly-inset text-crewly-dim'
                  }`}>
                    {initials(r.user?.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-sm font-semibold ${active ? 'text-crewly-selected-text' : ''}`}>
                      {r.user?.name || '—'}
                    </span>
                    <span className={`block truncate text-xs ${active ? 'text-crewly-selected-text/80' : 'text-crewly-dim'}`}>
                      {r.user?.designation || r.user?.role} · {r.user?.department?.name || 'Unassigned'}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <StageBadge stage={r.stage} />
                      {r.user?.employeeCode ? (
                        <span className={`text-[10px] uppercase tracking-wide ${active ? 'text-crewly-selected-text/70' : 'text-crewly-dim'}`}>
                          {r.user.employeeCode}
                        </span>
                      ) : null}
                      {timingOf(r) ? (
                        <span className={`text-[10px] font-semibold ${active ? 'text-crewly-selected-text/80' : 'text-crewly-orange'}`}>
                          {timingOf(r)}
                        </span>
                      ) : null}
                    </span>
                  </span>
                  <ChevronRight className={`h-4 w-4 shrink-0 ${active ? 'text-crewly-selected-text' : 'text-crewly-dim'}`} />
                </button>
              );
            })}
            {filtered.length === 0 && (
              <EmptyState
                illustration="team"
                title="No records"
                description="Nobody matches this search, stage or tab. Clear them to list every track in the company."
                size="sm"
              />
            )}
          </div>
        </aside>

        <section>
          {!journey ? (
            <div className="card">
              <EmptyState
                illustration="calendar"
                title="Pick an employee"
                description="Choose someone on the left to see their journey — onboarding, confirmation, role changes and exit dates in one timeline."
              />
            </div>
          ) : (
            <JourneyCard
              journey={journey}
              actionsSlot={
                <div className="card flex flex-wrap items-center gap-2 p-3">
                  <span className="mr-1 text-[11px] font-bold uppercase tracking-wide text-crewly-dim">Next step</span>
                  {actions.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      disabled={busy}
                      onClick={() => setAction(a.id)}
                      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition disabled:opacity-50 ${a.cls}`}
                    >
                      <a.Icon className="h-3.5 w-3.5" />{a.label}
                    </button>
                  ))}
                  {actions.length === 0 && (
                    <span className="text-xs text-crewly-dim">No transition is possible from this stage.</span>
                  )}
                </div>
              }
            />
          )}
        </section>
      </div>

      {rulesOpen && (
        <Modal title="Stage rules" onClose={() => setRulesOpen(false)}>
          <p className="mb-3 text-sm text-crewly-dim">
            These are the transitions the lifecycle API accepts. Anything else is rejected server-side —
            this dialog only documents the graph.
          </p>
          <ul className="space-y-2">
            {Object.entries(TRANSITIONS).map(([from, to]) => (
              <li key={from} className="flex flex-wrap items-center gap-2 rounded-lg border border-crewly-border px-3 py-2">
                <StageBadge stage={from} />
                <ChevronRight className="h-3.5 w-3.5 text-crewly-dim" />
                {to.length ? (
                  <span className="text-xs text-crewly-dim">{to.join(' · ')}</span>
                ) : (
                  <span className="text-xs text-crewly-dim">Final stage — no further moves</span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-3 flex items-start gap-2 text-xs text-crewly-dim">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Probation → Probation is an extension; it is the only move that keeps the same stage.
          </p>
        </Modal>
      )}

      {action && (
        <Modal title={`${actions.find((a) => a.id === action)?.label} — ${journey?.user?.name || ''}`} onClose={() => setAction(null)}>
          <div className="space-y-3">
            {action === 'promote' && (
              <>
                <div>
                  <label className="label" htmlFor="lc-designation">New designation</label>
                  <input id="lc-designation" className="input" placeholder="e.g. Senior Developer" value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} />
                </div>
                <div>
                  <label className="label" htmlFor="lc-role">Role</label>
                  <select id="lc-role" className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                    <option value="">Keep current role</option>
                    <option value="EMPLOYEE">EMPLOYEE</option>
                    <option value="TEAM_LEAD">TEAM_LEAD</option>
                    <option value="MANAGER">MANAGER</option>
                    {me?.role === 'COMPANY_ADMIN' && <option value="HR_MANAGER">HR_MANAGER</option>}
                  </select>
                </div>
              </>
            )}
            {action === 'transfer' && (
              <div>
                <label className="label" htmlFor="lc-dept">New department</label>
                <select id="lc-dept" className="input" value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}>
                  <option value="">Pick a department…</option>
                  {departments.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
                </select>
              </div>
            )}
            {(action === 'probation' || action === 'extend') && (
              <div>
                <label className="label" htmlFor="lc-months">Probation length (months)</label>
                <input id="lc-months" type="number" min="1" max="24" className="input" value={form.probationMonths} onChange={(e) => setForm({ ...form, probationMonths: e.target.value })} />
              </div>
            )}
            {action === 'notice' && (
              <div>
                <label className="label" htmlFor="lc-days">Notice period (days)</label>
                <input id="lc-days" type="number" min="1" max="180" className="input" value={form.noticeDays} onChange={(e) => setForm({ ...form, noticeDays: e.target.value })} />
              </div>
            )}
            {action === 'exit' && (
              <p className="rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-3 py-2 text-xs text-crewly-red">
                <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
                This deactivates the account — login stops. Best done on their last working day.
              </p>
            )}
            <div>
              <label className="label" htmlFor="lc-note">Note (optional)</label>
              <textarea
                id="lc-note"
                className="input min-h-[70px]"
                placeholder="Shows in the timeline and the employee's notification"
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setAction(null)} className="btn-ghost text-sm">Cancel</button>
              <button type="button" onClick={run} disabled={busy} className="btn-primary text-sm">
                {busy ? 'Working…' : 'Confirm'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
