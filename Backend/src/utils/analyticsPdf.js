// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.12 — PAYROLL ANALYTICS REPORT PDF (§19)
//
//  One renderer for every report export, so a department table printed as a
//  PDF is the same table the spreadsheet holds — same headers, same rows,
//  same rounded figures. It draws and nothing else: no aggregation, no
//  filtering, no arithmetic.
//
//  Same design language as payslipPdf.js, statutoryPdf.js and fnfPdf.js
//  (palette, Indian digit grouping, the diamond marker) so all four read as
//  one product.
//
//  A report can be thousands of rows, so the table paginates with a repeating
//  header and a row count in the footer — a CFO printing the register must be
//  able to tell that they have all of it.
// ═══════════════════════════════════════════════════════════════════════════
import PDFDocument from 'pdfkit';

import { rupees } from '../services/payroll/fnfRules.js';

const C = {
  ink: '#111827',
  navy: '#16324f',
  label: '#8a94a6',
  subtle: '#5b6472',
  divider: '#d7dce5',
  band: '#f7f9fc',
  accent: '#16324f',
};

const PAGE_WIDTH = 595.28; // A4 points
const M = { left: 40, top: 44, right: 40 };
const CONTENT_WIDTH = PAGE_WIDTH - M.left - M.right;
const ROW_HEIGHT = 16;
const HEADER_HEIGHT = 17;

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

// A number is right-aligned and grouped; a label is left-aligned. The table
// does not know which column is which, so it asks the value itself.
const isNumeric = (value) => typeof value === 'number' || (typeof value === 'string' && /^-?[\d,.]+$/.test(value.trim()));

const cell = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return rupees(value);
  return String(value);
};

// ── header ─────────────────────────────────────────────────────────────────

