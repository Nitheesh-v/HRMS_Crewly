// ============================================================
// Performance Management
// Employee: goals → progress → self review → final rating + history
// Seniors: team review board · HR: cycle controls
// ============================================================
import React, { useEffect, useMemo, useState } from 'react';
import { Briefcase, Check, CheckCircle2, Circle, ClipboardList, FileText, History, Hourglass, Lock, Pencil, Plus, Save, Scale, SkipForward, Star, Target, Trash2, User, UserPlus, Users, X } from 'lucide-react';
import { useSelector } from 'react-redux';
import {
  getCycles, getCycleCohort, getMyAppraisal, getTeamBoard, createCycle, transitionCycle,
  saveGoals, updateProgress, submitSelfReview, submitReview, getHistory, enrollMissing, startCycle,
} from '../../services/perfService.js';
import { notify } from '../../utils/notify.js';
import EmptyState from '../../components/common/EmptyState.jsx';

const inp = 'input';
const btn = 'rounded-lg px-3 py-1.5 text-xs font-bold transition disabled:opacity-50';
const primary = `${btn} bg-crewly-accent text-crewly-accent-ink hover:opacity-90`;
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

const PHASES = ['GOAL_SETTING', 'ACTIVE', 'SELF_REVIEW', 'REVIEW', 'CLOSED'];
const PHASE_LABEL = { GOAL_SETTING: 'Set goals', ACTIVE: 'Work period', SELF_REVIEW: 'Self review', REVIEW: 'TL + Manager review', CLOSED: 'Final rating published' };
const STATUS_CHIP = {
  GOALS: 'bg-slate-500/20 text-slate-300', IN_PROGRESS: 'bg-sky-400/15 text-sky-300',
  SELF_SUBMITTED: 'bg-amber-400/15 text-amber-300', TL_DONE: 'bg-crewly-green/15 text-crewly-green',
  MGR_DONE: 'bg-purple-400/15 text-purple-300', CLOSED: 'bg-emerald-400/15 text-emerald-300',
};
const chip = (txt, cls) => <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${cls}`}>{txt}</span>;

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

const PhaseStepper = ({ status }) => {
  const idx = PHASES.indexOf(status);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {PHASES.map((p, i) => (
        <React.Fragment key={p}>
          {i > 0 && <span className={`h-px w-5 ${i <= idx ? 'bg-crewly-green' : 'bg-crewly-border'}`} />}
          {chip(
            PHASE_LABEL[p],
            i === idx
              ? 'bg-crewly-selected text-crewly-selected-text ring-1 ring-crewly-green/40'
              : i < idx
                ? 'bg-crewly-green/10 text-crewly-green'
                : 'bg-slate-700/40 text-slate-500',
          )}
        </React.Fragment>
      ))}
    </div>
  );
};

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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-slate-100"><Target className="mr-2 inline h-6 w-6 text-crewly-green" />Performance</h1>
        {cycle && (
          <span className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
            {cycle.name}
            {cycle.startDate ? <span>· {fmtDate(cycle.startDate)} → {fmtDate(cycle.endDate)}</span> : null}
            {cycle.methodology ? (
              <span className="rounded-full bg-crewly-inset px-2 py-0.5 text-[11px] font-semibold text-crewly-dim">
                {METHOD_LABEL[cycle.methodology] || cycle.methodology}
              </span>
            ) : null}
          </span>
        )}
      </div>

      {/* Drafts. A saved draft is real work that has not been opened yet —
          it sits here, with the one action that can open it. */}
      {drafts.length ? (
        <section className="rounded-xl border border-dashed border-crewly-border bg-crewly-inset/40 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="flex items-center gap-2 text-sm font-bold">
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
        <div className="rounded-xl border border-crewly-border bg-crewly-card">
          <EmptyState
            illustration="chart"
            title="No performance cycle yet"
            description={
              isHR
                ? 'A cycle carries goals, self reviews and ratings for everyone in one window. Start one to open it.'
                : 'HR will open a review cycle soon. Your goals and self review will appear here when they do.'
            }
            action={isHR ? (
              <button onClick={openCycleModal} className={primary}>＋ Start a cycle</button>
            ) : null}
          />
        </div>
      ) : (
        <>
          {/* cycle banner + HR controls */}
          <section className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1"><PhaseStepper status={phase} /></div>
              {isHR && phase !== 'CLOSED' && (
                <button disabled={busy} onClick={doAdvance} className={primary}>
                  <SkipForward className="mr-1 inline h-4 w-4" />Move to: {PHASE_LABEL[PHASES[PHASES.indexOf(phase) + 1]]}
                </button>
              )}
              {isHR && <button onClick={openCycleModal} className={`${btn} border border-slate-600 text-slate-300 hover:bg-slate-700`}><Plus className="mr-1 inline h-3.5 w-3.5" />New cycle</button>}
              {isHR && <button onClick={async () => { await enrollMissing(cycle._id); flash(true, 'New joiners enrolled'); }} className={`${btn} border border-slate-600 text-slate-300 hover:bg-slate-700`}><UserPlus className="mr-1 inline h-3.5 w-3.5" />Enroll joiners</button>}
            </div>
          </section>

          {/* MY appraisal */}
          {app && (
            <section className="rounded-xl border border-slate-700 bg-slate-800/60 p-4 space-y-4">
              <div className="flex items-center gap-3">
                <h2 className="text-sm font-bold uppercase tracking-wide text-slate-300"><ClipboardList className="mr-1.5 inline h-4 w-4" />My appraisal</h2>
                {chip(app.status.replaceAll('_', ' '), STATUS_CHIP[app.status])}
                {phase === 'CLOSED' && app.finalRating != null && (
                  <span className="ml-auto text-right">
                    <span className="text-2xl font-extrabold text-amber-400">{app.finalRating}</span>
                    <span className="text-sm text-slate-400"> /5</span>
                    <Stars value={Math.round(app.finalRating)} size="h-4 w-4" className="ml-2" />
                  </span>
                )}
              </div>

              {/* goals */}
              <div className="space-y-2">
                <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Goals & KPIs {goalsEditable ? null : <Lock className="ml-1 inline h-3.5 w-3.5" />}</p>
                {goalsDraft.map((g, i) => (
                  <div key={g._id || i} className="rounded-lg border border-slate-700 bg-slate-900/40 p-3 space-y-2">
                    <div className="flex flex-wrap gap-2">
                      <input className={`${inp} flex-1 min-w-[180px]`} placeholder="Goal title" value={g.title}
                        disabled={!goalsEditable} onChange={(e) => setGoal(i, { title: e.target.value })} />
                      <input className={`${inp} flex-1 min-w-[160px]`} placeholder="KPI / target (e.g. ship 6 features)" value={g.kpi}
                        disabled={!goalsEditable} onChange={(e) => setGoal(i, { kpi: e.target.value })} />
                      <input className={`${inp} w-24`} type="number" min="0" max="100" placeholder="Weight %" value={g.weight}
                        disabled={!goalsEditable} onChange={(e) => setGoal(i, { weight: e.target.value })} />
                      {goalsEditable && (
                        <button onClick={() => setGoalsDraft((x) => x.filter((_, j) => j !== i))} className={`${btn} border border-red-500/40 text-red-300 hover:bg-red-500/10`} title="Remove"><Trash2 className="h-3.5 w-3.5" /></button>
                      )}
                    </div>
                    {(phase === 'ACTIVE' || g.progress > 0) && (
                      <div className="flex items-center gap-3">
                        <input type="range" min="0" max="100" value={g.progress || 0} disabled={phase !== 'ACTIVE'}
                          onChange={(e) => setGoal(i, { progress: Number(e.target.value) })}
                          onMouseUp={() => g._id && doProgress(g._id, goalsDraft[i].progress)}
                          onTouchEnd={() => g._id && doProgress(g._id, goalsDraft[i].progress)}
                          className="flex-1 accent-[var(--color-crewly-green)]" />
                        <span className="w-10 text-right text-xs font-bold text-crewly-green">{g.progress || 0}%</span>
                      </div>
                    )}
                  </div>
                ))}
                {goalsEditable && goalsDraft.length < 12 && (
                  <button onClick={() => setGoalsDraft((g) => [...g, { title: '', kpi: '', weight: 0, progress: 0, note: '' }])}
                    className={`${btn} border border-dashed border-slate-500 text-slate-300 hover:bg-slate-700/40`}>＋ Add goal</button>
                )}
                {goalsEditable && goalsDraft.length > 0 && (
                  <button disabled={busy} onClick={doSaveGoals} className={primary}><Save className="mr-1 inline h-3.5 w-3.5" />Save goals</button>
                )}
              </div>

              {/* self review */}
              {phase === 'SELF_REVIEW' && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
                  <p className="text-xs font-bold uppercase tracking-wide text-amber-300"><FileText className="mr-1 inline h-3.5 w-3.5" />Self review {app.selfReview?.submittedAt ? '— submitted' : '— open now'}</p>
                  {!app.selfReview?.submittedAt ? (
                    <>
                      <textarea className={`${inp} min-h-[90px]`} placeholder="What did you achieve this cycle? Highlights, numbers, blockers…"
                        value={selfForm.summary} onChange={(e) => setSelfForm({ ...selfForm, summary: e.target.value })} />
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-slate-400">Rate your cycle:</span>
                        <Stars value={selfForm.rating} onChange={(r) => setSelfForm({ ...selfForm, rating: r })} />
                        <button disabled={busy} onClick={doSelfReview} className="ml-auto rounded-lg bg-crewly-accent px-4 py-2 text-xs font-bold text-crewly-accent-ink hover:opacity-90 disabled:opacity-50">Submit self review</button>
                      </div>
                    </>
                  ) : (
                    <p className="text-sm text-slate-300">"{app.selfReview.summary}" <Stars value={app.selfReview.rating} size="h-3.5 w-3.5" className="ml-2" /></p>
                  )}
                </div>
              )}
              {phase === 'REVIEW' && app.selfReview?.submittedAt && (
                <p className="text-xs text-slate-400"><Check className="mr-1 inline h-3 w-3 text-emerald-400" />Your self-review is in — TL/Manager reviews are running{app.tlReview?.submitted ? ' · TL review done' : ''}{app.mgrReview?.submitted ? ' · Manager review done' : ''}</p>
              )}

              {/* revealed after close */}
              {phase === 'CLOSED' && (
                <div className="grid gap-3 sm:grid-cols-3">
                  {[{ label: 'Self', Icon: User, r: app.selfReview }, { label: 'Team Lead', Icon: Users, r: app.tlReview }, { label: 'Manager', Icon: Briefcase, r: app.mgrReview }].map(({ label, Icon, r }) => (
                    <div key={label} className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
                      <p className="flex items-center gap-1 text-xs font-bold text-slate-300"><Icon className="h-3.5 w-3.5" />{label}</p>
                      {r?.at || r?.submittedAt ? (
                        <>
                          <Stars value={r.rating || 0} size="h-4 w-4" />
                          <p className="mt-1 text-xs text-slate-400">{r.feedback || r.summary || '—'}</p>
                        </>
                      ) : <p className="mt-1 text-xs text-slate-500">not submitted</p>}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* TEAM BOARD (seniors) */}
          {isSenior && (
            <section className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-300"><Users className="mr-1.5 inline h-4 w-4" />Team board ({team.length})</h2>
              {team.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-600 p-4 text-center text-xs text-slate-500">Nobody in your review scope for this cycle.</p>
              ) : (
                <div className="space-y-2">
                  {team.map((a) => {
                    const mySlot = me?.role === 'TEAM_LEAD' ? a.tlReview : a.mgrReview;
                    const canReview = phase === 'REVIEW' && !mySlot?.at && String(a.user?._id) !== String(me?._id);
                    return (
                      <div key={a._id} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-slate-100">{a.user?.name}</p>
                          <p className="text-xs text-slate-400">{a.user?.designation || a.user?.role} · {a.goals?.length || 0} goal(s)</p>
                        </div>
                        {chip(a.status.replaceAll('_', ' '), STATUS_CHIP[a.status])}
                        <span className="text-[11px] text-slate-500">
                          self {a.selfReview?.submittedAt ? <Check className="inline h-3 w-3 text-emerald-400" /> : <Hourglass className="inline h-3 w-3 text-amber-400" />} · TL {a.tlReview?.at ? <Check className="inline h-3 w-3 text-emerald-400" /> : <Hourglass className="inline h-3 w-3 text-amber-400" />} · Mgr {a.mgrReview?.at ? <Check className="inline h-3 w-3 text-emerald-400" /> : <Hourglass className="inline h-3 w-3 text-amber-400" />}
                        </span>
                        {phase === 'CLOSED' && a.finalRating != null && <span className="text-sm font-extrabold text-amber-400">{a.finalRating}<Star className="ml-0.5 inline h-3.5 w-3.5" fill="currentColor" strokeWidth={0} /></span>}
                        {canReview && (
                          <button onClick={() => { setReviewTarget(a); setReviewForm({ rating: 0, feedback: '' }); }} className={primary}>
                            <Scale className="mr-1 inline h-3.5 w-3.5" />Review
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* HISTORY */}
          <section className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
            <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-300"><History className="mr-1.5 inline h-4 w-4" />Performance history</h2>
            {historyRows.length === 0 ? (
              <p className="text-xs text-slate-500">Nothing yet — history builds after the first closed cycle.</p>
            ) : (
              <div className="space-y-2">
                {historyRows.map((h) => (
                  <div key={h._id} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-sm">
                    <span className="flex-1 font-semibold text-slate-200">{h.cycle?.name || 'Cycle'}</span>
                    <span className="text-xs text-slate-500">{fmtDate(h.cycle?.closedAt)}</span>
                    {h.finalRating != null ? (
                      <span className="font-extrabold text-amber-400">{h.finalRating}<Star className="ml-0.5 inline h-3.5 w-3.5" fill="currentColor" strokeWidth={0} /></span>
                    ) : chip('no rating', 'bg-slate-600/30 text-slate-400')}
                  </div>
                ))}
              </div>
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
            className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-crewly-border bg-crewly-card shadow-2xl sm:max-h-[88vh] sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* header */}
            <div className="flex items-start gap-3 border-b border-crewly-border bg-crewly-inset/50 p-5">
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

            <div className="space-y-5 p-5">
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
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-crewly-border bg-crewly-inset/40 p-4">
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setReviewTarget(null)}>
          <div className="w-full max-w-md space-y-3 rounded-xl border border-slate-600 bg-slate-800 p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold text-slate-100">
              <Scale className="mr-1 inline h-4 w-4" />Review — {reviewTarget.user?.name} <span className="text-xs font-normal text-slate-400">({me?.role === 'TEAM_LEAD' ? 'Team Lead review' : 'Manager review'})</span>
            </h3>
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/40 p-2">
              {(reviewTarget.goals || []).map((g, i) => (
                <p key={i} className="text-xs text-slate-300">• {g.title} <span className="text-slate-500">{g.kpi ? `— ${g.kpi} · ` : ''}{g.progress || 0}%</span></p>
              ))}
              {(!reviewTarget.goals || !reviewTarget.goals.length) && <p className="text-xs text-slate-500">No goals recorded.</p>}
              {reviewTarget.selfReview?.summary && (
                <p className="border-t border-slate-700 pt-1 text-xs text-slate-400"><FileText className="mr-1 inline h-3 w-3" />Self: "{reviewTarget.selfReview.summary}" <Stars value={reviewTarget.selfReview.rating || 0} size="h-3 w-3" /></p>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-slate-400">Your rating:</span>
              <Stars value={reviewForm.rating} onChange={(r) => setReviewForm({ ...reviewForm, rating: r })} />
            </div>
            <textarea className={`${inp} min-h-[80px]`} placeholder="Feedback for the employee (visible after the cycle closes)…" value={reviewForm.feedback} onChange={(e) => setReviewForm({ ...reviewForm, feedback: e.target.value })} />
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setReviewTarget(null)} className={`${btn} border border-slate-600 text-slate-300 hover:bg-slate-700`}>Cancel</button>
              <button onClick={doReview} disabled={busy} className={primary}>{busy ? 'Saving…' : 'Submit review'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}