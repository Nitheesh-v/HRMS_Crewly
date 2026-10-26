// ============================================================
// Performance Management
// Employee: goals → progress → self review → final rating + history
// Seniors: team review board · HR: cycle controls
// ============================================================
import { useEffect, useMemo, useState } from 'react';
import { Briefcase, Check, CheckCircle2, Circle, ClipboardList, FileText, History, Hourglass, Lock, Pencil, Plus, Save, Scale, SkipForward, Star, Target, Trash2, User, UserPlus, Users, X } from 'lucide-react';
import { useSelector } from 'react-redux';
import {
  getCycles, getCycleCohort, getMyAppraisal, getTeamBoard, createCycle, transitionCycle,
  saveGoals, updateProgress, submitSelfReview, submitReview, getHistory, enrollMissing, startCycle,
} from '../../services/perfService.js';
import { notify } from '../../utils/notify.js';
import EmptyState from '../../components/common/EmptyState.jsx';

const inp = 'input';
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

const PHASES = ['GOAL_SETTING', 'ACTIVE', 'SELF_REVIEW', 'REVIEW', 'CLOSED'];
const PHASE_LABEL = { GOAL_SETTING: 'Set goals', ACTIVE: 'Work period', SELF_REVIEW: 'Self review', REVIEW: 'TL + Manager review', CLOSED: 'Rating published' };
const STATUS_CHIP = {
  GOALS: 'bg-slate-500/20 text-slate-300', IN_PROGRESS: 'bg-sky-400/15 text-sky-300',
  SELF_SUBMITTED: 'bg-amber-400/15 text-amber-300', TL_DONE: 'bg-crewly-green/15 text-crewly-green',
  MGR_DONE: 'bg-purple-400/15 text-purple-300', CLOSED: 'bg-emerald-400/15 text-emerald-300',
};

/* The three rounds the API can store. The copy is what each one actually
   collects in this product — no scoring promise is made that the weights
   below do not already implement (Self 20 · TL 30 · Manager 50). */
const METHODOLOGIES = [
  {
    id: 'STANDARD',
    label: 'Standard annual',
    detail: 'Self review + direct manager rating.',
  },
  {
    id: 'THREE_SIXTY',
    label: '360° comprehensive',
    detail: 'The same round, with peer input collected alongside it.',
  },
  {
    id: 'OKR',
    label: 'Goal check-in',
    detail: 'Goals and KPI progress only — no rating round.',
  },
];
const METHOD_LABEL = Object.fromEntries(METHODOLOGIES.map((m) => [m.id, m.label]));

/* One radio card, selected the way the owner's mock shows it: the tick sits
   in the card's top-right corner, not in a column down the left. The radio
   input stays real (visually hidden) so the group is still arrow-key
   navigable and screen readers announce a radio group. */
const MethodCard = ({ option, checked, onSelect }) => (
  <label
    className={`relative flex min-h-[84px] cursor-pointer flex-col rounded-xl border p-3 pr-9 text-left transition ${
      checked
        ? 'border-crewly-green bg-crewly-green/[0.08]'
        : 'border-crewly-border bg-crewly-card hover:bg-crewly-inset'
    }`}
  >
    <input
      type="radio"
      name="cycle-methodology"
      value={option.id}
      checked={checked}
      onChange={() => onSelect(option.id)}
      className="sr-only"
    />
    <span
      aria-hidden="true"
      className={`absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full ${
        checked ? 'text-crewly-green' : 'text-crewly-dim'
      }`}
    >
      {checked ? <CheckCircle2 className="h-5 w-5" /> : <Circle className="h-4 w-4" />}
    </span>
    <span className="block text-sm font-semibold">{option.label}</span>
    <span className="mt-0.5 block text-[11px] leading-snug text-crewly-dim">{option.detail}</span>
  </label>
);

/* A switch, not a checkbox: the mock uses one, and "on/off for the whole
   round" reads as a setting rather than as one item in a list. */
