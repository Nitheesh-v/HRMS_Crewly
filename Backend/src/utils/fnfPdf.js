// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.11 — FINAL SETTLEMENT STATEMENT PDF (§17)
//
//  This is deliberately NOT a payslip. A payslip explains one month of work;
//  an F&F statement explains the end of an employment: what is still owed,
//  what is being recovered, and who signed off on it.
//
//  It draws and nothing else: every rupee arrives already computed by
//  fnfRules.js / fnfService.js, so the PDF can never disagree with the
//  register CSV sitting next to it.
//
//  Same design language as utils/payslipPdf.js and utils/statutoryPdf.js
//  (palette, Indian digit grouping, the diamond marker) so the three read as
//  one product.
//
//  §26 — no digital signature and no legal document. The footer says what
//  this is: a statement prepared by Crewly. There is deliberately no
//  signature line for anyone to mistake for one.
// ═══════════════════════════════════════════════════════════════════════════
import PDFDocument from 'pdfkit';

import { NOTICE_DECISION_LABELS, formatDate, inr, rupees } from '../services/payroll/fnfRules.js';

const C = {
  ink: '#111827',
  navy: '#16324f',
  label: '#8a94a6',
  subtle: '#5b6472',
  divider: '#d7dce5',
  band: '#f7f9fc',
  green: '#0f7a4a',
  greenBg: '#eaf8f0',
  red: '#b4231f',
  redBg: '#fdeceb',
  accent: '#16324f',
};

const PAGE_WIDTH = 595.28; // A4 points
const M = { left: 40, top: 44, right: 40 };
const CONTENT_WIDTH = PAGE_WIDTH - M.left - M.right;

const initialsOf = (name) =>
  String(name || 'C')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();

const diamond = (doc, cx, cy, r, color) =>
  doc.save()
    .moveTo(cx, cy - r)
    .lineTo(cx + r, cy)
    .lineTo(cx, cy + r)
    .lineTo(cx - r, cy)
    .closePath()
    .fill(color)
    .restore();

const ensureSpace = (doc, y, needed) => {
  if (y + needed <= 780) return y;
  doc.addPage();
  return M.top;
};

// ── header ─────────────────────────────────────────────────────────────────

const drawHeader = (doc, { company = {}, settlement = {}, logo = null } = {}) => {
  const badgeX = M.left;
  const badgeY = M.top;

  if (logo?.content && logo?.kind) {
    try {
      const image = Buffer.isBuffer(logo.content)
        ? logo.content
        : Buffer.from(String(logo.content), 'base64');
      doc.save()
        .roundedRect(badgeX, badgeY, 40, 40, 6)
        .clip()
        .image(image, badgeX, badgeY, { fit: [40, 40], align: 'center', valign: 'center' })
        .restore();
    } catch {
      doc.save().roundedRect(badgeX, badgeY, 40, 40, 6).fill(C.navy).restore();
      doc.font('Helvetica-Bold').fontSize(15).fillColor('#ffffff')
        .text(initialsOf(company.name), badgeX, badgeY + 13, { width: 40, align: 'center' });
    }
  } else {
    doc.save().roundedRect(badgeX, badgeY, 40, 40, 6).fill(C.navy).restore();
    doc.font('Helvetica-Bold').fontSize(15).fillColor('#ffffff')
      .text(initialsOf(company.name), badgeX, badgeY + 13, { width: 40, align: 'center' });
  }

  const x = badgeX + 52;
  doc.font('Helvetica-Bold').fontSize(13).fillColor(C.navy)
    .text(String(company.name || 'Company').toUpperCase(), x, badgeY + 2, { width: 260, ellipsis: true, lineBreak: false });
  doc.font('Helvetica').fontSize(7.4).fillColor(C.subtle)
    .text(String(company.address || ''), x, badgeY + 19, { width: 260, height: 20, ellipsis: true });

  // §17 — the document identifies itself by its settlement number.
  doc.font('Helvetica-Bold').fontSize(12).fillColor(C.navy)
    .text('Full & Final Settlement Statement', M.left, badgeY + 2, { width: CONTENT_WIDTH, align: 'right' });
  doc.font('Helvetica').fontSize(8).fillColor(C.subtle)
    .text(settlement?.settlementNumber || '', M.left, badgeY + 19, { width: CONTENT_WIDTH, align: 'right' });
  doc.font('Helvetica').fontSize(7).fillColor(C.label)
    .text(settlement?.monthLabel || settlement?.month || '', M.left, badgeY + 30, { width: CONTENT_WIDTH, align: 'right' });

  const y = badgeY + 50;
  doc.save().moveTo(M.left, y).lineTo(M.left + CONTENT_WIDTH, y).lineWidth(1).stroke(C.divider).restore();
  return y + 16;
};

