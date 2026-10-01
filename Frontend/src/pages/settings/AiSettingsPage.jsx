/* eslint-disable react-hooks/set-state-in-effect */
// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.7 — ADMIN AI SETTINGS
//
// One page where a COMPANY_ADMIN controls the assistant for their own
// company: the kill switch, the monthly token ceiling, which HR context
// categories the assistant may read, and — the reason this page exists — which
// languages employees may pick.
//
// THE LANGUAGE MANAGER IS THE POINT.
//
//   36.5 offered the same five languages to every tenant, hardcoded in two
//   places. An admin who wanted Kannada had to change code and redeploy.
//   36.7 makes the list a setting: enable a language here and it OPENS UP in
//   the assistant's selector for every employee of this company, and for
//   nobody else's.
//
//   The list comes from a PLATFORM CATALOGUE — a fixed set of languages with
//   correct native names and BCP-47 tags — and is NOT free text. A
//   free-text entry would let a typo become a language the model cannot
//   actually produce, which is a selector that lies to the person using it.
//
// ENGLISH CANNOT BE SWITCHED OFF.
//
//   It is the one language the system prompt needs no rule for, and the
//   platform's fallback when a request carries no preference at all. A tenant
//   without it would have a selector promising languages the prompt cannot
//   produce for a default request. That rule is enforced on the MODEL, not
//   only here, so no code path can persist it — this page merely refuses to
//   let the admin try.
//
// WHAT THIS PAGE IS NOT.
//
//   · It is not a place to read conversations. There are none stored.
//   · It does not show another company's configuration. The company comes
//     from the caller's own token server-side; this page sends no identifiers.
//   · It does not decide what the assistant may KNOW. Categories decide what
//     the retriever is allowed to read; a language only decides how the
//     answer is phrased. Changing a language never widens anyone's access.
//
// Shape follows AiUsagePage.jsx and SecuritySettingsPage.jsx: plain useState,
// one service module, no Redux.
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  AlertTriangle,
  Check,
  Database,
  Languages,
  Plus,
  RotateCcw,
  Save,
  X,
} from 'lucide-react';

import { getAiConfig, updateAiConfig } from '../../services/aiService.js';

/*
 * THE CONTEXT CATEGORIES, IN PLAIN LANGUAGE.
 *
 * The backend sends raw codes (profile, leave-requests, attendance-month...).
 * Rendering those to an admin would be a settings page that only a developer
 * can read, so each code gets the label and the one-line description of what
 * the retriever actually puts in the context for it.
 *
 * EVERY WORD HERE IS CHECKABLE. `payslips` says "month and status only"
 * because renderPayslips emits exactly `- <month label>: <status>` and the
 * Mongo query never selects snapshot.salary.*. `documents` says "never the
 * files" because the query does not select fileUrl. An admin trusting this
 * page is trusting a description that matches the code.
 *
 * A code missing from this table still renders, under its own raw code, so a
 * new backend category can never make the page crash or silently disappear.
 */
const CATEGORY_LABELS = Object.freeze({
  profile: {
    label: 'Employee profile',
    hint: 'Name, designation, department and joining date',
  },
  payslips: {
    label: 'Payslips',
    hint: 'Month and status only — never a salary figure',
  },
  expenses: {
    label: 'Expense claims',
    hint: 'Their own claims and what stage each one is at',
  },
  tasks: {
    label: 'Tasks',
    hint: 'Tasks assigned to them',
  },
  projects: {
    label: 'Projects',
    hint: 'Projects they manage, lead or are a member of',
  },
  documents: {
    label: 'Documents',
    hint: 'Their own document titles — never the files themselves',
  },
  'leave-requests': {
    label: 'Leave requests',
    hint: 'Their leave applications and the outcome of each',
  },
  leaves: {
    label: 'Leave balances',
    hint: 'Remaining and total days for each leave type',
  },
  attendance: {
    label: "Today's attendance",
    hint: "Today's record, their shift and this week's hours",
  },
  'attendance-month': {
    label: 'Attendance this month',
    hint: 'Present, absent and leave days for the month',
  },
  policies: {
    label: 'Policies and holidays',
    hint: 'Upcoming holidays and company announcements',
  },
  'org-aggregates': {
    label: 'Organisation totals',
    hint: 'Headcount-style figures, scoped to what their role may see',
  },
  capabilities: {
    label: 'What the assistant can do',
    hint: 'The list of questions the assistant is able to answer',
  },
});

