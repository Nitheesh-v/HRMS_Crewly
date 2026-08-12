/*
 * Date helpers for attendance.
 * 'date' is stored as a plain string 'YYYY-MM-DD' in the company timezone,
 * which makes daily records and monthly reports simple and safe.
 * (Per-company timezone arrives with the Company Profile settings phase.)
 */
export const COMPANY_TIMEZONE = 'Asia/Kolkata';

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: COMPANY_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// Today as 'YYYY-MM-DD' in company timezone
export const todayString = () => dayFmt.format(new Date());

// Minutes since midnight (company timezone) — used for the LATE check
export const minutesSinceMidnight = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: COMPANY_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
};

// '09:30' → 570
export const timeToMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

// '2026-08' → { start: '2026-08-01', end: '2026-08-31' }
export const monthRange = (month) => {
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(lastDay).padStart(2, '0')}` };
};

// Number of Mon–Fri days between two 'YYYY-MM-DD' strings (inclusive)
export const countWorkingDays = (startStr, endStr) => {
  let count = 0;
  const d = new Date(`${startStr}T00:00:00Z`);
  const end = new Date(`${endStr}T00:00:00Z`);
  while (d <= end) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) count++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
};