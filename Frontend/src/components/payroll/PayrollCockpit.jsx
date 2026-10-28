import { Lock } from 'lucide-react';

// ═══════════════════════════════════════════════════════════════════════════
// PAYROLL COCKPIT — the shared furniture for the three stage pages.
//
// The three Stitch exports (Monthly Payroll Inputs, Payroll Calculation
// Cockpit, Direct Salary Disbursement) are three views of one pipeline, so they
// share one shell: a band naming the cycle stage, the four-step pipeline, a row
// of stat cards, and panels on the Warm Organic `st-` scale.
//
// Nothing here decides a number. Each page passes what its own endpoint
// returned; this file only decides how it is arranged. The pieces are
// deliberately small and dumb so a page cannot smuggle in a computed value the
// API never sent.
// ═══════════════════════════════════════════════════════════════════════════

const TONES = {
  default: 'bg-st-low text-st-on-variant',
  good: 'bg-st-secondary-container text-st-on-secondary-container',
  warn: 'bg-st-primary-fixed text-st-on-primary-fixed',
  bad: 'bg-st-error-container text-st-on-error-container',
  accent: 'bg-st-primary-container text-st-on-primary-container',
};

/** A small status pill. Tone names, not colours, at the call site. */
export const Pill = ({ tone = 'default', children, title }) => (
  <span
    title={title}
    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${TONES[tone] || TONES.default}`}
  >
    {children}
  </span>
);

/**
 * The band at the top of a stage page.
 *
 * `eyebrow` says which stage of the cycle this is, `pills` say what state the
 * month is in, and `actions` is where the page's own buttons go — in the
 * export's order, primary first.
 */
export const StageBand = ({ eyebrow, title, description, pills = [], actions, aside }) => (
  <section className="rounded-2xl bg-st-lowest p-5 shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-st-primary">{eyebrow}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-st-on lg:text-[1.75rem]">{title}</h1>
        {pills.length ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {pills.map((pill) => (
              <Pill key={pill.label} tone={pill.tone} title={pill.title}>
                {pill.label}
              </Pill>
            ))}
          </div>
        ) : null}
        {description ? (
          <p className="mt-2 max-w-2xl text-[12px] leading-relaxed text-st-on-variant">{description}</p>
        ) : null}
      </div>
      {aside ? <div className="shrink-0">{aside}</div> : null}
    </div>
    {actions ? <div className="mt-4 flex flex-wrap items-center gap-2">{actions}</div> : null}
  </section>
);

/** Primary / secondary / quiet buttons on the `st-` scale. */
export const StageButton = ({ variant = 'secondary', icon: Icon, children, ...rest }) => {
  const base =
    'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50';
  const styles = {
    primary: 'bg-st-primary-container text-st-on-primary-container hover:brightness-105 shadow-sm',
    secondary: 'border border-st-outline-variant/70 bg-st-lowest text-st-on hover:bg-st-low',
    quiet: 'text-st-on-variant hover:bg-st-low',
  };
  return (
    <button type="button" className={`${base} ${styles[variant] || styles.secondary}`} {...rest}>
      {Icon ? <Icon aria-hidden="true" size={14} /> : null}
      {children}
    </button>
  );
};

/**
 * The four-step cycle.
 *
 * `state` is one of done / active / locked. A stage the month has not reached
 * is drawn locked and says so — the export drew padlocks on stages 2–4, and
 * that is the honest thing to draw whenever the API has not produced them.
 */
export const Pipeline = ({ steps = [], footnote }) => (
  <section className="rounded-2xl bg-st-lowest p-3 shadow-sm">
    <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {steps.map((step) => {
        const active = step.state === 'active';
        const done = step.state === 'done';
        return (
          <li
            key={step.key}
            className={`rounded-xl border px-3 py-2.5 ${
              active
                ? 'border-st-primary-container bg-st-primary-fixed/60'
                : 'border-st-high bg-st-low/60'
            }`}
          >
            <div className="flex items-center gap-1.5">
              <span
                className={`text-[10px] font-bold uppercase tracking-wider ${
                  active ? 'text-st-primary' : 'text-st-on-variant/70'
                }`}
              >
                {step.index}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] font-bold uppercase tracking-wide text-st-on">
                {step.label}
              </span>
              {done ? (
                <span className="text-[10px] font-bold uppercase tracking-wide text-st-secondary">
                  done
                </span>
              ) : active ? (
                <span className="text-[10px] font-bold uppercase tracking-wide text-st-primary">
                  active
                </span>
              ) : (
                <Lock aria-hidden="true" size={11} className="text-st-on-variant/60" />
              )}
            </div>
            <p className="mt-1 text-[10px] leading-snug text-st-on-variant">{step.hint}</p>
          </li>
        );
      })}
    </ol>
    {footnote ? <p className="px-1 pt-2 text-[10px] text-st-on-variant">{footnote}</p> : null}
  </section>
);

/** A KPI tile. `hint` must be a fact from the response, not a slogan. */
export const StatCard = ({ label, value, hint, icon: Icon, tone = 'default', badge }) => (
  <div className="rounded-xl bg-st-lowest p-3.5 shadow-sm">
    <div className="flex items-start justify-between gap-1">
      <p className="text-[10px] font-bold uppercase tracking-wide text-st-on-variant">{label}</p>
      <span className="flex items-center gap-1">
        {badge ? <Pill tone={badge.tone || 'default'}>{badge.label}</Pill> : null}
        {Icon ? (
          <span className="grid h-5 w-5 place-items-center rounded-md bg-st-low text-st-on-variant">
            <Icon aria-hidden="true" size={11} />
          </span>
        ) : null}
      </span>
    </div>
    <p
      className={`mt-1.5 text-[1.35rem] font-bold leading-none tabular-nums ${
        tone === 'bad' ? 'text-st-error' : tone === 'good' ? 'text-st-secondary' : 'text-st-on'
      }`}
    >
      {value}
    </p>
    {hint ? <p className="mt-1 text-[10px] leading-snug text-st-on-variant">{hint}</p> : null}
  </div>
);

/** A titled panel — the body of every screen in the three exports. */
export const Panel = ({ title, subtitle, right, children, className = '', bodyClassName = 'p-0' }) => (
  <section className={`rounded-2xl bg-st-lowest shadow-sm ${className}`}>
    {title ? (
      <header className="flex flex-wrap items-start justify-between gap-2 px-4 pb-2 pt-3.5">
        <div className="min-w-0">
          <h2 className="text-[13px] font-bold text-st-on">{title}</h2>
          {subtitle ? (
            <p className="mt-0.5 text-[10px] leading-snug text-st-on-variant">{subtitle}</p>
          ) : null}
        </div>
        {right ? <div className="shrink-0">{right}</div> : null}
      </header>
    ) : null}
    <div className={bodyClassName}>{children}</div>
  </section>
);

/** The right-hand rail the exports use to keep context beside the table. */
export const Rail = ({ children }) => (
  <aside className="flex flex-col gap-3 xl:w-[19rem] xl:shrink-0">{children}</aside>
);

/** A label/value line inside a rail card or a summary strip. */
export const Fact = ({ label, value, icon: Icon }) => (
  <div className="flex items-start justify-between gap-3 py-1">
    <span className="flex items-center gap-1.5 text-[11px] text-st-on-variant">
      {Icon ? <Icon aria-hidden="true" size={12} /> : null}
      {label}
    </span>
    <span className="text-right text-[11px] font-semibold text-st-on">{value}</span>
  </div>
);

/** A checklist row: a real state, never an assumed tick. */
export const CheckRow = ({ ok, label, value }) => (
  <div className="flex items-start justify-between gap-2 py-1">
    <span className="flex items-start gap-1.5 text-[11px] leading-snug text-st-on-variant">
      <span
        aria-hidden="true"
        className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
          ok ? 'bg-st-secondary' : 'bg-st-primary-container'
        }`}
      />
      {label}
    </span>
    <span className="shrink-0 text-[11px] font-semibold text-st-on">{value}</span>
  </div>
);

/** Table shell: the exports use one header style for every roster. */
export const Th = ({ children, className = '' }) => (
  <th
    className={`whitespace-nowrap px-3 py-2 text-left text-[9px] font-bold uppercase tracking-wide text-st-on-variant ${className}`}
  >
    {children}
  </th>
);

export const Td = ({ children, className = '' }) => (
  <td className={`px-3 py-2 align-top text-[11px] text-st-on ${className}`}>{children}</td>
);

/** Initials chip, the identity mark the exports put in front of every row. */
export const Avatar = ({ name = '', tone }) => {
  const initials = String(name)
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
  return (
    <span
      className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10px] font-bold ${
        tone === 'accent'
          ? 'bg-st-primary-container text-st-on-primary-container'
          : 'bg-st-container text-st-on'
      }`}
    >
      {initials || '—'}
    </span>
  );
};

export default {};