const categoryLabel = (code) =>
  CATEGORY_LABELS[code]?.label || code;

const categoryHint = (code) => CATEGORY_LABELS[code]?.hint || '';

/** The default five, used for the "reset" affordance and for a stale render. */
const FALLBACK_LANGUAGES = Object.freeze(['en', 'ta', 'tanglish', 'hi', 'te']);

/** English's code, named so the "always on" rule is readable where it is used. */
const ENGLISH = 'en';

/**
 * One tickable row. Used for both the languages and the context categories.
 *
 * `title` is the big text, `subtitle` the smaller line under it, `note` a
 * right-aligned badge. Keeping one component for both lists means the two
 * sections of this page cannot drift into looking like two different pages.
 */
const CheckRow = ({
  title,
  subtitle,
  note,
  hint,
  checked,
  locked = false,
  onToggle,
  name,
}) => (
  <li>
    <label
      className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 transition ${
        checked
          ? 'border-crewly-green/50 bg-crewly-green/5'
          : 'border-crewly-border hover:border-crewly-green/30'
      } ${locked ? 'cursor-not-allowed opacity-70' : ''}`}
    >
      {/* A real checkbox, not a styled div: it is keyboard operable and
          screen-reader labelled for free, and there is nothing here that
          needs to look clever. */}
      <input
        type="checkbox"
        checked={checked}
        disabled={locked}
        onChange={() => onToggle(name)}
        className="h-3.5 w-3.5 shrink-0 accent-crewly-green"
      />

      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-[12px] font-semibold text-crewly-text">
            {title}
          </span>

          {subtitle && (
            <span className="text-[11px] text-crewly-dim">{subtitle}</span>
          )}
        </span>

        {hint && (
          <span className="mt-0.5 block text-[10px] leading-relaxed text-crewly-dim">
            {hint}
          </span>
        )}
      </span>

      {note && (
        <span className="shrink-0 text-[10px] font-semibold text-crewly-dim">
          {note}
        </span>
      )}
    </label>
  </li>
);

const AiSettingsPage = () => {
  const [config, setConfig] = useState(null);

  const [draft, setDraft] = useState({
    enabled: true,
    monthlyQuotaTokens: null,
    allowedCategories: [],
    languages: [],
  });

  // The language catalogue, as records. Used for the language rows.
  const [catalogue, setCatalogue] = useState([]);

  // The platform's own category CODES. The server sends the tenant's ENABLED
  // list but not the full set, so the page needs the codes from somewhere to
  // offer the ones that are switched off. They are a fixed platform constant,
  // the same way the language catalogue is.
  const [categoryCodes, setCategoryCodes] = useState([]);

  const [loading, setLoading] = useState(true);

  const [saving, setSaving] = useState(false);

  const [error, setError] = useState('');

  const [saved, setSaved] = useState('');

  /**
   * Read the tenant's configuration.
   *
   * No synchronous setState: every write happens after an `await`, which is
   * what the react-hooks/set-state-in-effect rule is about and is also just
   * correct — this effect runs on mount, and setting state before the request
   * would render a spinner the browser never paints.
   */
  const read = useCallback(async () => {
    try {
      const data = await getAiConfig();

      setConfig(data);

      setCatalogue(data.languageCatalogue);

      // The platform's category codes, in the backend's own order, so the
      // section below does not reshuffle between reloads.
      setCategoryCodes(
        Array.isArray(data.categoryCatalogue)
          ? data.categoryCatalogue
          : [],
      );

      setDraft({
        enabled: data.enabled,
        monthlyQuotaTokens: data.monthlyQuotaTokens,
        allowedCategories: data.allowedCategories,
        languages: data.languages,
      });
    } catch (requestError) {
      // Stated as a failure, never as zeros. An empty form and a broken one
      // look the same only if the code lies about it — and an admin who
      // saves a form they could not read would silently reset the tenant.
      setError(
        requestError?.message ||
          'The AI settings could not be loaded. Please try again.',
      );

      setConfig(null);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);

    await read();

    setLoading(false);
  }, [read]);

  useEffect(() => {
    read();
  }, [read]);

  /**
   * Has anything changed since the last save?
   *
   * Compared field by field rather than by reference, because `draft` is a
   * fresh object after every keystroke. Saving when nothing changed would
   * burn a request and make the admin think a no-op was a change.
   */
  const dirty = useMemo(() => {
    if (!config) return false;

    if (draft.enabled !== config.enabled) return true;

    if (draft.monthlyQuotaTokens !== config.monthlyQuotaTokens) return true;

    const categoriesChanged =
      draft.allowedCategories.length !== config.allowedCategories.length ||
      draft.allowedCategories.some(
        (entry) => !config.allowedCategories.includes(entry),
      );

    if (categoriesChanged) return true;

    return (
      draft.languages.length !== config.languages.length ||
      draft.languages.some((code) => !config.languages.includes(code))
    );
  }, [config, draft]);

  /**
   * WHICH fields changed, and how many.
   *
   * The count is what the sticky save bar shows. It is deliberately a count
   * of FIELDS and not of ticks: "3 unsaved changes" for three languages plus
   * the kill switch would be four, which reads as a bug to anyone counting
   * the checkboxes they touched.
   */
  const dirtyFields = useMemo(() => {
    if (!config) return [];

    const changed = [];

    if (draft.enabled !== config.enabled) changed.push('the assistant switch');

    if (draft.monthlyQuotaTokens !== config.monthlyQuotaTokens) {
      changed.push('the token ceiling');
    }

    const categoriesChanged =
      draft.allowedCategories.length !== config.allowedCategories.length ||
      draft.allowedCategories.some(
        (entry) => !config.allowedCategories.includes(entry),
      );

    if (categoriesChanged) changed.push('the context categories');

    const languagesChanged =
      draft.languages.length !== config.languages.length ||
      draft.languages.some((code) => !config.languages.includes(code));

    if (languagesChanged) changed.push('the reply languages');

    return changed;
  }, [config, draft]);

  const dirtyCount = dirtyFields.length;

  /** Toggle one language. English is refused here as well as on the model. */
  const toggleLanguage = useCallback((code) => {
    setSaved('');

    setDraft((current) => {
      if (code === ENGLISH) return current;

      return {
        ...current,
        languages: current.languages.includes(code)
          ? current.languages.filter((entry) => entry !== code)
          : [...current.languages, code],
      };
    });
  }, []);

  /**
   * Toggle one context category.
   *
   * Unlike English there is NO locked category here. Every one of these is a
   * real choice: a tenant that reads no leave data simply cannot answer
   * leave questions, which is a legitimate posture and not a broken state.
   * The assistant says so plainly rather than pretending.
   */
  const toggleCategory = useCallback((code) => {
    setSaved('');

    setDraft((current) => ({
      ...current,
      allowedCategories: current.allowedCategories.includes(code)
        ? current.allowedCategories.filter((entry) => entry !== code)
        : [...current.allowedCategories, code],
    }));
  }, []);

  /** Add every language on the platform that is not enabled yet. */
  const enableAll = useCallback(() => {
    setSaved('');

    setDraft((current) => ({
      ...current,
      languages: catalogue.map((entry) => entry.code),
    }));
  }, [catalogue]);

  /** Back to the platform default five. */
  const resetToDefault = useCallback(() => {
    setSaved('');

    setDraft((current) => ({ ...current, languages: [...FALLBACK_LANGUAGES] }));
  }, []);

  const save = useCallback(async () => {
    // The client refuses to send a list without English rather than letting
    // the server answer 400 for it. The model enforces the same rule, so this
    // is the friendly copy of a rule that has a hard one behind it.
    if (!draft.languages.includes(ENGLISH)) {
      setError('English must always be enabled — it is the default language.');

      return;
    }

    // The same shape of guard for the categories, and it is here because it
    // was missing. The platform requires at least one context category, so a
    // payload with none comes back a 400 whose message used to render at the
    // TOP of the page — off-screen for anyone who had scrolled into the
    // language list, which is everyone using this page.
    if (draft.allowedCategories.length === 0) {
      setError(
        'At least one context category must stay enabled. Switch the assistant off instead if you want it to read no HR records.',
      );

      return;
    }

    setSaving(true);

    setError('');

    setSaved('');

    try {
      // ONLY the keys that actually changed are sent.
      //
      // Two bugs this fixes. The old line was `if (dirty) updates.languages =
      // draft.languages`, which fired whenever ANYTHING was dirty — so
      // toggling the kill switch re-sent the language list too, harmless but
      // wrong. And `allowedCategories` was never sent at all, which is why
      // the section below used to be read-only: the plumbing for saving it
      // was simply missing.
      const updates = {};

      if (draft.enabled !== config?.enabled) updates.enabled = draft.enabled;

      if (draft.monthlyQuotaTokens !== config?.monthlyQuotaTokens) {
        updates.monthlyQuotaTokens = draft.monthlyQuotaTokens;
      }

      if (dirtyFields.includes('the context categories')) {
        updates.allowedCategories = draft.allowedCategories;
      }

      if (dirtyFields.includes('the reply languages')) {
        updates.languages = draft.languages;
      }

      await updateAiConfig(updates);

      // Re-read rather than trusting the local draft: the server is the
      // authority on what was stored, and a second admin may have changed
      // something between this page's load and its save.
      await read();

      setSaved('AI settings saved.');
    } catch (requestError) {
      setError(
        requestError?.message ||
          'The AI settings could not be saved. Please try again.',
      );
    } finally {
      setSaving(false);
    }
  }, [draft, config, dirtyFields, read]);

  /*
   * THE UNSAVED-CHANGES GUARD.
   *
   * `beforeunload` fires for the three ways a person actually loses work:
   * refreshing, closing the tab, and typing a new URL. All three are browser
   * events, so this is the native answer and needs no package.
   *
   * WHAT IT DOES NOT COVER. Clicking a link in the sidebar. React Router's
   * `useBlocker` would cover that, but it only works with a data router
   * (`createBrowserRouter` + `RouterProvider`) and this app uses
   * `<BrowserRouter>`, where the hook silently does nothing. Converting the
   * whole app's router to unblock one settings page is not a trade worth
   * making, so the limitation is stated here instead of papered over.
   *
   * The handler is registered only while dirty, and `returnValue` must be
   * set for the browser to show its own confirm dialog — an empty string
   * means "do not prompt" in every current engine.
   */
  useEffect(() => {
    if (!dirty) return undefined;

    const warn = (event) => {
      event.preventDefault();
      event.returnValue = '';

      return '';
    };

    window.addEventListener('beforeunload', warn);

    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const enabledCount = draft.languages.length;

  /** Human sentence for the sticky bar, e.g. "the reply languages". */
  const dirtySummary = dirtyFields.length === 0 ? '' : dirtyFields.join(', ');

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-crewly-text">AI Settings</h1>

          <p className="mt-0.5 text-[12px] text-crewly-dim">
            Control the HR assistant for your company.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-crewly-border px-3 py-1.5 text-[12px] font-semibold text-crewly-dim transition hover:text-crewly-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RotateCcw
              className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
              aria-hidden="true"
              strokeWidth={1.9}
            />

            Reload
          </button>

          <button
            type="button"
            onClick={save}
            disabled={saving || !dirty || loading}
            className="flex items-center gap-1.5 rounded-lg bg-crewly-green px-3 py-1.5 text-[12px] font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" aria-hidden="true" strokeWidth={1.9} />

            {saving ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      </header>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-crewly-red/40 bg-crewly-red/10 px-3 py-2.5 text-xs text-crewly-red">
          <AlertTriangle
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
            strokeWidth={1.9}
          />

          <div className="min-w-0 flex-1">
            <p className="font-semibold">Something went wrong</p>

            <p className="mt-0.5 leading-relaxed">{error}</p>
          </div>

          <button
            type="button"
            onClick={() => setError('')}
            className="shrink-0 rounded p-0.5 transition hover:bg-crewly-red/20"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" strokeWidth={1.9} />
          </button>
        </div>
      )}

      {saved && !error && (
        <div className="flex items-start gap-2 rounded-xl border border-crewly-green/40 bg-crewly-green/10 px-3 py-2.5 text-xs text-crewly-green">
          <Check
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
            strokeWidth={1.9}
          />

          <p className="font-semibold">{saved}</p>
        </div>
      )}

      {loading && !config && (
        <p className="text-[12px] text-crewly-dim">Loading AI settings...</p>
      )}

      {/* ── THE LANGUAGE MANAGER ─────────────────────────────────────────── */}
      <section className="rounded-xl border border-crewly-border bg-crewly-card p-4">
        <header className="flex items-start gap-2">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-crewly-green/10 text-crewly-green">
            <Languages className="h-4 w-4" aria-hidden="true" strokeWidth={1.9} />
          </span>

          <div className="min-w-0 flex-1">
            <h2 className="text-[13px] font-bold text-crewly-text">
              Reply languages
            </h2>

            <p className="mt-0.5 text-[11px] leading-relaxed text-crewly-dim">
              The languages employees may pick in the assistant. Enable one and
              it opens up for everyone at your company straight away.
            </p>
          </div>

          <span className="shrink-0 rounded-full bg-crewly-border/60 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-crewly-dim">
            {enabledCount} enabled
          </span>
        </header>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={enableAll}
            disabled={loading}
            className="flex items-center gap-1 rounded-lg border border-crewly-border px-2.5 py-1 text-[11px] font-semibold text-crewly-dim transition hover:text-crewly-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="h-3 w-3" aria-hidden="true" strokeWidth={2} />
            Enable all
          </button>

          <button
            type="button"
            onClick={resetToDefault}
            disabled={loading}
            className="flex items-center gap-1 rounded-lg border border-crewly-border px-2.5 py-1 text-[11px] font-semibold text-crewly-dim transition hover:text-crewly-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" strokeWidth={2} />
            Reset to default
          </button>
        </div>

        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {catalogue.map((entry) => (
            <CheckRow
              key={entry.code}
              name={entry.code}
              title={entry.native}
              subtitle={entry.label}
              hint={entry.hint}
              checked={draft.languages.includes(entry.code)}
              locked={entry.code === ENGLISH}
              note={entry.code === ENGLISH ? 'Always on' : ''}
              onToggle={toggleLanguage}
            />
          ))}
        </ul>

        <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-relaxed text-crewly-dim">
          <AlertTriangle
            className="mt-0.5 h-3 w-3 shrink-0"
            aria-hidden="true"
            strokeWidth={1.9}
          />

          <span>
            English is always on. It is the default reply language and the one
            the assistant falls back to, so a company without it would offer
            languages the assistant cannot actually produce.
          </span>
        </p>
      </section>

      {/* ── THE KILL SWITCH ──────────────────────────────────────────────── */}
      <section className="rounded-xl border border-crewly-border bg-crewly-card p-4">
        <header className="flex items-start gap-2">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-crewly-green/10 text-crewly-green">
            <Check className="h-4 w-4" aria-hidden="true" strokeWidth={1.9} />
          </span>

          <div className="min-w-0 flex-1">
            <h2 className="text-[13px] font-bold text-crewly-text">
              Assistant enabled
            </h2>

            <p className="mt-0.5 text-[11px] leading-relaxed text-crewly-dim">
              Switch the assistant off for your company. It answers nothing
              until it is switched back on, and the rest of the product is
              unaffected.
            </p>
          </div>

          <label className="flex shrink-0 cursor-pointer items-center gap-2">
            <span className="sr-only">Assistant enabled</span>

            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  enabled: event.target.checked,
                }))
              }
              className="h-3.5 w-3.5 accent-crewly-green"
            />
          </label>
        </header>
      </section>

      {/* ── WHAT THE ASSISTANT MAY READ ──────────────────────────────────── */}
      <section className="rounded-xl border border-crewly-border bg-crewly-card p-4">
        <header className="flex items-start gap-2">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-crewly-green/10 text-crewly-green">
            <Database className="h-4 w-4" aria-hidden="true" strokeWidth={1.9} />
          </span>

          <div className="min-w-0 flex-1">
            <h2 className="text-[13px] font-bold text-crewly-text">
              Context categories
            </h2>

            <p className="mt-0.5 text-[11px] leading-relaxed text-crewly-dim">
              Which parts of an employee&rsquo;s own HR record the assistant may
              read to answer. An employee&rsquo;s own payslips, leave and
              attendance are always scoped to them and to nobody else.
            </p>
          </div>
        </header>

        {/*
          EDITABLE, and that is the change. This section used to render the
          tenant's categories as read-only pills, which on a page called
          "Settings" reads as a control that is broken rather than one that
          was never wired. `updateAiConfig` now sends `allowedCategories`,
          so the tick does something.
        */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              setDraft((current) => ({
                ...current,
                allowedCategories: [...categoryCodes],
              }))
            }
            disabled={loading || categoryCodes.length === 0}
            className="flex items-center gap-1 rounded-lg border border-crewly-border px-2.5 py-1 text-[11px] font-semibold text-crewly-dim transition hover:text-crewly-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="h-3 w-3" aria-hidden="true" strokeWidth={2} />
            Enable all
          </button>

          {/*
            NO "CLEAR ALL" BUTTON, AND THAT IS THE FIX.
            The one that used to be here produced `allowedCategories: []`,
            which the backend refuses with "allowedCategories must be a
            non-empty array". So it built a state that could not be saved,
            and the person who clicked it then found that Save did nothing.

            A tenant that wants the assistant reading no HR data has the
            kill switch two sections down, which is the honest control for
            that. Requiring at least one category is a deliberate platform
            rule from 36.2 and this page does not offer a way around it.
          */}
          <span className="ml-auto shrink-0 rounded-full bg-crewly-border/60 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-crewly-dim">
            {draft.allowedCategories.length} enabled
          </span>
        </div>

        {categoryCodes.length === 0 ? (
          <p className="mt-3 text-[11px] text-crewly-dim">
            {loading ? 'Loading...' : 'No categories are available.'}
          </p>
        ) : (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {categoryCodes.map((code) => (
              <CheckRow
                key={code}
                name={code}
                title={categoryLabel(code)}
                subtitle={code}
                hint={categoryHint(code)}
                checked={draft.allowedCategories.includes(code)}
                onToggle={toggleCategory}
              />
            ))}
          </ul>
        )}

        {/*
          The one honest warning this section needs. Switching everything off
          is ALLOWED — it is a legitimate posture for a company that does not
          want the assistant reading HR records at all — but it is not a
          silent no-op, so the page says what it will mean.
        */}
        {config && draft.allowedCategories.length === 0 && (
          <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-relaxed text-crewly-dim">
            <AlertTriangle
              className="mt-0.5 h-3 w-3 shrink-0"
              aria-hidden="true"
              strokeWidth={1.9}
            />

            <span>
              With every category off, the assistant has no HR record to read
              and will say so. It will still answer general questions about
              what it can do, and it will point people to the right screen.
            </span>
          </p>
        )}
      </section>

      {/*
        THE STICKY SAVE BAR — the fix for the reported problem.

        The old page put Save and Reload in the page header, which scrolls
        away. The Reply languages card is seven rows tall and the categories
        card is six more, so an admin working in either one had to scroll all
        the way back up to save. In the owner's own screenshot there is no
        save button anywhere on screen.

        WHY IT IS AT THE BOTTOM AND NOT THE TOP. The app shell already has a
        `sticky top-0 z-30` header. A second sticky bar at the top would have
        to be offset past it by a height that changes between breakpoints,
        and would slide underneath it whenever the guess was wrong. A bottom
        bar has no such conflict: it floats clear of the shell, and it is
        where a person's eyes already are after they have just ticked a box.

        It only renders when something is actually unsaved. A permanent bar
        would be furniture; a bar that appears when there is work to keep is
        a signal.
      */}
      {dirty && (
        /*
          THREE THINGS THIS BAR GETS RIGHT, ALL OF THEM LEARNED THE HARD WAY.

          1. `pr-[76px]` — THE FLOATING AI WIDGET. It is
             `fixed bottom-5 right-5 z-40` and 56px across, so it occupies the
             rightmost 76px of the viewport bottom. This bar is z-20, which
             puts it UNDERNEATH. Without the padding, the Save button sits
             directly under the widget and a click on it opens the assistant
             instead of saving. That is exactly what the owner reported:
             "save not working", with the widget visibly overlapping the
             button in their screenshot.

             The widget is a global affordance mounted in the app shell, so
             it is not this page's to hide or out-rank. The bar steps around
             it instead.

          2. THE ERROR RENDERS HERE, NOT ONLY AT THE TOP. The page-level
             banner is at the top of a long page. Anyone who has scrolled
             into the language list — which is everyone using this page —
             cannot see it. A failed save that reports nothing where the
             button is reads as a button that does nothing.

          3. `z-20`, deliberately below the widget's z-40. Raising the bar
             above it would bury a control that is supposed to be reachable
             from every screen in the product.
        */
        <div className="sticky bottom-4 z-20 mt-4 pr-[76px]">
          <div className="overflow-hidden rounded-xl border border-crewly-green/40 bg-crewly-card/95 shadow-lg backdrop-blur">
            {error && (
              <p
                role="alert"
                className="flex items-start gap-1.5 border-b border-crewly-red/30 bg-crewly-red/10 px-3 py-2 text-[11px] leading-relaxed text-crewly-red"
              >
                <AlertTriangle
                  className="mt-0.5 h-3 w-3 shrink-0"
                  aria-hidden="true"
                  strokeWidth={1.9}
                />

                <span className="min-w-0 flex-1">{error}</span>

                <button
                  type="button"
                  onClick={() => setError('')}
                  className="shrink-0 rounded p-0.5 transition hover:bg-crewly-red/20"
                  aria-label="Dismiss"
                >
                  <X className="h-3 w-3" aria-hidden="true" strokeWidth={1.9} />
                </button>
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
              <p className="flex min-w-0 items-center gap-2 text-[11px] text-crewly-dim">
                <AlertTriangle
                  className="h-3.5 w-3.5 shrink-0 text-crewly-green"
                  aria-hidden="true"
                  strokeWidth={1.9}
                />

                <span className="min-w-0">
                  <span className="font-semibold text-crewly-text">
                    {dirtyCount} unsaved {dirtyCount === 1 ? 'change' : 'changes'}
                  </span>

                  {dirtySummary && (
                    <span className="ml-1">({dirtySummary})</span>
                  )}
                </span>
              </p>

              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={load}
                  disabled={loading}
                  className="rounded-lg border border-crewly-border px-2.5 py-1 text-[11px] font-semibold text-crewly-dim transition hover:text-crewly-text disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Discard
                </button>

                <button
                  type="button"
                  onClick={save}
                  disabled={saving || loading}
                  className="flex items-center gap-1.5 rounded-lg bg-crewly-green px-3 py-1.5 text-[12px] font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Save
                    className="h-3.5 w-3.5"
                    aria-hidden="true"
                    strokeWidth={1.9}
                  />

                  {saving ? 'Saving...' : 'Save changes'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AiSettingsPage;
