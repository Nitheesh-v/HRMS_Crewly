// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.10 — STATUTORY REPORT PDF (§15 / §16)
//
//  The PDF half of "Excel / CSV / PDF". It draws and nothing else: the rows
//  and totals arrive already built by statutoryRules, so this file holds no
//  statutory logic at all and cannot disagree with the CSV it sits beside.
//
//  Same design language as utils/payslipPdf.js (palette, Indian digit
//  grouping, the diamond marker) so a PF register and a payslip look like
//  they came from the same product — because they did.
//
//  §26 — the footer says what this is: a return PREPARED by Crewly. It is
//  not a filed government document, and it carries no signature line for
//  anyone to mistake for one.
// ═══════════════════════════════════════════════════════════════════════════
import PDFDocument from 'pdfkit';

const C = {
  ink: '#111827',
  navy: '#16324f',
  label: '#8a94a6',
  subtle: '#5b6472',
  divider: '#d7dce5',
  band: '#f7f9fc',
  accent: '#16324f',
};

const PAGE_WIDTH = 595.28; // A4 points — landscape is NOT used: these are
const M = { left: 40, top: 44, right: 40 }; // registers, printed and filed.
const CONTENT_WIDTH = PAGE_WIDTH - M.left - M.right;

// Indian digit grouping → 45833 = "45,833" | 1234567 = "12,34,567"
const group = (digits) => {
  if (digits.length <= 3) return digits;
  const tail = digits.slice(-3);
  let head = digits.slice(0, -3);
  const parts = [];
  while (head.length > 2) { parts.unshift(head.slice(-2)); head = head.slice(0, -2); }
  if (head) parts.unshift(head);
  return `${parts.join(',')},${tail}`;
};

/**
 * Paise are printed when they exist and omitted when they do not.
 *
 * This matters: an employer PF split of 550.50 must not be rounded to 551 on
 * a return that finance reconciles to the rupee, while a round 1,800 must
 * not read as "1,800.00" on every single line.
 */
const inr = (n) => {
  const value = Number(n) || 0;
  const neg = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  const paise = Math.round(absolute * 100) % 100;
  const whole = Math.floor(absolute + 1e-9);
  const grouped = group(String(whole));
  return paise ? `${neg}${grouped}.${String(paise).padStart(2, '0')}` : `${neg}${grouped}`;
};

const rupees = (value) => `Rs ${inr(value)}`;

const fmtDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${date.getUTCFullYear()}`;
};

const diamond = (doc, cx, cy, r, color) =>
  doc.save().moveTo(cx, cy - r).lineTo(cx + r, cy).lineTo(cx, cy + r).lineTo(cx - r, cy)
    .closePath().fill(color).restore();

const initialsOf = (name) =>
  String(name || 'C')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();

const ensureSpace = (doc, y, needed) => {
  if (y + needed <= 780) return y;
  doc.addPage();
  return M.top;
};

// ── header: company + the statutory identifiers a return is filed under ─────

const drawHeader = (doc, { company = {}, setup = {}, title = '', periodLabel = '', logo = null } = {}) => {
  const legal = setup.legal || {};
  const statutory = setup.statutory || {};
  const badgeX = M.left;
  const badgeY = M.top;

  if (logo?.content && logo?.kind) {
    try {
      const image = Buffer.isBuffer(logo.content) ? logo.content : Buffer.from(String(logo.content), 'base64');
      doc.save().roundedRect(badgeX, badgeY, 40, 40, 6).clip().image(image, badgeX, badgeY, {
        fit: [40, 40], align: 'center', valign: 'center',
      }).restore();
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
    .text(String(company.name || 'Company'), x, badgeY + 2, { width: 260, ellipsis: true, lineBreak: false });
  doc.font('Helvetica').fontSize(7.4).fillColor(C.subtle)
    .text(String(company.address || ''), x, badgeY + 19, { width: 260, height: 20, ellipsis: true });

  // The identifiers that make a return filable, straight from 29.1.
  const ids = [
    legal.pan ? `PAN ${legal.pan}` : '',
    legal.tan ? `TAN ${legal.tan}` : '',
    statutory.pf?.applicable && statutory.pf?.establishmentNumber
      ? `PF ${statutory.pf.establishmentNumber}` : '',
    statutory.esi?.applicable && statutory.esi?.registrationNumber
      ? `ESI ${statutory.esi.registrationNumber}` : '',
  ].filter(Boolean).join('  ·  ');
  if (ids) {
    doc.font('Helvetica').fontSize(6.8).fillColor(C.label)
      .text(ids, x, badgeY + 31, { width: 300, ellipsis: true, lineBreak: false });
  }

  doc.font('Helvetica-Bold').fontSize(12).fillColor(C.navy)
    .text(String(title || 'Statutory Report'), M.left, badgeY + 2, { width: CONTENT_WIDTH, align: 'right' });
  doc.font('Helvetica').fontSize(8).fillColor(C.subtle)
    .text(String(periodLabel || ''), M.left, badgeY + 19, { width: CONTENT_WIDTH, align: 'right' });

  const y = badgeY + 50;
  doc.save().moveTo(M.left, y).lineTo(M.left + CONTENT_WIDTH, y).lineWidth(1).stroke(C.divider).restore();
  return y + 16;
};

// ── KPI strip ──────────────────────────────────────────────────────────────

const drawKpis = (doc, { kpis = [], startY }) => {
  const list = (kpis || []).filter(Boolean).slice(0, 8);
  if (!list.length) return startY;

  const perRow = Math.min(4, list.length);
  const width = CONTENT_WIDTH / perRow;
  let y = startY;

  for (let index = 0; index < list.length; index += perRow) {
    const slice = list.slice(index, index + perRow);
    const height = 34;
    doc.save().rect(M.left, y, CONTENT_WIDTH, height).fill(C.band).restore();
    slice.forEach((kpi, column) => {
      const x = M.left + column * width;
      doc.font('Helvetica').fontSize(6.6).fillColor(C.label)
        .text(String(kpi.label || ''), x + 8, y + 7, { width: width - 16, ellipsis: true, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(C.ink)
        .text(String(kpi.value || ''), x + 8, y + 17, { width: width - 16, ellipsis: true, lineBreak: false });
    });
    y += height + 4;
  }
  return y + 10;
};

// ── a titled section with an optional note ─────────────────────────────────

const drawSectionTitle = (doc, { title = '', note = '', startY }) => {
  let y = ensureSpace(doc, startY, 46);
  diamond(doc, M.left + 2.6, y + 3.6, 2.6, C.accent);
  doc.font('Helvetica-Bold').fontSize(9.6).fillColor(C.ink).text(String(title || ''), M.left + 12, y);
  if (note) {
    doc.font('Helvetica').fontSize(6.8).fillColor(C.label).text(String(note), M.left + 12, y + 12);
  }
  return y + 30;
};

// ── the table ──────────────────────────────────────────────────────────────

const drawTable = (doc, { headers = [], rows = [], totals = [], startY, numericFrom = 2 }) => {
  const columns = headers || [];
  const columnCount = columns.length;
  if (!columnCount) return startY;

  // Amount columns are right-aligned; the identifying columns are wider so
  // a 12-digit UAN or a 17-digit ESI number never wraps onto a second line.
  const weights = columns.map((header) => {
    const key = String(header || '').toLowerCase();
    if (/name|department|state|section|particulars|month/.test(key)) return 2.2;
    if (/uan|esi number/.test(key)) return 1.9;
    if (/pan/.test(key)) return 1.5;
    if (/code/.test(key)) return 1.3; // "Employee Code" must not wrap
    if (/regime|employees|months/.test(key)) return 1.05;
    return 1.4;
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const widths = weights.map((weight) => (weight / totalWeight) * CONTENT_WIDTH);
  const xOf = (index) => widths.slice(0, index).reduce((sum, width) => sum + width, M.left);

  const cellText = (value, index, options = {}) => {
    const isNumeric = typeof value === 'number' || (value !== '' && Number.isFinite(Number(value)) && index >= numericFrom);
    doc.font(options.bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(options.bold ? 7.8 : 7.4)
      .fillColor(options.color || (options.bold ? C.ink : C.subtle))
      .text(
        typeof value === 'number' ? rupees(value) : String(value ?? ''),
        xOf(index) + 4,
        options.y,
        {
          width: widths[index] - 8,
          align: isNumeric ? 'right' : 'left',
          ellipsis: true,
          lineBreak: false,
        },
      );
  };

  let y = ensureSpace(doc, startY, 40);

  // Header row
  doc.save().rect(M.left, y - 3, CONTENT_WIDTH, 15).fill(C.navy).restore();
  columns.forEach((header, index) => {
    doc.font('Helvetica-Bold').fontSize(7).fillColor('#ffffff')
      .text(String(header || ''), xOf(index) + 4, y + 1, {
        width: widths[index] - 8,
        align: index >= numericFrom ? 'right' : 'left',
        ellipsis: true,
        lineBreak: false,
      });
  });
  y += 18;

  const body = rows || [];
  if (!body.length) {
    doc.font('Helvetica').fontSize(7.6).fillColor(C.label)
      .text('No records for this period.', M.left + 4, y + 2);
    y += 20;
  }

  body.forEach((row, rowIndex) => {
    y = ensureSpace(doc, y, 18);
    if (rowIndex % 2 === 0) {
      doc.save().rect(M.left, y - 2, CONTENT_WIDTH, 14).fill(C.band).restore();
    }
    (row || []).slice(0, columnCount).forEach((value, index) => {
      cellText(value, index, { y: y + 2 });
    });
    y += 15;
  });

  const totalsRow = totals || [];
  if (totalsRow.length) {
    y = ensureSpace(doc, y, 26);
    doc.save().moveTo(M.left, y).lineTo(M.left + CONTENT_WIDTH, y).lineWidth(0.8).stroke(C.divider).restore();
    y += 5;
    totalsRow.slice(0, columnCount).forEach((value, index) => {
      cellText(value, index, { y, bold: true, color: C.ink });
    });
    y += 20;
  }

  return y + 12;
};

// ── footer ─────────────────────────────────────────────────────────────────

const drawFooter = (doc, { meta = {} } = {}) => {
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    const y = 792;
    doc.save().moveTo(M.left, y - 12).lineTo(M.left + CONTENT_WIDTH, y - 12)
      .lineWidth(0.7).stroke(C.divider).restore();

    doc.font('Helvetica').fontSize(6.4).fillColor(C.label)
      .text(
        'Prepared by Crewly HRMS from the payroll snapshot. This document is not a filed ' +
          'government return and requires no signature.',
        M.left,
        y - 6,
        { width: CONTENT_WIDTH - 90, height: 18 },
      );
    doc.font('Helvetica').fontSize(6.4).fillColor(C.label)
      .text(`Page ${index - range.start + 1} of ${range.count}`, M.left, y - 6, {
        width: CONTENT_WIDTH, align: 'right',
      });

    if (meta.status) {
      doc.font('Helvetica-Bold').fontSize(7).fillColor(C.ink)
        .text(`Status: ${meta.status}${meta.generatedAt ? `  ·  Generated ${fmtDate(meta.generatedAt)}` : ''}`,
          M.left, y + 6, { width: CONTENT_WIDTH, align: 'right' });
    }
  }
};

/**
 * Render one statutory report to a PDF buffer.
 *
 * @returns {Promise<Buffer>}
 */
export const buildStatutoryPdf = ({
  company = {},
  setup = {},
  title = '',
  periodLabel = '',
  headers = [],
  rows = [],
  totals = [],
  kpis = [],
  note = '',
  meta = {},
  logo = null,
} = {}) =>
  new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: M.top,
        bufferPages: true,
        info: { Title: String(title || 'Statutory Report'), Author: String(company.name || 'Crewly HRMS') },
      });

      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      let y = drawHeader(doc, { company, setup, title, periodLabel, logo });
      y = drawKpis(doc, { kpis, startY: y });
      y = drawSectionTitle(doc, { title: title || 'Statutory Report', note, startY: y });
      drawTable(doc, { headers, rows, totals, startY: y });
      drawFooter(doc, { meta });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });

export default { buildStatutoryPdf };
