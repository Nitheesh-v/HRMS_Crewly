// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.10-fix3 — THE ATTACHMENT REFERENCE VIEW (one shape, two surfaces)
//
//  WHY THIS FILE EXISTS
//    33.10 added attachment references to the SOCKET broadcast but not to the
//    REST history projection: `sanitizeMessageForHistory` (33.4) is a field
//    whitelist, and `attachments` was never added to it. The result was a
//    message that rendered correctly when it arrived live and as an empty
//    bubble the moment the page reloaded and the transcript came from history:
//
//      live socket   -> { ..., attachments: [ { attachmentId, fileName, ... } ] }
//      GET history   -> { ..., attached?: undefined }        (the file vanished)
//
//    The reference shape now has ONE definition, used by both surfaces, so
//    they cannot drift again (test/chatHistory.test.js pins the equality).
//
//  WHAT LEAVES THE SERVER
//    id + display metadata only. Never a storage key, never a provider URL,
//    never the checksum: the bytes are a separate, auth-gated download, and a
//    missing row is a null, not a crash.
// ═══════════════════════════════════════════════════════════════════════════

export const toAttachmentReferences = (attachments) =>
  (Array.isArray(attachments) ? attachments : []).map((row) => ({
    attachmentId: row?.attachmentId ?? null,
    fileName: row?.fileName ?? null,
    mimeType: row?.mimeType ?? null,
    sizeBytes: row?.sizeBytes ?? null,
  }));

export default toAttachmentReferences;
