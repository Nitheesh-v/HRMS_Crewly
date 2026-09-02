/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from 'react';

import departmentService from '../../../services/departmentService.js';
import payrollAnalyticsService from '../../../services/payrollAnalyticsService.js';

// ───────────────────────────────────────────────────────────────────────────
// Phase 29.12 — formatting helpers and data hooks for the analytics pages.
//
// They live in a .js module, separate from the components in
// analyticsShared.jsx, because React Fast Refresh only works when a file
// exports components alone.
// ───────────────────────────────────────────────────────────────────────────

export const currentMonth = () => new Date().toISOString().slice(0, 7);

export const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const money = (value) =>
  `Rs ${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

export const money2 = (value) =>
  `Rs ${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const count = (value) => Number(value || 0).toLocaleString('en-IN');

export const percent = (value) =>
  `${Number(value || 0).toFixed(Number(value || 0) % 1 === 0 ? 0 : 1)}%`;

export const monthLabel = (month) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) return month || '—';
  const [year, part] = String(month).split('-');
  return `${MONTHS_LONG[Number(part) - 1]} ${year}`;
};

export const monthShort = (month) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) return month || '—';
  const [year, part] = String(month).split('-');
  return `${MONTHS_LONG[Number(part) - 1].slice(0, 3)} ${String(year).slice(2)}`;
};

export const formatDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

export const formatDateTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
};

export const currentFinancialYear = () => {
  const now = new Date();
  const year = now.getFullYear();
  const start = now.getMonth() + 1 >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
};

export const financialYearOf = (month) => {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return currentFinancialYear();
  const [year, part] = String(month).split('-').map(Number);
  const start = part >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
};

// The last `total` months ending at `month`, newest last — the same window the
// backend trends over, so the switcher never offers a month with no data.
export const recentMonths = (month, total = 12) => {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(month || ''));
  if (!match) return [];
  const end = { year: Number(match[1]), part: Number(match[2]) };
  const months = [];
  for (let back = total - 1; back >= 0; back -= 1) {
    const index = end.year * 12 + (end.part - 1) - back;
    months.push(`${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`);
  }
  return months;
};

/**
 * The months this company actually has payroll for. The dashboard is cheap
 * (cached server-side) and every report page needs the same list, so the
 * switcher offers real months instead of only the current one.
 */
export const usePayrollMonths = (enabled = true) => {
  const [months, setMonths] = useState([]);

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    payrollAnalyticsService
      .dashboard()
      .then((data) => {
        if (!alive) return;
        const available = Array.isArray(data?.availableMonths) ? data.availableMonths : [];
        setMonths(available.length ? available : recentMonths(currentMonth(), 12));
      })
      .catch(() => {
        if (alive) setMonths(recentMonths(currentMonth(), 12));
      });
    return () => { alive = false; };
  }, [enabled]);

  return months;
};

// ── the hooks every report page uses ───────────────────────────────────────

export const useDepartments = () => {
  const [departments, setDepartments] = useState([]);
  useEffect(() => {
    let alive = true;
    departmentService
      .getAll()
      .then((data) => {
        const list = Array.isArray(data) ? data : data?.departments || data?.rows || [];
        if (alive) setDepartments(list);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return departments;
};

/**
 * Loads one report. Handles the three states that matter: loading, refused
 * (§25 — the server says no, so say so) and empty (nothing matched, which is
 * not an error and must not look like one).
 */
export const useReport = ({ reportKey, filters = {}, enabled = true }) => {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [denied, setDenied] = useState(false);

  const key = JSON.stringify(filters);

  const reload = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      const data = await payrollAnalyticsService.report({ reportKey, ...filters });
      setReport(data || null);
      setDenied(false);
    } catch (err) {
      if (err?.status === 403 || err?.status === 401) setDenied(true);
      else setError(err?.message || 'Unable to load this report');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportKey, key, enabled]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { report, loading, error, denied, reload };
};

// The month switcher is the one control on every analytics page, so it lives
// here rather than being reinvented ten times.
export const useMonthSwitcher = (availableMonths = []) => {
  const [month, setMonth] = useState(currentMonth());
  const months = useMemo(() => {
    if (Array.isArray(availableMonths) && availableMonths.length) return availableMonths;
    return recentMonths(month, 12);
  }, [availableMonths, month]);
  return { month, setMonth, months };
};
