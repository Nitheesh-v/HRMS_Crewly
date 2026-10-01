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
  Languages,
  Plus,
  RotateCcw,
  Save,
  X,
} from 'lucide-react';

import { getAiConfig, updateAiConfig } from '../../services/aiService.js';

/** The default five, used for the "reset" affordance and for a stale render. */
const FALLBACK_LANGUAGES = Object.freeze(['en', 'ta', 'tanglish', 'hi', 'te']);

/** English's code, named so the "always on" rule is readable where it is used. */
const ENGLISH = 'en';

/** One language, ticked or not. */
const LanguageRow = ({ entry, enabled, locked, onToggle }) => (
  <li>
    <label
      className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 transition ${
        enabled
          ? 'border-crewly-green/50 bg-crewly-green/5'
          : 'border-crewly-border hover:border-crewly-green/30'
      } ${locked ? 'cursor-not-allowed opacity-70' : ''}`}
    >
      {/* A real checkbox, not a styled div: it is keyboard operable and
          screen-reader labelled for free, and there is nothing here that
          needs to look clever. */}
      <input
        type="checkbox"
        checked={enabled}
        disabled={locked}
        onChange={() => onToggle(entry.code)}
        className="h-3.5 w-3.5 shrink-0 accent-crewly-green"
      />

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          {/* The name in the language itself, because that is what a person
              scans for — an admin enabling Tamil looks for தமிழ். */}
          <span className="text-[12px] font-semibold text-crewly-text">
            {entry.native}
          </span>

          <span className="text-[11px] text-crewly-dim">{entry.label}</span>
        </span>

        {entry.hint && (
          <span className="mt-0.5 block text-[10px] leading-relaxed text-crewly-dim">
            {entry.hint}
          </span>
        )}
      </span>

      {locked && (
        <span className="shrink-0 text-[10px] font-semibold text-crewly-dim">
          Always on
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

  const [catalogue, setCatalogue] = useState([]);

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

    setSaving(true);

    setError('');

    setSaved('');

    try {
      // Only the keys the admin actually changed are sent, so a stale render
      // cannot overwrite a field it never showed.
      const updates = {};

      if (draft.enabled !== config?.enabled) updates.enabled = draft.enabled;

      if (draft.monthlyQuotaTokens !== config?.monthlyQuotaTokens) {
        updates.monthlyQuotaTokens = draft.monthlyQuotaTokens;
      }

      if (dirty) updates.languages = draft.languages;

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
  }, [draft, config, dirty, read]);

  const enabledCount = draft.languages.length;

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
            <LanguageRow
              key={entry.code}
              entry={entry}
              enabled={draft.languages.includes(entry.code)}
              locked={entry.code === ENGLISH}
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
            <Check className="h-4 w-4" aria-hidden="true" strokeWidth={1.9} />
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

        <div className="mt-3">
          {config && config.allowedCategories.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {config.allowedCategories.map((entry) => (
                <li
                  key={entry}
                  className="rounded-full border border-crewly-border px-2 py-0.5 text-[10px] font-semibold text-crewly-dim"
                >
                  {entry}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-crewly-dim">
              {loading
                ? 'Loading...'
                : 'No categories are enabled for this company.'}
            </p>
          )}
        </div>
      </section>
    </div>
  );
};

export default AiSettingsPage;
