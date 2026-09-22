// Phase 32.8 — authorized private-file download helper.
//
// Private files (documents, receipts, task attachments) are NO LONGER
// public URLs the browser can open directly — bytes flow through the
// API with the caller's authentication, and the backend checks
// authorization before handing anything out. This is the shared
// "fetch blob via the api instance → save it" path (same pattern the
// payslip service has always used).

export const saveBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob instanceof Blob ? blob : new Blob([blob]));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || 'file';
  link.click();
  URL.revokeObjectURL(url);
};

/**
 * @param {() => Promise<Blob>} getBlob — a service call returning the
 *   authorized blob (api.get(url, { responseType: 'blob' })).
 * @param {string} filename — suggested download name.
 * @param {() => void} [onUnauthorized] — optional UX hook (the backend
 *   answers 404/403 when the caller may not see this file).
 */
export const downloadAuthorizedFile = async (getBlob, filename, onUnauthorized) => {
  try {
    const blob = await getBlob();
    saveBlob(blob, filename);
  } catch (error) {
    if (onUnauthorized) return onUnauthorized(error);
    throw error;
  }
};
