import api from './api.js';

// Phase 31.14 — alternate attendance capture: kiosk stations, QR
// challenges, CSV imports. Tenant-scoped by the backend
// (req.companyId); source/provenance are server-decided and never
// sent from the browser.
// The api.js response interceptor pre-unwraps bodies WITHOUT meta
// (hands us bare data) but keeps bodies WITH meta whole. Normalize both
// shapes to { data, ... } so every call site reads `.data` exactly once.
const envelope = (promise) =>
  promise.then((response) => {
    if (
      response &&
      typeof response === 'object' &&
      !Array.isArray(response) &&
      'data' in response &&
      'success' in response
    ) {
      return response;
    }
    return { data: response ?? null };
  });

const multipart = (file) => {
  const form = new FormData();
  form.append('file', file);
  return form;
};

const attendanceCaptureService = {
  // ── Kiosk stations (HR) ──
  listStations: () => envelope(api.get('/attendance/kiosks')),

  createStation: (payload) => envelope(api.post('/attendance/kiosks', payload)),

  updateStation: (stationId, payload) =>
    envelope(api.patch(`/attendance/kiosks/${stationId}`, payload)),

  rotateStationSecret: (stationId) =>
    envelope(api.post(`/attendance/kiosks/${stationId}/rotate-secret`)),

  // ── QR challenges ──
  createChallenge: (payload) => envelope(api.post('/attendance/qr/challenges', payload)),

  resolveChallenge: (token) => envelope(api.post('/attendance/qr/resolve', { token })),

  redeemChallenge: (payload) => envelope(api.post('/attendance/qr/redeem', payload)),

  // ── CSV imports (HR; real multipart uploads) ──
  previewImport: (file) =>
    envelope(
      api.post('/attendance/imports/preview', multipart(file), {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
    ),

  confirmImport: (file) =>
    envelope(
      api.post('/attendance/imports/confirm', multipart(file), {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
    ),

  listImports: () => envelope(api.get('/attendance/imports')),

  getImport: (importId) => envelope(api.get(`/attendance/imports/${importId}`)),

  downloadTemplate: async () => {
    const blob = await api
      .get('/attendance/imports/template.csv', { responseType: 'blob' })
      .then((response) => response.data ?? response);
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'attendance-import-template.csv';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.URL.revokeObjectURL(url);
  },
};

export default attendanceCaptureService;
