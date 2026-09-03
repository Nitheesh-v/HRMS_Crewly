// ============================================================
//  PHASE 30.1 — BGV CHECK DOMAIN EVENT BUS (hook only)
//
//  In-process listener registry so 30.2-30.6 can react to check
//  status changes (e.g. 30.3 subscribes to IN_PROGRESS on
//  EMPLOYMENT/EDUCATION and schedules the first verification
//  request). 30.1 intentionally does NOT enqueue any BullMQ
//  job here — the bus is synchronous-safe and never throws:
//  a listener failure must never fail the user's request or
//  the mutation that produced the event.
// ============================================================

const listeners = new Set();

export const onBgvCheckEvent = (listener) => {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const emitBgvCheckEvent = async (event) => {
  for (const listener of listeners) {
    try {
      await listener(event);
    } catch {
      // Swallowed on purpose: events are best-effort side hooks.
    }
  }
  return { delivered: listeners.size };
};