const Switch = ({ id, checked, onChange, label, description }) => (
  <div className="flex items-start justify-between gap-3 py-2">
    <div className="min-w-0">
      <label htmlFor={id} className="block cursor-pointer text-xs font-semibold">{label}</label>
      {description ? <p className="mt-0.5 text-[11px] leading-snug text-crewly-dim">{description}</p> : null}
    </div>
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition ${
        checked ? 'bg-crewly-green' : 'bg-crewly-inset-heavy'
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full transition-all ${
          checked ? 'left-[18px] bg-crewly-card' : 'left-0.5 bg-crewly-card'
        }`}
      />
    </button>
  </div>
);

const Stars = ({ value, onChange, size = 'h-6 w-6', className = '' }) => (
  <span className={`inline-flex gap-1 ${className}`}>
    {[1, 2, 3, 4, 5].map((n) => (
      <button
        key={n} type="button"
        onClick={() => onChange && onChange(n)}
        className={`${onChange ? 'cursor-pointer' : 'cursor-default'} transition ${value >= n ? 'text-amber-400' : 'text-slate-600'}`}
      >
        <Star className={size} fill="currentColor" strokeWidth={0} />
      </button>
    ))}
  </span>
);

/* The round moves through five phases in a fixed order, so the order IS the
   information: numbers on a track, each phase named underneath. */
const PhaseStepper = ({ status }) => {
  const idx = PHASES.indexOf(status);
  return (
    <ol className="flex w-full items-start justify-between gap-1 sm:w-fit sm:justify-start">
      {PHASES.map((p, i) => {
        const done = idx > i;
        const current = i === idx;
        return (
          <li key={p} className="flex shrink-0 items-start gap-1">
            {i > 0 && (
              <span className={`mt-[13px] h-px w-4 sm:w-6 ${done || current ? 'bg-crewly-green' : 'bg-crewly-border'}`} />
            )}
            <div className="flex w-9 flex-col items-center gap-1 sm:w-24">
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-full border text-[11px] font-bold ${
                  current
                    ? 'border-crewly-green bg-crewly-selected text-crewly-selected-text ring-2 ring-crewly-green/25'
                    : done
                      ? 'border-crewly-green/50 bg-crewly-green/10 text-crewly-green'
                      : 'border-crewly-border bg-crewly-inset text-crewly-dim'
                }`}
              >
                {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span
                className={`hidden text-center text-[10px] leading-tight sm:block ${
                  current ? 'font-semibold text-crewly-text' : 'text-crewly-dim'
                }`}
              >
                {PHASE_LABEL[p]}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
};

/* A counted number with its caption. None of these tiles is clickable: unlike
   the lifecycle census, filtering the page by "waiting on you" would hide the
   goals the same person still has to write. */
const Stat = ({ icon: Icon, label, value, sub, tone }) => (
  <div className="flex items-start gap-3 bg-crewly-card p-4 sm:p-5">
    <div className="min-w-0 flex-1">
      <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">{label}</p>
      <p className={`mt-1.5 text-xl font-bold leading-tight sm:text-2xl ${tone === 'accent' ? 'text-crewly-orange' : ''}`}>
        {value}
      </p>
      {sub ? <p className="mt-1 text-xs leading-snug text-crewly-dim">{sub}</p> : null}
    </div>
    <Icon className="mt-0.5 h-4 w-4 shrink-0 opacity-70" aria-hidden="true" />
  </div>
);

/* The goal's own number, drawn as the bar it already is. Nothing here is a
   benchmark — the fill is the progress the record holds. */
const ProgressBar = ({ value, className = '' }) => (
  <span className={`block h-1.5 w-full overflow-hidden rounded-full bg-crewly-inset-strong ${className}`}>
    <span
      className="block h-full rounded-full bg-crewly-green"
      style={{ width: `${Math.min(100, Math.max(0, Number(value) || 0))}%` }}
    />
  </span>
);

const initials = (name = '') =>
  name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || '?';

/* The three signatures a cycle collects, as one line of gates. */
const Gates = ({ appraisal }) => (
  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-crewly-dim">
    {[
      ['Self', appraisal.selfReview?.submittedAt || appraisal.selfReview?.at],
      ['TL', appraisal.tlReview?.at],
      ['Mgr', appraisal.mgrReview?.at],
    ].map(([label, done]) => (
      <span key={label} className="inline-flex items-center gap-1">
        {done ? (
          <Check className="h-3 w-3 text-crewly-green" aria-hidden="true" />
        ) : (
          <Hourglass className="h-3 w-3 text-crewly-orange" aria-hidden="true" />
        )}
        {label}
      </span>
    ))}
  </span>
);

export default function PerformancePage() {
  const me = useSelector((s) => s.auth.user);
  const isHR = ['COMPANY_ADMIN', 'HR_MANAGER'].includes(me?.role);
  const isSenior = isHR || ['MANAGER', 'TEAM_LEAD'].includes(me?.role);

  const [cyclesBox, setCyclesBox] = useState({ cycles: [], currentId: null });
  const [mine, setMine] = useState(null);          // { appraisal, cycle }
  const [team, setTeam] = useState([]);
  const [historyRows, setHistoryRows] = useState([]);
  const [goalsDraft, setGoalsDraft] = useState([]);
  const [selfForm, setSelfForm] = useState({ summary: '', rating: 0 });
  const [reviewTarget, setReviewTarget] = useState(null); // appraisal being reviewed
  const [reviewForm, setReviewForm] = useState({ rating: 0, feedback: '' });
  const [cycleForm, setCycleForm] = useState({
    name: '',
    startDate: '',
    endDate: '',
    methodology: 'STANDARD',
    selfReviewDueAt: '',
    managerReviewDueAt: '',
    calibrationDueAt: '',
    excludeProbation: false,
    notifyParticipants: true,
  });
  const [cohort, setCohort] = useState(null);
  const [cohortBusy, setCohortBusy] = useState(false);
  const [showNewCycle, setShowNewCycle] = useState(false);
  const [busy, setBusy] = useState(false);

  const current = useMemo(() => {
    const list = cyclesBox.cycles || [];
    return list.find((c) => c._id === cyclesBox.currentId) || list[0] || null;
  }, [cyclesBox]);

  /* 35.1 — feedback is a toast now; the signature is unchanged. */
  /* 35.1 — feedback is a toast now; the signature is unchanged. */
  const flash = (ok, text) => {
    const body = typeof text === 'string' && text ? text : '';

    if (!body) return;

    if (ok) notify.success(body);
    else notify.error(body);
  };

  const loadAll = async () => {
    try {
      const box = await getCycles();
      setCyclesBox(Array.isArray(box) ? { cycles: box, currentId: null } : box);
      const cycleId = (Array.isArray(box) ? box : box.cycles)?.find((c) => c._id === (box.currentId))?._id
        || (Array.isArray(box) ? box[0] : box.cycles[0])?._id;
      if (cycleId) {
        try {
          const m = await getMyAppraisal(cycleId);
          setMine(m);
          setGoalsDraft(m?.appraisal?.goals || []);
          setSelfForm({
            summary: m?.appraisal?.selfReview?.summary || '',
            rating: m?.appraisal?.selfReview?.rating || 0,
          });
        } catch { setMine(null); }
        if (isSenior) {
          try {
            const t = await getTeamBoard(cycleId);
            setTeam(t?.appraisals || []);
          } catch { setTeam([]); }
        }
      }
      setHistoryRows(await getHistory());
      /* HR sees a participant count on the page, not only inside the dialog,
         so the cohort is read once on load. Failure leaves the tile at "—". */
      if (isHR) {
        try { setCohort(await getCycleCohort()); } catch { /* tile shows an em dash */ }
      }
    } catch {
      flash(false, 'Could not load performance data');
    }
  };
  useEffect(() => { loadAll(); }, []);

  const cycle = mine?.cycle || current;
  const drafts = (cyclesBox.cycles || []).filter((c) => c.isDraft);
  const app = mine?.appraisal;
  const phase = cycle?.status;
  const goalsEditable = ['GOAL_SETTING', 'ACTIVE'].includes(phase);

  /* ── actions ── */
  const openCycleModal = async () => {
    setShowNewCycle(true);
    if (!isHR) return;
    setCohortBusy(true);
    try { setCohort(await getCycleCohort()); }
    catch { setCohort(null); }
    finally { setCohortBusy(false); }
  };

  /* The number on the button is the number of people the API said it would
     enroll — minus the ones the toggle leaves out. Nothing is estimated. */
  const cohortIncluded = cohort
    ? Math.max(0, cohort.total - (cycleForm.excludeProbation ? cohort.onProbation : 0))
    : null;

  const doCreateCycle = async ({ draft = false } = {}) => {
    if (!cycleForm.name.trim()) return flash(false, 'Name the cycle first — e.g. "H2 2026"');
    if (cycleForm.startDate && cycleForm.endDate && cycleForm.endDate < cycleForm.startDate) {
      return flash(false, 'The cycle cannot end before it starts');
    }
    setBusy(true);
    try {
      await createCycle({ ...cycleForm, saveAsDraft: draft });
      setShowNewCycle(false);
      setCycleForm({
        name: '', startDate: '', endDate: '', methodology: 'STANDARD',
        selfReviewDueAt: '', managerReviewDueAt: '', calibrationDueAt: '',
        excludeProbation: false, notifyParticipants: true,
      });
      flash(
        true,
        draft
          ? 'Draft saved — nobody was enrolled or notified'
          : cycleForm.notifyParticipants
            ? 'Cycle started — everyone in the cohort was notified'
            : 'Cycle started — notifications kept off',
      );
      await loadAll();
    } catch (e) { flash(false, e?.response?.data?.message || 'Failed'); }
    finally { setBusy(false); }
  };

  const doAdvance = async () => {
    setBusy(true);
    try {
      await transitionCycle(cycle._id, PHASES[PHASES.indexOf(phase) + 1]);
      flash(true, `Phase → ${PHASE_LABEL[PHASES[PHASES.indexOf(phase) + 1]]}`);
      await loadAll();
    } catch (e) { flash(false, e?.response?.data?.message || 'Failed'); }
    finally { setBusy(false); }
  };

  /* Starting a draft is the only moment it enrolls anybody, so the label on
     the button says exactly that and the result is reported back in words. */
  const doStartDraft = async (draft) => {
    setBusy(true);
    try {
      await startCycle(draft._id, { notifyParticipants: draft.notifyParticipants !== false });
      flash(
        true,
        draft.notifyParticipants === false
          ? 'Cycle started — notifications kept off'
          : 'Cycle started — the cohort was notified',
      );
      await loadAll();
    } catch (e) { flash(false, e?.response?.data?.message || 'Could not start the draft'); }
    finally { setBusy(false); }
  };

  /* Re-enrolment keeps the cohort rule the round was created with (the server
     re-applies it), and the page reloads so the team board is not stale. */
  const doEnrollJoiners = async () => {
    if (!cycle) return;
    setBusy(true);
    try {
      await enrollMissing(cycle._id);
      flash(true, 'New joiners enrolled');
      await loadAll();
    } catch (e) {
      flash(false, e?.response?.data?.message || 'Could not enroll new joiners');
    } finally {
      setBusy(false);
    }
  };

  const doSaveGoals = async () => {
    setBusy(true);
    try {
      await saveGoals(app._id, goalsDraft);
      flash(true, 'Goals saved');
      await loadAll();
    } catch (e) { flash(false, e?.response?.data?.message || 'Failed'); }
    finally { setBusy(false); }
  };

  const doProgress = async (goalId, progress, note) => {
    try { await updateProgress(app._id, goalId, progress, note); await loadAll(); }
    catch (e) { flash(false, e?.response?.data?.message || 'Failed'); }
  };

  const doSelfReview = async () => {
    if (!selfForm.summary.trim() || !selfForm.rating) return flash(false, 'Summary + star rating needed');
    setBusy(true);
    try {
      await submitSelfReview(app._id, selfForm);
      flash(true, 'Self-review submitted');
      await loadAll();
    } catch (e) { flash(false, e?.response?.data?.message || 'Failed'); }
    finally { setBusy(false); }
  };

  const doReview = async () => {
    if (!reviewForm.rating) return flash(false, 'Pick a star rating');
    setBusy(true);
    try {
      await submitReview(reviewTarget._id, reviewForm);
      setReviewTarget(null); setReviewForm({ rating: 0, feedback: '' });
      flash(true, 'Review saved');
      await loadAll();
    } catch (e) { flash(false, e?.response?.data?.message || 'Failed'); }
    finally { setBusy(false); }
  };

  const setGoal = (i, patch) => setGoalsDraft((g) => g.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  /* Everything on this page is counted from what the API returned. A number
     with no source shows an em dash rather than a plausible zero. */
  const goalsSet = goalsDraft.filter((g) => String(g.title || '').trim()).length;
  const avgProgress = goalsDraft.length
    ? Math.round(goalsDraft.reduce((sum, g) => sum + (Number(g.progress) || 0), 0) / goalsDraft.length)
    : null;
  const weightTotal = goalsDraft.reduce((sum, g) => sum + (Number(g.weight) || 0), 0);
  const slotFor = (appraisal) => (me?.role === 'TEAM_LEAD' ? appraisal.tlReview : appraisal.mgrReview);
  const awaitingMe = team.filter(
    (appraisal) => !slotFor(appraisal)?.at && String(appraisal.user?._id) !== String(me?._id),
  ).length;
  const selfReviewsIn = team.filter((appraisal) => appraisal.selfReview?.submittedAt).length;
  const closedCycles = historyRows.length;
  const nextPhase = phase ? PHASES[PHASES.indexOf(phase) + 1] : null;

  const deadlines = cycle
    ? [
        ['Self review due', cycle.selfReviewDueAt],
        ['Manager rating due', cycle.managerReviewDueAt],
        ['Calibration & close', cycle.calibrationDueAt],
      ].filter(([, value]) => Boolean(value))
    : [];

  const stats = isHR
    ? [
        {
          icon: Users,
          label: 'Participants',
          value: cohort ? cohort.total : '—',
          sub: cohort
            ? `${cohort.onProbation} inside their first ${cohort.probationWindowDays} days`
            : 'Counted when a cycle dialog opens',
        },
        {
          icon: FileText,
          label: 'Self reviews in',
          value: team.length ? `${selfReviewsIn} / ${team.length}` : '—',
          sub: team.length ? 'In your review scope' : 'No appraisals in your scope',
        },
        {
          icon: Scale,
          label: 'Waiting on you',
          value: team.length ? awaitingMe : '—',
          sub: phase === 'REVIEW' ? 'Ratings you can write now' : 'Reviews open in the review phase',
          tone: awaitingMe ? 'accent' : undefined,
        },
        {
          icon: History,
          label: 'Cycles run',
          value: (cyclesBox.cycles || []).length,
          sub: closedCycles ? `${closedCycles} closed with a rating` : 'None closed yet',
        },
      ]
    : isSenior
      ? [
          {
            icon: FileText,
            label: 'Self reviews in',
            value: team.length ? `${selfReviewsIn} / ${team.length}` : '—',
            sub: team.length ? 'In your review scope' : 'Nobody in your scope',
          },
          {
            icon: Scale,
            label: 'Waiting on you',
            value: team.length ? awaitingMe : '—',
            sub: phase === 'REVIEW' ? 'Ratings you can write now' : 'Reviews open in the review phase',
            tone: awaitingMe ? 'accent' : undefined,
          },
          {
            icon: ClipboardList,
            label: 'My goals',
            value: goalsSet,
            sub: goalsDraft.length ? `${goalsDraft.length} on this cycle` : 'None written yet',
          },
          {
            icon: Target,
            label: 'My progress',
            value: avgProgress === null ? '—' : `${avgProgress}%`,
            sub: goalsDraft.length ? `Across ${goalsDraft.length} goals` : 'Add a goal to track',
          },
        ]
      : [
          {
            icon: ClipboardList,
            label: 'My goals',
            value: goalsSet,
            sub: goalsEditable ? 'Goal setting is open' : 'Goal setting is closed',
          },
          {
            icon: Target,
            label: 'My progress',
            value: avgProgress === null ? '—' : `${avgProgress}%`,
            sub: goalsDraft.length ? `Across ${goalsDraft.length} goals` : 'Add a goal to track',
          },
          {
            icon: FileText,
            label: 'Self review',
            value: app?.selfReview?.submittedAt ? 'In' : phase === 'SELF_REVIEW' ? 'Open' : '—',
            sub: app?.selfReview?.submittedAt
              ? `Submitted ${fmtDate(app.selfReview.submittedAt)}`
              : phase === 'SELF_REVIEW'
                ? 'Write it before the deadline'
                : ['REVIEW', 'CLOSED'].includes(phase)
                  ? 'Was not submitted'
                  : 'Opens after the work period',
          },
          {
            icon: Star,
            label: 'Final rating',
            value: app?.finalRating != null ? `${app.finalRating}` : '—',
            sub: app?.finalRating != null
              ? 'Out of 5, published'
              : phase === 'CLOSED'
                ? 'No rating was published for this round'
                : 'Published when the cycle closes',
          },
        ];

  return (
    <div className="space-y-5">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-crewly-border bg-crewly-inset/50 p-4 sm:p-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-crewly-inset text-crewly-green">
            <Target className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold sm:text-2xl">Performance</h1>
              {cycle ? (
                <span className="rounded-full bg-crewly-green/15 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-crewly-green">
                  {cycle.name}
                </span>
              ) : null}
              {cycle?.methodology ? (
                <span className="rounded-full bg-crewly-inset px-2.5 py-0.5 text-[11px] font-semibold text-crewly-dim">
                  {METHOD_LABEL[cycle.methodology] || cycle.methodology}
                </span>
              ) : null}
            </div>
            <p className="mt-1 max-w-2xl text-sm text-crewly-dim">
              {cycle
                ? `Goals, self reviews and manager ratings for one window. Your published rating appears when the cycle closes.`
                : isHR
                  ? 'Goals, self reviews and ratings live inside a cycle. Start one to open the window for everyone.'
                  : 'HR will open a review cycle. Your goals and self review will appear here when they do.'}
            </p>
          </div>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          {isHR ? (
            <button
              type="button"
              onClick={openCycleModal}
              className="btn-primary inline-flex flex-1 items-center justify-center gap-2 px-3 py-2 text-sm sm:flex-none"
            >
              <Plus className="h-4 w-4" />Start cycle
            </button>
          ) : null}
          {isHR && nextPhase ? (
            <button
              type="button"
              onClick={doAdvance}
              disabled={busy}
              className="btn-ghost inline-flex flex-1 items-center justify-center gap-2 px-3 py-2 text-sm disabled:opacity-50 sm:flex-none"
            >
              <SkipForward className="h-4 w-4" />Move to {PHASE_LABEL[nextPhase]}
            </button>
          ) : null}
        </div>
      </div>

      {/* ── counts ─────────────────────────────────────────────────────── */}
      <div className="card grid grid-cols-2 gap-px overflow-hidden border-crewly-border bg-crewly-border p-0 xl:grid-cols-4">
        {stats.map((stat) => <Stat key={stat.label} {...stat} />)}
      </div>

      {/* ── drafts ─────────────────────────────────────────────────────── */}
      {drafts.length ? (
        <section className="rounded-xl border border-dashed border-crewly-border bg-crewly-inset/40 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="card-title flex items-center gap-2 text-sm font-bold">
              <FileText className="h-4 w-4 text-crewly-dim" />Draft cycles
              <span className="rounded-full bg-crewly-card px-2 py-0.5 text-[11px] font-semibold text-crewly-dim">{drafts.length}</span>
            </h2>
            <p className="text-[11px] text-crewly-dim">Nothing is enrolled and nobody is notified until you start one.</p>
          </div>
          <ul className="mt-3 space-y-2">
            {drafts.map((draft) => (
              <li key={draft._id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-crewly-border bg-crewly-card px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{draft.name}</p>
                  <p className="truncate text-[11px] text-crewly-dim">
                    {METHOD_LABEL[draft.methodology] || 'Standard annual'}
                    {draft.startDate ? ` · starts ${fmtDate(draft.startDate)}` : ''}
                    {` · ${draft.excludeProbation ? 'probation excluded' : 'everyone included'}`}
                    {draft.notifyParticipants === false ? ' · launches quietly' : ''}
                  </p>
                </div>
                {isHR ? (
                  <button
                    type="button"
                    onClick={() => doStartDraft(draft)}
                    disabled={busy}
                    className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
                  >
                    Start now
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {!cycle ? (
        <div className="card p-0">
          <EmptyState
            illustration="chart"
            title="No performance cycle yet"
            description={
              isHR
                ? 'A cycle carries goals, self reviews and ratings for everyone in one window. Start one to open it.'
                : 'HR will open a review cycle soon. Your goals and self review will appear here when they do.'
            }
            action={isHR ? (
              <button type="button" onClick={openCycleModal} className="btn-primary">Start a cycle</button>
            ) : null}
          />
        </div>
      ) : (
        <>
          {/* ── the cycle: phase track, dates, HR controls ─────────────── */}
          <section className="card">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="card-title flex flex-wrap items-center gap-2 text-sm font-bold">
                  <Target className="h-4 w-4 text-crewly-green" />
                  {cycle.name}
                  <span className="rounded-full bg-crewly-inset px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-crewly-dim">
                    {PHASE_LABEL[phase] || 'In progress'}
                  </span>
                </h2>
                <p className="mt-1 text-[11px] text-crewly-dim">
                  {cycle.startDate
                    ? `${fmtDate(cycle.startDate)} → ${fmtDate(cycle.endDate)}`
                    : 'No dates set for this cycle'}
                  {` · ${METHOD_LABEL[cycle.methodology] || 'Standard annual'}`}
                  {` · ${cycle.excludeProbation ? 'probation excluded' : 'everyone in the company'}`}
                </p>
              </div>
              {isHR ? (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={doEnrollJoiners}
                    className="btn-ghost px-3 py-1.5 text-xs"
                  >
                    <UserPlus className="mr-1 inline h-3.5 w-3.5" />Enroll joiners
                  </button>
                  <button type="button" onClick={openCycleModal} className="btn-ghost px-3 py-1.5 text-xs">
                    <Plus className="mr-1 inline h-3.5 w-3.5" />New cycle
                  </button>
                </div>
              ) : null}
            </div>

            <div className="mt-4 rounded-xl bg-crewly-inset/60 p-3">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">Cycle phases</p>
                <p className="text-[11px] font-semibold text-crewly-dim">
                  <span className="sm:hidden">{PHASE_LABEL[phase]} · </span>
                  Phase {PHASES.indexOf(phase) + 1} of {PHASES.length}
                </p>
              </div>
              <PhaseStepper status={phase} />
            </div>

            {deadlines.length ? (
              <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                {deadlines.map(([label, value]) => (
                  <div key={label} className="rounded-lg border border-crewly-border px-3 py-2">
                    <dt className="text-[10px] uppercase tracking-wide text-crewly-dim">{label}</dt>
                    <dd className="mt-0.5 font-semibold">{fmtDate(value)}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </section>

          {/* ── my appraisal ───────────────────────────────────────────── */}
          {app ? (
            <section className="card">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="card-title flex items-center gap-2 text-sm font-bold">
                  <ClipboardList className="h-4 w-4 text-crewly-dim" />My appraisal
                </h2>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${STATUS_CHIP[app.status] || 'bg-crewly-inset text-crewly-dim'}`}
                  title="Where your appraisal record stands — separate from the cycle phase"
                >
                  Appraisal · {(app.status || 'GOALS').replaceAll('_', ' ').toLowerCase()}
                </span>
                {phase === 'CLOSED' && app.finalRating != null ? (
                  <span className="ml-auto flex items-center gap-2">
                    <span className="text-2xl font-extrabold text-crewly-orange">{app.finalRating}</span>
                    <span className="text-xs text-crewly-dim">/ 5</span>
                    <Stars value={Math.round(app.finalRating)} size="h-4 w-4" />
                  </span>
                ) : goalsDraft.length ? (
                  <span className={`ml-auto text-[11px] ${weightTotal === 100 ? 'text-crewly-dim' : 'text-crewly-orange'}`}>
                    {weightTotal === 100 ? '100% weighted' : `${weightTotal}% of 100% weighted`}
                  </span>
                ) : null}
              </div>

              {/* goals */}
              <div className="mt-4 space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">
                    Goals &amp; KPIs
                    {goalsEditable ? null : <Lock className="h-3 w-3" aria-label="Locked" />}
                  </p>
                  {goalsDraft.length ? (
                    <p className="text-[11px] text-crewly-dim">{goalsSet} of {goalsDraft.length} named</p>
                  ) : null}
                </div>

                {goalsDraft.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-crewly-border px-3 py-4 text-center text-xs text-crewly-dim">
                    {goalsEditable
                      ? 'No goals yet — add the three or four things this cycle is actually judged on.'
                      : 'No goals were recorded for you on this cycle.'}
                  </p>
                ) : null}

                {goalsDraft.map((g, i) => (
                  <div key={g._id || i} className="rounded-xl border border-crewly-border bg-crewly-inset/40 p-3">
                    {goalsEditable ? (
                      <>
                        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:flex sm:flex-wrap sm:items-start">
                          <input
                            className="input col-span-2 min-w-0 sm:col-span-1 sm:flex-1 sm:min-w-[180px]"
                            placeholder="Goal title"
                            value={g.title}
                            onChange={(e) => setGoal(i, { title: e.target.value })}
                            aria-label={`Goal ${i + 1} title`}
                          />
                          <input
                            className="input col-span-2 min-w-0 sm:col-span-1 sm:flex-1 sm:min-w-[160px]"
                            placeholder="KPI / target (e.g. ship 6 features)"
                            value={g.kpi}
                            onChange={(e) => setGoal(i, { kpi: e.target.value })}
                            aria-label={`Goal ${i + 1} KPI`}
                          />
                          <span className="relative block w-24 shrink-0">
                            <input
                              className="input w-full pr-6"
                              type="number"
                              min="0"
                              max="100"
                              placeholder="Weight"
                              value={g.weight}
                              onChange={(e) => setGoal(i, { weight: e.target.value })}
                              aria-label={`Goal ${i + 1} weight, percent`}
                            />
                            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-crewly-dim">
                              %
                            </span>
                          </span>
                          <button
                            type="button"
                            onClick={() => setGoalsDraft((x) => x.filter((_, j) => j !== i))}
                            className="inline-flex items-center justify-center rounded-lg border border-crewly-red/40 px-2 py-1.5 text-crewly-red hover:bg-crewly-red/10"
                            title="Remove goal"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        {phase === 'ACTIVE' || g.progress > 0 ? (
                          <div className="mt-2 flex items-center gap-3">
                            <input
                              type="range"
                              min="0"
                              max="100"
                              value={g.progress || 0}
                              disabled={phase !== 'ACTIVE'}
                              onChange={(e) => setGoal(i, { progress: Number(e.target.value) })}
                              onMouseUp={() => g._id && doProgress(g._id, goalsDraft[i].progress)}
                              onTouchEnd={() => g._id && doProgress(g._id, goalsDraft[i].progress)}
                              style={{
                                backgroundImage: `linear-gradient(to right, var(--color-crewly-green) ${Math.min(100, Math.max(0, Number(g.progress) || 0))}%, transparent ${Math.min(100, Math.max(0, Number(g.progress) || 0))}%)`,
                              }}
                              className="goal-range flex-1"
                              aria-label={`Goal ${i + 1} progress, ${g.progress || 0} percent`}
                            />
                            <span className="w-10 text-right text-xs font-bold text-crewly-green">{g.progress || 0}%</span>
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <div className="flex flex-wrap items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold">{g.title || 'Untitled goal'}</p>
                          <p className="text-[11px] text-crewly-dim">
                            {g.kpi || 'No KPI recorded'}
                            {g.weight ? ` · ${g.weight}% weight` : ''}
                          </p>
                          <ProgressBar value={g.progress} className="mt-2 max-w-sm" />
                        </div>
                        <span className="text-sm font-bold text-crewly-green">{g.progress || 0}%</span>
                      </div>
                    )}
                  </div>
                ))}

                {goalsEditable ? (
                  <div className="flex flex-wrap gap-2">
                    {goalsDraft.length < 12 ? (
                      <button
                        type="button"
                        onClick={() => setGoalsDraft((g) => [...g, { title: '', kpi: '', weight: 0, progress: 0, note: '' }])}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-crewly-border px-3 py-1.5 text-xs font-semibold text-crewly-dim hover:bg-crewly-inset"
                      >
                        <Plus className="h-3.5 w-3.5" />Add goal
                      </button>
                    ) : null}
                    {goalsDraft.length > 0 ? (
                      <button type="button" disabled={busy} onClick={doSaveGoals} className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50">
                        <Save className="mr-1 inline h-3.5 w-3.5" />{busy ? 'Saving…' : 'Save goals'}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>

              {/* self review */}
              {phase === 'SELF_REVIEW' ? (
                <div className="mt-4 rounded-xl border border-crewly-orange/30 bg-crewly-orange/[0.06] p-3">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-crewly-orange">
                    <FileText className="h-3.5 w-3.5" />
                    Self review — {app.selfReview?.submittedAt ? 'submitted' : 'open now'}
                  </p>
                  {!app.selfReview?.submittedAt ? (
                    <>
                      <textarea
                        className="input mt-2 min-h-[90px]"
                        placeholder="What did you achieve this cycle? Highlights, numbers, blockers…"
                        value={selfForm.summary}
                        onChange={(e) => setSelfForm({ ...selfForm, summary: e.target.value })}
                        aria-label="Self review summary"
                      />
                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        <span className="text-xs text-crewly-dim">Rate your cycle:</span>
                        <Stars value={selfForm.rating} onChange={(r) => setSelfForm({ ...selfForm, rating: r })} />
                        <button
                          type="button"
                          disabled={busy}
                          onClick={doSelfReview}
                          className="btn-primary ml-auto px-4 py-2 text-xs disabled:opacity-50"
                        >
                          {busy ? 'Submitting…' : 'Submit self review'}
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                      “{app.selfReview.summary}”
                      <Stars value={app.selfReview.rating} size="h-3.5 w-3.5" />
                    </p>
                  )}
                </div>
              ) : null}

              {phase === 'REVIEW' && app.selfReview?.submittedAt ? (
                <p className="mt-3 flex items-center gap-1.5 text-xs text-crewly-dim">
                  <Check className="h-3.5 w-3.5 text-crewly-green" />
                  Your self-review is in — TL and manager reviews are running.
                </p>
              ) : null}

              {/* revealed after close */}
              {phase === 'CLOSED' ? (
                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {[
                    { label: 'Self', Icon: User, r: app.selfReview },
                    { label: 'Team lead', Icon: Users, r: app.tlReview },
                    { label: 'Manager', Icon: Briefcase, r: app.mgrReview },
                  ].map(({ label, Icon, r }) => (
                    <div key={label} className="rounded-xl border border-crewly-border bg-crewly-inset/40 p-3">
                      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-crewly-dim">
                        <Icon className="h-3.5 w-3.5" />{label}
                      </p>
                      {r?.at || r?.submittedAt ? (
                        <>
                          <Stars value={r.rating || 0} size="h-4 w-4" className="mt-1" />
                          <p className="mt-1 text-xs text-crewly-dim">{r.feedback || r.summary || '—'}</p>
                        </>
                      ) : (
                        <p className="mt-1 text-xs text-crewly-dim">Not submitted</p>
                      )}
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          {/* ── team board ─────────────────────────────────────────────── */}
          {isSenior ? (
            <section className="card">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="card-title flex items-center gap-2 text-sm font-bold">
                  <Users className="h-4 w-4 text-crewly-dim" />Team board
                  <span className="rounded-full bg-crewly-inset px-2 py-0.5 text-[11px] font-semibold text-crewly-dim">{team.length}</span>
                </h2>
                <p className="text-[11px] text-crewly-dim">
                  {team.length
                    ? `${selfReviewsIn} self review${selfReviewsIn === 1 ? '' : 's'} in · ${awaitingMe} waiting on you`
                    : 'People you review in this cycle'}
                </p>
              </div>

              {team.length === 0 ? (
                <p className="mt-3 rounded-lg border border-dashed border-crewly-border px-3 py-6 text-center text-xs text-crewly-dim">
                  Nobody in your review scope for this cycle.
                </p>
              ) : (
                <ul className="mt-3 divide-y divide-crewly-border">
                  {team.map((appraisal) => {
                    const mySlot = slotFor(appraisal);
                    const canReview =
                      phase === 'REVIEW' &&
                      !mySlot?.at &&
                      String(appraisal.user?._id) !== String(me?._id);
                    return (
                      <li key={appraisal._id} className="flex flex-wrap items-center gap-3 py-2.5">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-crewly-inset text-xs font-bold text-crewly-dim">
                          {initials(appraisal.user?.name)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold">{appraisal.user?.name || 'Employee'}</p>
                          <p className="truncate text-[11px] text-crewly-dim">
                            {appraisal.user?.designation || appraisal.user?.role}
                            {` · ${appraisal.goals?.length || 0} goal${(appraisal.goals?.length || 0) === 1 ? '' : 's'}`}
                          </p>
                        </div>
                        <div className="flex w-full flex-wrap items-center justify-end gap-x-3 gap-y-1.5 sm:w-auto sm:justify-start sm:gap-3">
                          <Gates appraisal={appraisal} />
                          <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${STATUS_CHIP[appraisal.status] || 'bg-crewly-inset text-crewly-dim'}`}>
                            {(appraisal.status || 'GOALS').replaceAll('_', ' ')}
                          </span>
                          {phase === 'CLOSED' && appraisal.finalRating != null ? (
                            <span className="flex items-center gap-1 text-sm font-extrabold text-crewly-orange">
                              {appraisal.finalRating}
                              <Star className="h-3.5 w-3.5" fill="currentColor" strokeWidth={0} />
                            </span>
                          ) : null}
                          {canReview ? (
                            <button
                              type="button"
                              onClick={() => { setReviewTarget(appraisal); setReviewForm({ rating: 0, feedback: '' }); }}
                              className="btn-primary px-3 py-1.5 text-xs"
                            >
                              <Scale className="mr-1 inline h-3.5 w-3.5" />Review
                            </button>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ) : null}

          {/* ── history ────────────────────────────────────────────────── */}
          <section className="card">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="card-title flex items-center gap-2 text-sm font-bold">
                <History className="h-4 w-4 text-crewly-dim" />Performance history
              </h2>
              <p className="text-[11px] text-crewly-dim">
                {historyRows.length
                  ? `${historyRows.length} closed round${historyRows.length === 1 ? '' : 's'}`
                  : 'Builds after the first closed cycle'}
              </p>
            </div>
            {historyRows.length === 0 ? (
              <p className="mt-3 rounded-lg border border-dashed border-crewly-border px-3 py-6 text-center text-xs text-crewly-dim">
                Nothing yet — a round lands here with its published rating once it closes.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-crewly-border">
                {historyRows.map((row) => (
                  <li key={row._id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate font-semibold">{row.cycle?.name || 'Cycle'}</span>
                    <span className="text-[11px] text-crewly-dim">{fmtDate(row.cycle?.closedAt)}</span>
                    {row.finalRating != null ? (
                      <span className="flex items-center gap-1 font-extrabold text-crewly-orange">
                        {row.finalRating}
                        <Star className="h-3.5 w-3.5" fill="currentColor" strokeWidth={0} />
                      </span>
                    ) : (
                      <span className="rounded-full bg-crewly-inset px-2.5 py-0.5 text-[11px] font-semibold text-crewly-dim">No rating</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {/* new cycle modal */}
      {showNewCycle && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 p-0 backdrop-blur-sm sm:items-center sm:p-4"
          onClick={() => setShowNewCycle(false)}
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Start a performance cycle"
            className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-crewly-border bg-crewly-card shadow-2xl sm:max-h-[88vh] sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* header */}
            <div className="flex shrink-0 items-start gap-3 border-b border-crewly-border bg-crewly-inset/50 p-5">
              <div className="flex min-w-0 items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-crewly-accent/15 text-crewly-orange">
                  <Target className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-bold sm:text-lg">Start performance cycle</h3>
                    {cycleForm.name.trim() ? (
                      <span className="rounded-full bg-crewly-green/15 px-2 py-0.5 text-[11px] font-semibold text-crewly-green">
                        {cycleForm.name.trim()}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-crewly-dim">
                    Opens one appraisal window: goals, self reviews, manager ratings — and enrols the
                    people you choose below.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowNewCycle(false)}
                className="ml-auto shrink-0 rounded-lg p-1 text-crewly-dim hover:text-crewly-text"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
              {/* name */}
              <div>
                <label className="label" htmlFor="cycle-name">Cycle name</label>
                <div className="relative">
                  <input
                    id="cycle-name"
                    className="input pr-10"
                    placeholder="H2 2026 Annual Performance Review"
                    value={cycleForm.name}
                    onChange={(e) => setCycleForm({ ...cycleForm, name: e.target.value })}
                  />
                  <Pencil className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-crewly-dim" aria-hidden="true" />
                </div>
              </div>

              {/* methodology */}
              <fieldset>
                <legend className="label">Review methodology</legend>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {METHODOLOGIES.map((option) => (
                    <MethodCard
                      key={option.id}
                      option={option}
                      checked={cycleForm.methodology === option.id}
                      onSelect={(id) => setCycleForm({ ...cycleForm, methodology: id })}
                    />
                  ))}
                </div>
              </fieldset>

              {/* dates */}
              <div>
                <p className="label">Review milestones &amp; deadlines</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-[11px] text-crewly-dim" htmlFor="cycle-start">Start date</label>
                    <input id="cycle-start" type="date" className="input" value={cycleForm.startDate}
                      onChange={(e) => setCycleForm({ ...cycleForm, startDate: e.target.value })} />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] text-crewly-dim" htmlFor="cycle-end">Cycle ends</label>
                    <input id="cycle-end" type="date" className="input" value={cycleForm.endDate}
                      onChange={(e) => setCycleForm({ ...cycleForm, endDate: e.target.value })} />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] text-crewly-dim" htmlFor="cycle-self">Self-review deadline</label>
                    <input id="cycle-self" type="date" className="input" value={cycleForm.selfReviewDueAt}
                      onChange={(e) => setCycleForm({ ...cycleForm, selfReviewDueAt: e.target.value })} />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] text-crewly-dim" htmlFor="cycle-mgr">Manager rating deadline</label>
                    <input id="cycle-mgr" type="date" className="input" value={cycleForm.managerReviewDueAt}
                      onChange={(e) => setCycleForm({ ...cycleForm, managerReviewDueAt: e.target.value })} />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="mb-1 block text-[11px] text-crewly-dim" htmlFor="cycle-cal">Calibration &amp; close</label>
                    <input id="cycle-cal" type="date" className="input" value={cycleForm.calibrationDueAt}
                      onChange={(e) => setCycleForm({ ...cycleForm, calibrationDueAt: e.target.value })} />
                  </div>
                </div>
                {cycleForm.startDate && cycleForm.selfReviewDueAt && cycleForm.selfReviewDueAt < cycleForm.startDate ? (
                  <p className="mt-2 text-[11px] text-crewly-orange">
                    The self-review deadline falls before the cycle starts — double-check the dates.
                  </p>
                ) : null}
                <p className="mt-2 text-[11px] text-crewly-dim">
                  Deadlines are stored with the cycle so they can be read back later. Moving the phase is still
                  a deliberate step on the performance page; nothing advances on its own.
                </p>
              </div>

              {/* cohort */}
              <div>
                <p className="label">Participant cohort</p>
                {/*
                  The mock shows a department dropdown here. This API enrolls
                  every active employee, full stop — so the field is a read-out
                  of who that is rather than a picker that would silently do
                  nothing. It still looks like the field it is standing in for.
                */}
                <div className="rounded-lg border border-crewly-border bg-crewly-bg px-3 py-2">
                  <p className="truncate text-sm">
                    All active employees
                    {cohort?.byDepartment?.length ? (
                      <span className="text-crewly-dim">
                        {' '}({cohort.byDepartment.slice(0, 3).map((d) => d.name).join(', ')}
                        {cohort.byDepartment.length > 3 ? ', …' : ''})
                      </span>
                    ) : null}
                  </p>
                </div>
                {cohort?.byDepartment?.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {cohort.byDepartment.slice(0, 6).map((dept) => (
                      <span key={dept.name} className="rounded-full bg-crewly-inset px-2 py-0.5 text-[11px] text-crewly-dim">
                        {dept.name} <span className="font-semibold text-crewly-text">{dept.count}</span>
                      </span>
                    ))}
                  </div>
                ) : null}

                <div className="mt-1 divide-y divide-crewly-border">
                  <Switch
                    id="cycle-exclude-probation"
                    checked={cycleForm.excludeProbation}
                    onChange={(next) => setCycleForm({ ...cycleForm, excludeProbation: next })}
                    label="Exclude employees currently on probation"
                    description={
                      cohort
                        ? `${cohort.onProbation} of ${cohort.total} are inside their first ${cohort.probationWindowDays} days.`
                        : 'Anyone inside their first 90 days is skipped.'
                    }
                  />
                </div>
              </div>

              {/* automations — exactly one thing happens, and it says so */}
              <div className="rounded-xl border border-crewly-border bg-crewly-inset/40 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-crewly-dim">
                  Automations
                </p>
                <div className="mt-1 flex items-start gap-2.5">
                  <input
                    id="cycle-notify"
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-crewly-green)]"
                    checked={cycleForm.notifyParticipants}
                    onChange={(e) => setCycleForm({ ...cycleForm, notifyParticipants: e.target.checked })}
                  />
                  <label htmlFor="cycle-notify" className="cursor-pointer text-xs leading-relaxed">
                    Send a launch notification to everyone enrolled
                    <span className="mt-0.5 block text-[11px] text-crewly-dim">
                      One message each, telling them to set their goals. Nothing else is sent, and a draft
                      notifies nobody.
                    </span>
                  </label>
                </div>
                <p className="mt-2 border-t border-crewly-border pt-2 text-[11px] text-crewly-dim">
                  Colleagues are enrolled when you press start — {cohortBusy ? 'counting…' : cohortIncluded === null ? '—' : cohortIncluded}
                  {' '}of the {cohort?.total ?? '—'} active employees.
                </p>
              </div>
            </div>

            {/* footer */}
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-crewly-border bg-crewly-inset/40 p-4">
              <button type="button" onClick={() => setShowNewCycle(false)} className="btn-ghost px-3 py-2 text-sm">
                Cancel
              </button>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => doCreateCycle({ draft: true })}
                  disabled={busy || !cycleForm.name.trim()}
                  className="btn-ghost px-3 py-2 text-sm disabled:opacity-50"
                  title="Keep the settings without enrolling or notifying anyone"
                >
                  Save as draft
                </button>
                <button
                  type="button"
                  onClick={() => doCreateCycle({ draft: false })}
                  disabled={busy || !cycleForm.name.trim()}
                  className="btn-primary inline-flex items-center gap-2 px-4 py-2 text-sm disabled:opacity-50"
                >
                  <Target className="h-4 w-4" />
                  {busy
                    ? 'Starting…'
                    : cycleForm.notifyParticipants
                      ? `Start & notify${cohortIncluded === null ? '' : ` ${cohortIncluded}`}`
                      : 'Start quietly'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* review modal */}
      {reviewTarget && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 p-0 backdrop-blur-sm sm:items-center sm:p-4"
          onClick={() => setReviewTarget(null)}
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Review ${reviewTarget.user?.name || 'this employee'}`}
            className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-crewly-border bg-crewly-card shadow-2xl sm:max-h-[88vh] sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-start gap-3 border-b border-crewly-border bg-crewly-inset/50 p-5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-crewly-accent/15 text-crewly-orange">
                <Scale className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <h3 className="text-base font-bold sm:text-lg">
                  {reviewTarget.user?.name || 'Employee'}
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-crewly-dim">
                  {me?.role === 'TEAM_LEAD' ? 'Team Lead review' : 'Manager review'} ·
                  {' '}the rating and this note are shown to the employee once the cycle closes.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setReviewTarget(null)}
                className="ml-auto shrink-0 rounded-lg p-1 text-crewly-dim hover:text-crewly-text"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">
                  What they set out to do
                </p>
                <ul className="mt-2 space-y-2">
                  {(reviewTarget.goals || []).map((g, i) => (
                    <li key={i} className="rounded-lg border border-crewly-border bg-crewly-inset/40 px-3 py-2">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="min-w-0 text-sm font-semibold">{g.title || 'Untitled goal'}</p>
                        <span className="shrink-0 text-xs font-bold text-crewly-green">{g.progress || 0}%</span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-crewly-dim">
                        {g.kpi || 'No KPI recorded'}
                        {g.weight ? ` · ${g.weight}% weight` : ''}
                      </p>
                      <ProgressBar value={g.progress} className="mt-1.5" />
                    </li>
                  ))}
                  {(!reviewTarget.goals || !reviewTarget.goals.length) && (
                    <li className="rounded-lg border border-dashed border-crewly-border px-3 py-3 text-center text-xs text-crewly-dim">
                      No goals were recorded on this cycle.
                    </li>
                  )}
                </ul>
              </div>

              {reviewTarget.selfReview?.submittedAt || reviewTarget.selfReview?.summary ? (
                <div className="rounded-lg border border-crewly-border bg-crewly-inset/40 px-3 py-2">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">
                    <FileText className="h-3 w-3" />Their self review
                  </p>
                  {reviewTarget.selfReview.summary ? (
                    <p className="mt-1 text-xs leading-relaxed">“{reviewTarget.selfReview.summary}”</p>
                  ) : (
                    <p className="mt-1 text-xs text-crewly-dim">
                      Submitted without a written summary.
                    </p>
                  )}
                  {reviewTarget.selfReview.rating ? (
                    <Stars value={reviewTarget.selfReview.rating} size="h-3 w-3" className="mt-1" />
                  ) : null}
                </div>
              ) : (
                <p className="rounded-lg border border-dashed border-crewly-border px-3 py-2 text-xs text-crewly-dim">
                  No self review was submitted.
                </p>
              )}

              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">Your rating</p>
                <div className="mt-1 flex items-center gap-3">
                  <Stars value={reviewForm.rating} onChange={(r) => setReviewForm({ ...reviewForm, rating: r })} />
                  <span className="text-xs text-crewly-dim">
                    {reviewForm.rating ? `${reviewForm.rating} of 5` : 'Pick 1 to 5'}
                  </span>
                </div>
              </div>

              <div>
                <label className="label" htmlFor="review-feedback">Feedback</label>
                <textarea
                  id="review-feedback"
                  className={`${inp} min-h-[96px]`}
                  placeholder="What went well, what to change next round…"
                  value={reviewForm.feedback}
                  onChange={(e) => setReviewForm({ ...reviewForm, feedback: e.target.value })}
                />
                <p className="mt-1 text-[11px] text-crewly-dim">
                  Shown to the employee when the cycle closes — not before.
                </p>
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-crewly-border bg-crewly-inset/40 p-4">
              <button type="button" onClick={() => setReviewTarget(null)} className="btn-ghost px-3 py-2 text-sm">
                Cancel
              </button>
              <button
                type="button"
                onClick={doReview}
                disabled={busy || !reviewForm.rating}
                className="btn-primary inline-flex items-center gap-2 px-4 py-2 text-sm disabled:opacity-50"
              >
                <Check className="h-4 w-4" />
                {busy ? 'Saving…' : 'Submit review'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}