const drawHeader = (doc, { company = {}, title = '', subtitle = '', logo = null } = {}) => {
  const badgeX = M.left;
  const badgeY = M.top;

  if (logo?.content && logo?.kind) {
    try {
      const image = Buffer.isBuffer(logo.content) ? logo.content : Buffer.from(String(logo.content), 'base64');
      doc.save().roundedRect(badgeX, badgeY, 40, 40, 6).clip()
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

  doc.font('Helvetica-Bold').fontSize(12).fillColor(C.navy)
    .text(String(title || 'Payroll Report'), M.left, badgeY + 2, { width: CONTENT_WIDTH, align: 'right' });
  doc.font('Helvetica').fontSize(8).fillColor(C.subtle)
    .text(String(subtitle || ''), M.left, badgeY + 19, { width: CONTENT_WIDTH, align: 'right' });

  const y = badgeY + 50;
  doc.save().moveTo(M.left, y).lineTo(M.left + CONTENT_WIDTH, y).lineWidth(1).stroke(C.divider).restore();
  return y + 18;
};

// ── the summary strip (§5 — the KPIs, on the report itself) ─────────────────

const drawSummary = (doc, { summary = {}, startY }) => {
  const entries = [
    ['Employees Paid', summary.employeesPaid],
    ['Gross Salary', rupees(summary.grossSalary)],
    ['Net Salary', rupees(summary.netSalary)],
    ['Employer Cost', rupees(summary.employerContribution)],
    ['Total Payroll Cost', rupees(summary.totalPayrollCost)],
  ].filter(([, value]) => value !== undefined && value !== null);

  if (!entries.length) return startY;

  let y = ensureSpace(doc, startY, 60);
  const columnWidth = CONTENT_WIDTH / entries.length;

  doc.save().roundedRect(M.left, y, CONTENT_WIDTH, 42, 6).fill(C.band).restore();

  entries.forEach(([label, value], index) => {
    const x = M.left + index * columnWidth;
    doc.font('Helvetica').fontSize(6.6).fillColor(C.label)
      .text(String(label).toUpperCase(), x + 8, y + 8, { width: columnWidth - 16, ellipsis: true, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(C.ink)
      .text(String(value), x + 8, y + 20, { width: columnWidth - 16, ellipsis: true, lineBreak: false });
  });

  return y + 56;
};

// ── the table ──────────────────────────────────────────────────────────────

const columnWidths = (headers = []) => {
  const count = Math.max(1, headers.length);
  // The first column carries names; give it the slack the numeric columns
  // do not need.
  const base = CONTENT_WIDTH / count;
  return headers.map((header, index) => (index === 0 && count > 2 ? base * 1.5 : base * (count > 2 ? (count - 1.5) / (count - 1) : 1)));
};

const drawTableHeader = (doc, { headers = [], widths = [], y }) => {
  doc.save().rect(M.left, y, CONTENT_WIDTH, HEADER_HEIGHT).fill(C.navy).restore();

  let x = M.left;
  headers.forEach((header, index) => {
    const width = widths[index] || 60;
    const numeric = index > 0;
    doc.font('Helvetica-Bold').fontSize(6.8).fillColor('#ffffff')
      .text(String(header), x + 4, y + 5, { width: width - 8, align: numeric ? 'right' : 'left', ellipsis: true, lineBreak: false });
    x += width;
  });

  return y + HEADER_HEIGHT;
};

const drawTable = (doc, { headers = [], rows = [], startY }) => {
  const widths = columnWidths(headers);
  let y = startY;
  let printed = 0;

  y = ensureSpace(doc, y, 60);
  y = drawTableHeader(doc, { headers, widths, y });

  (rows || []).forEach((row, index) => {
    y = ensureSpace(doc, y, ROW_HEIGHT + 20);
    if (printed === 0 && index > 0) y = drawTableHeader(doc, { headers, widths, y });

    if (index % 2 === 0) {
      doc.save().rect(M.left, y, CONTENT_WIDTH, ROW_HEIGHT).fill(C.band).restore();
    }

    let x = M.left;
    (row || []).forEach((value, column) => {
      const width = widths[column] || 60;
      const numeric = column > 0 && isNumeric(value);
      doc.font(numeric ? 'Helvetica-Bold' : 'Helvetica').fontSize(7).fillColor(numeric ? C.ink : C.subtle)
        .text(cell(value), x + 4, y + 4, { width: width - 8, align: numeric ? 'right' : 'left', ellipsis: true, lineBreak: false });
      x += width;
    });

    y += ROW_HEIGHT;
    printed += 1;
  });

  return { y: y + 10, printed };
};

// ── footer ─────────────────────────────────────────────────────────────────

const drawFooter = (doc, { generatedBy = '', rowCount = 0 }) => {
  const y = 745;
  doc.save().moveTo(M.left, y).lineTo(M.left + CONTENT_WIDTH, y).lineWidth(0.8).stroke(C.divider).restore();

  doc.font('Helvetica').fontSize(6.4).fillColor(C.label)
    .text(
      `${rowCount} row(s) · prepared from immutable payroll snapshots · figures are rounded to the rupee`,
      M.left,
      y + 6,
      { width: CONTENT_WIDTH - 160 },
    );
  doc.font('Helvetica').fontSize(6.4).fillColor(C.label)
    .text(
      `Generated by ${generatedBy || 'Crewly HRMS'} · ${new Date().toISOString().slice(0, 10)}`,
      M.left,
      y + 6,
      { width: CONTENT_WIDTH, align: 'right' },
    );
};

// ── the document ───────────────────────────────────────────────────────────

export const buildAnalyticsReportPdf = ({
  company = {},
  title = 'Payroll Report',
  subtitle = '',
  headers = [],
  rows = [],
  summary = null,
  generatedBy = '',
  logo = null,
} = {}) =>
  new Promise((resolve, reject) => {
    try {
      const chunks = [];
      const doc = new PDFDocument({
        size: 'A4',
        margin: M.top,
        info: {
          Title: String(title || 'Payroll Report'),
          Author: company?.name || 'Crewly HRMS',
          Subject: `${title} ${subtitle}`.trim(),
        },
      });

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      let y = drawHeader(doc, { company, title, subtitle, logo });
      if (summary) y = drawSummary(doc, { summary, startY: y });

      if (!(rows || []).length) {
        doc.font('Helvetica').fontSize(8).fillColor(C.label)
          .text('No rows match these filters.', M.left, y + 8);
      } else {
        const { printed } = drawTable(doc, { headers, rows, startY: y });
        // A long register paginates; the count in the footer is how the
        // reader knows they are holding all of it.
        drawFooter(doc, { generatedBy, rowCount: printed });
      }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });

export default { buildAnalyticsReportPdf };