// ── a two-column detail grid (employee / exit details) ──────────────────────

const drawDetailGrid = (doc, { title = '', rows = [], startY }) => {
  const ROW_PITCH = 27;
  let y = ensureSpace(doc, startY, 34 + rows.length * ROW_PITCH);

  diamond(doc, M.left + 2.6, y + 3.6, 2.6, C.accent);
  doc.font('Helvetica-Bold').fontSize(9.6).fillColor(C.ink).text(String(title || ''), M.left + 12, y);
  y += 20;

  // Rows are FLAT four-tuples: [label, value, label, value]. Destructuring a
  // nested pair here instead would walk the string one character at a time.
  const columnWidth = CONTENT_WIDTH / 2;
  rows.forEach((row, rowIndex) => {
    const top = y + rowIndex * ROW_PITCH;
    for (let column = 0; column < 2; column += 1) {
      const label = row?.[column * 2];
      const value = row?.[column * 2 + 1];
      const x = M.left + column * columnWidth;
      doc.font('Helvetica').fontSize(6.6).fillColor(C.label)
        .text(String(label || ''), x + 2, top, { width: columnWidth - 8, ellipsis: true, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(8.6).fillColor(C.ink)
        .text(String(value === undefined || value === null || value === '' ? '—' : value), x + 2, top + 10, {
          width: columnWidth - 8,
          ellipsis: true,
          lineBreak: false,
        });
    }
  });

  return y + rows.length * ROW_PITCH + 12;
};

// ── an amount table: label | note | amount ─────────────────────────────────

const drawAmountTable = (doc, { title = '', note = '', rows = [], total = null, startY, tone = 'ink' } = {}) => {
  const ROW_HEIGHT = 17;
  let y = ensureSpace(doc, startY, 60 + rows.length * ROW_HEIGHT);

  diamond(doc, M.left + 2.6, y + 3.6, 2.6, tone === 'red' ? C.red : C.accent);
  doc.font('Helvetica-Bold').fontSize(9.6).fillColor(C.ink).text(String(title || ''), M.left + 12, y);
  if (note) {
    doc.font('Helvetica').fontSize(6.8).fillColor(C.label).text(String(note), M.left + 12, y + 12);
  }
  y += 26;

  doc.save().rect(M.left, y - 3, CONTENT_WIDTH, 15).fill(C.navy).restore();
  doc.font('Helvetica-Bold').fontSize(7).fillColor('#ffffff')
    .text('Particulars', M.left + 5, y + 1, { width: 240, ellipsis: true, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(7).fillColor('#ffffff')
    .text('Amount', M.left + CONTENT_WIDTH - 130, y + 1, { width: 125, align: 'right' });
  y += 18;

  if (!rows.length) {
    doc.font('Helvetica').fontSize(7.6).fillColor(C.label).text('Nothing to show.', M.left + 5, y + 2);
    y += 20;
  }

  rows.forEach((row, index) => {
    y = ensureSpace(doc, y, 20);
    if (index % 2 === 0) {
      doc.save().rect(M.left, y - 2, CONTENT_WIDTH, 16).fill(C.band).restore();
    }
    doc.font('Helvetica').fontSize(7.8).fillColor(C.subtle)
      .text(String(row.label || ''), M.left + 5, y + 2, { width: 250, ellipsis: true, lineBreak: false });
    if (row.detail) {
      doc.font('Helvetica').fontSize(6.6).fillColor(C.label)
        .text(String(row.detail), M.left + 5, y + 10, { width: 250, ellipsis: true, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(7.8).fillColor(C.ink)
        .text(rupees(row.amount), M.left + CONTENT_WIDTH - 130, y + 2, { width: 125, align: 'right' });
    } else {
      doc.font('Helvetica-Bold').fontSize(7.8).fillColor(C.ink)
        .text(rupees(row.amount), M.left + CONTENT_WIDTH - 130, y + 2, { width: 125, align: 'right' });
    }
    y += ROW_HEIGHT;
  });

  if (total) {
    y = ensureSpace(doc, y, 30);
    doc.save().moveTo(M.left, y).lineTo(M.left + CONTENT_WIDTH, y).lineWidth(0.8).stroke(C.divider).restore();
    y += 7;
    doc.font('Helvetica-Bold').fontSize(8.6).fillColor(C.ink)
      .text(String(total.label || 'Total'), M.left + CONTENT_WIDTH - 260, y, { width: 130, align: 'right', ellipsis: true, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(8.6).fillColor(tone === 'red' ? C.red : C.ink)
      .text(rupees(total.amount), M.left + CONTENT_WIDTH - 130, y, { width: 125, align: 'right' });
    y += 24;
  }

  return y + 8;
};

// ── the net settlement strip ───────────────────────────────────────────────

const drawNetStrip = (doc, { label = '', amount = 0, startY, tone = 'green' } = {}) => {
  let y = ensureSpace(doc, startY, 54);
  const background = tone === 'red' ? C.redBg : C.greenBg;
  const colour = tone === 'red' ? C.red : C.green;

  doc.save().roundedRect(M.left, y, CONTENT_WIDTH, 44, 8).fill(background).restore();
  doc.save().roundedRect(M.left, y, 4, 44, 2).fill(colour).restore();

  // A negative settlement is not a rounding error: the employee owes the
  // company (a notice buyout larger than the dues). Say so on the document
  // instead of printing a minus sign and leaving HR to explain it.
  const caption = Number(amount) < 0
    ? `${String(label || 'Net Settlement').replace(/\s*\(.*\)$/, '')} (amount recoverable from the employee)`
    : String(label || 'Net Settlement');
  doc.font('Helvetica').fontSize(7).fillColor(C.label)
    .text(caption, M.left + 16, y + 10, { width: CONTENT_WIDTH - 32, ellipsis: true, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(17).fillColor(colour)
    .text(rupees(amount), M.left + 16, y + 21, { width: CONTENT_WIDTH - 32, ellipsis: true, lineBreak: false });

  return y + 56;
};

// ── approval information (§16 / §17) ───────────────────────────────────────

const drawApprovals = (doc, { approval = {}, payment = {}, startY } = {}) => {
  const rows = [
    ['HR Reviewed By', approval?.hrReviewedByName || '—', 'HR Reviewed On', formatDate(approval?.hrReviewedAt)],
    ['Finance Approved By', approval?.financeByName || '—', 'Finance Approved On', formatDate(approval?.financeAt)],
    ['Payment Date', formatDate(payment?.paidAt || ''), 'Payment Reference', payment?.reference || '—'],
    ['Payment Mode', payment?.method || 'Bank Transfer', 'Paid By', payment?.paidByName || '—'],
  ];
  return drawDetailGrid(doc, { title: 'Approval Information', rows, startY });
};

// ── footer ─────────────────────────────────────────────────────────────────

const drawFooter = (doc, { generatedBy = '', settlement = {} } = {}) => {
  // 745pt keeps the footer inside the 44pt page margin; at 762 PDFKit pushed
  // the approval block onto a second page for no reason.
  const y = 745;
  doc.save().moveTo(M.left, y - 10).lineTo(M.left + CONTENT_WIDTH, y - 10).lineWidth(0.6).stroke(C.divider).restore();
  doc.font('Helvetica').fontSize(6.6).fillColor(C.label)
    .text(
      `Prepared by Crewly HRMS on ${formatDate(new Date().toISOString().slice(0, 10))}${
        generatedBy ? ` by ${generatedBy}` : ''
      }. Computer generated statement — not a legal document and not a signature-bearing instrument.`,
      M.left,
      y,
      { width: CONTENT_WIDTH, align: 'left' },
    );
  doc.font('Helvetica').fontSize(6.6).fillColor(C.label)
    .text(settlement?.settlementNumber || '', M.left, y, { width: CONTENT_WIDTH, align: 'right' });
};

/**
 * §17 — the F&F statement.
 *
 * `settlement` is the stored document (already calculated), so the PDF shows
 * exactly what HR reviewed and Finance approved — never a fresh calculation.
 */
export const buildFnfStatementPdf = ({ company = {}, employee = {}, settlement = {}, generatedBy = '', logo = null } = {}) =>
  new Promise((resolve, reject) => {
    try {
      const chunks = [];
      const doc = new PDFDocument({
        size: 'A4',
        margin: M.top,
        info: {
          Title: `Full & Final Settlement — ${settlement?.settlementNumber || ''}`,
          Author: company?.name || 'Crewly HRMS',
          Subject: `F&F statement ${settlement?.settlementNumber || ''} — ${employee?.name || ''}`,
        },
      });
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const exit = settlement?.exit || {};
      const earnings = settlement?.earnings || {};
      const recoveries = settlement?.recoveries || {};
      const totals = settlement?.totals || {};

      let y = drawHeader(doc, { company, settlement, logo });

      // §17 — employee details.
      y = drawDetailGrid(doc, {
        title: 'Employee Details',
        rows: [
          ['Employee Name', employee?.name || exit?.employeeName || '', 'Employee ID', employee?.employeeCode || ''],
          ['Department', employee?.departmentName || employee?.department || '', 'Designation', employee?.designation || ''],
        ],
        startY: y,
      });

      // §17 — exit details. Every field comes from the Exit module (§6).
      y = drawDetailGrid(doc, {
        title: 'Exit Details',
        rows: [
          ['Date of Joining', formatDate(exit?.joiningDate), 'Resignation Date', formatDate(exit?.resignationDate)],
          ['Last Working Day', formatDate(exit?.lastWorkingDate), 'Notice Period (days)', exit?.noticePeriodDays ?? ''],
          [
            'Notice Decision',
            NOTICE_DECISION_LABELS[exit?.noticeDecision] || 'Completed Notice',
            'Notice Served (days)',
            exit?.servedDays ?? '',
          ],
        ],
        startY: y,
      });

      // §11 — earnings. The calculation is shown, not just the total, so the
      // employee can see how the number was reached (§7 / §8 ask for exactly
      // this transparency).
      const earningRows = [];
      const pending = earnings?.pendingSalary || {};
      earningRows.push({
        label: 'Pending Salary',
        detail: `${pending?.payableDays ?? 0} payable day(s) x ${rupees(pending?.dailyRate || 0)} (of ${pending?.workingDays ?? 0} working days${Number(pending?.lopDays) > 0 ? `, ${pending.lopDays} loss of pay` : ''})`,
        amount: pending?.amount || 0,
      });

      const leaveEncashment = earnings?.leaveEncashment || {};
      if ((leaveEncashment?.amount || 0) > 0) {
        earningRows.push({
          label: `Leave Encashment (${leaveEncashment.leaveType || 'EARNED'})`,
          detail: `${leaveEncashment.encashedDays ?? 0} day(s) x ${rupees(leaveEncashment.dailyRate || 0)}${
            leaveEncashment.capped ? ` (capped at ${leaveEncashment.maxDays} days)` : ''
          }`,
          amount: leaveEncashment.amount,
        });
      }

      const gratuity = earnings?.gratuity || {};
      if ((gratuity?.amount || 0) > 0) {
        earningRows.push({
          label: `Gratuity (${gratuity.creditedYears ?? 0} year(s))`,
          detail: gratuity.reason || '',
          amount: gratuity.amount,
        });
      }

      (earnings?.additional || [])
        .filter((item) => item?.source !== 'SYSTEM')
        .forEach((item) => {
          earningRows.push({
            label: item?.label || 'Additional Payable',
            detail: item?.note || '',
            amount: item?.amount || 0,
          });
        });

      y = drawAmountTable(doc, {
        title: 'Earnings',
        note: 'Salary due up to the last working day, plus every additional payable',
        rows: earningRows,
        total: { label: 'Total Earnings', amount: totals?.totalEarnings || 0 },
        startY: y,
      });

      // §9 — recoveries, listed separately from salary deductions.
      const recoveryRows = [];
      const notice = recoveries?.notice || {};
      if ((notice?.amount || 0) > 0) {
        recoveryRows.push({
          label: `Notice Recovery (${NOTICE_DECISION_LABELS[notice.decision] || 'Notice'})`,
          detail: `${notice.shortfallDays ?? 0} shortfall day(s) x ${rupees(notice.dailyRate || 0)} — required ${notice.noticePeriodDays ?? 0}, served ${notice.servedDays ?? 0}`,
          amount: notice.amount,
        });
      } else if (notice?.waived) {
        recoveryRows.push({
          label: 'Notice Recovery — waived',
          detail: `${notice.shortfallDays ?? 0} shortfall day(s) waived by the company`,
          amount: 0,
        });
      }

      (recoveries?.items || []).forEach((item) => {
        recoveryRows.push({
          label: item?.label || 'Recovery',
          // §9 — every recovery carries its reason and its approver.
          detail: [item?.reason, item?.approvedByName ? `approved by ${item.approvedByName}` : '']
            .filter(Boolean)
            .join(' — '),
          amount: item?.amount || 0,
        });
      });

      y = drawAmountTable(doc, {
        title: 'Recoveries',
        note: 'Amounts recoverable from the employee, shown separately from salary deductions',
        rows: recoveryRows,
        total: { label: 'Total Recoveries', amount: totals?.totalRecoveries || 0 },
        startY: y,
        tone: 'red',
      });

      // §11 — the Full & Final amount.
      y = drawNetStrip(doc, {
        label: 'Net Settlement (Full & Final Amount)',
        amount: totals?.netSettlement || 0,
        startY: y,
        tone: (totals?.netSettlement || 0) < 0 ? 'red' : 'green',
      });

      // §16 / §17 — who approved and when it was paid.
      y = drawApprovals(doc, {
        approval: settlement?.approval || {},
        payment: settlement?.payment || {},
        startY: y,
      });

      drawFooter(doc, { generatedBy, settlement });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });

export default { buildFnfStatementPdf };
