export const helpdeskErrorStatus = (error) => Number(error?.status ?? error?.response?.status ?? 0);

export const safeHelpdeskError = (error, fallback = 'The Helpdesk request could not be completed.') => {
  const status = helpdeskErrorStatus(error);
  if (status === 401) return 'Your session has ended. Sign in again to continue.';
  if (status === 403) return 'Your Helpdesk access changed. Restricted information has been cleared; refresh your access or contact an administrator.';
  if (status === 404) return 'This item is no longer available or your access to it has changed.';
  if (status === 409) return 'This item changed while you were working. Refresh it and try again.';
  if (status === 413) return 'The attachment is too large. Choose a file no larger than 10 MB.';
  if (status === 429) return 'Too many requests were sent. Wait a moment and try again.';
  if (status === 400 || status === 422) return 'Some details need attention. Review the form and try again.';
  if (status >= 500) return 'The Helpdesk service is temporarily unavailable. Try again shortly.';
  if (!status && error?.code === 'ECONNABORTED') return 'The request took too long. Check your connection and try again.';
  if (!status) return 'A network problem prevented this request. Check your connection and retry.';
  return fallback;
};

export const helpdeskDateTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export const helpdeskDateOnly = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
};

export const helpdeskArray = (value) => (Array.isArray(value) ? value : []);

// The shared Axios client unwraps ordinary `{ data }` API envelopes before
// these helpers run, while paginated responses retain their top-level data/meta.
// Accept both shapes so plain DTOs are not mistaken for an empty response.
export const helpdeskData = (response) => response?.data?.data ?? response?.data ?? response ?? null;
export const helpdeskMeta = (response) => response?.data?.meta ?? response?.meta ?? null;

export const HELPDESK_STATUSES = Object.freeze([
  'open',
  'assigned',
  'in_progress',
  'waiting_for_employee',
  'waiting_for_department',
  'resolved',
  'closed',
  'cancelled',
]);

export const HELPDESK_PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);

export const HELPDESK_TRANSITIONS = Object.freeze({
  open: ['assigned', 'in_progress', 'cancelled'],
  assigned: ['open', 'in_progress', 'cancelled'],
  in_progress: ['waiting_for_employee', 'waiting_for_department', 'resolved'],
  waiting_for_employee: ['in_progress', 'resolved', 'cancelled'],
  waiting_for_department: ['in_progress', 'resolved'],
  resolved: ['in_progress', 'closed'],
  closed: [],
  cancelled: [],
});

export const helpdeskCanTransition = (currentStatus, nextStatus) =>
  HELPDESK_TRANSITIONS[String(currentStatus || '').toLowerCase()]?.includes(
    String(nextStatus || '').toLowerCase(),
  ) === true;

export const helpdeskAcceptedAttachment = (file) => {
  if (!file) return { ok: true, reason: '' };
  const size = Number(file.size);
  if (!Number.isFinite(size) || size < 0) return { ok: false, reason: 'The selected file could not be checked. Choose it again.' };
  if (size > 10 * 1024 * 1024) return { ok: false, reason: 'Choose a file no larger than 10 MB.' };
  const supportedMimeTypes = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
  const supportedExtensions = new Set(['pdf', 'jpg', 'jpeg', 'png', 'webp']);
  const mimeType = String(file.type || '').trim().toLowerCase();
  const extension = String(file.name || '').trim().match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase() || '';
  if ((mimeType && !supportedMimeTypes.has(mimeType)) || (extension && !supportedExtensions.has(extension)) || (!mimeType && !extension)) {
    return { ok: false, reason: 'Choose a PDF, JPG, JPEG, PNG, or WEBP file.' };
  }
  return { ok: true, reason: '' };
};

export const nextUtcDate = (dateString) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateString || ''))) return '';
  const date = new Date(`${dateString}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== dateString) return '';
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};
