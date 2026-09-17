// ─────────────────────────────────────────────────────────────
// Payslip template registry (Company Branding & Document Branding).
//
// Backend-controlled templates ONLY: tenants select a templateId, they
// never supply markup, styles or code. Every template renders the SAME
// frozen snapshot — branding changes presentation, never a single rupee.
// ─────────────────────────────────────────────────────────────
import PDFDocument from 'pdfkit';

import { M, CONTENT_WIDTH, initialsOf, rupees, ensureSpace, fmtDate } from './payslipPdf.js';
import {
  PAYSLIP_TEMPLATE,
  sanitizeLogoLayout,
  sanitizePayslipTemplateId,
} from '../services/companyBrandingRules.js';

export { PAYSLIP_TEMPLATE };

// ── Shared logo placement ─────────────────────────────────────
// Alignment positions the LOGO box within the full content width; the
// company-name block stays left-anchored and the payslip-title block
// stays right-anchored in every template (documented behavior).
export const logoBoxX = (alignment, boxWidth, contentLeft, contentWidth) => {
  if (alignment === 'CENTER') return contentLeft + (contentWidth - boxWidth) / 2;
  if (alignment === 'RIGHT') return contentLeft + contentWidth - boxWidth;
  return contentLeft;
};

// Draws a logo buffer into a w×h box, aspect-preserved. CONTAIN fits the
// whole mark inside (default, never crops); COVER fills the box and may
// crop edges. Never distorts. Returns false (→ initials badge) on any
// failure — a logo never breaks a payslip.
export const drawCompanyLogo = (doc, buffer, x, y, w, h, fit = 'CONTAIN') => {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return false;
  try {
    if (fit === 'COVER') {
      const image = doc.openImage(buffer);
      const iw = image?.width || 1;
      const ih = image?.height || 1;
      const scale = Math.max(w / iw, h / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      doc.save();
      doc.rect(x, y, w, h).clip();
      doc.image(buffer, x - (dw - w) / 2, y - (dh - h) / 2, { width: dw, height: dh });
      doc.restore();
      return true;
    }
    doc.image(buffer, x, y, { fit: [w, h], align: 'center', valign: 'center' });
    return true;
  } catch {
    return false;
  }
};

// Preview-only: diagonal SAMPLE mark + the header banner (drawn by each
// template) make it unmistakable that this is not a real payslip.
export const drawPreviewWatermark = (doc) => {
  try {
    const { width, height } = doc.page;
    doc.save();
    doc.rotate(-30, { origin: [width / 2, height / 2] });
    doc.font('Helvetica-Bold').fillColor('#e5484d').opacity(0.08);
    doc.fontSize(72).text('SAMPLE', 0, height / 2 - 70, { width, align: 'center' });
    doc.fontSize(26).text('PREVIEW ONLY', 0, height / 2 + 10, { width, align: 'center' });
    doc.restore();
    doc.opacity(1);
  } catch {
    // A watermark never breaks a render.
  }
};

// ── Sample snapshot (preview only — clearly fake, never a real salary) ──
export const buildSamplePayslipSnapshot = ({
  companyName = '',
  address = {},
  logoUrl = '',
  brandingSnapshot = {},
} = {}) => {
  const addressLine =
    typeof address === 'string'
      ? address
      : [address?.line, address?.city, address?.state, address?.pincode]
          .filter(Boolean)
          .join(', ');
  return {
    company: {
      name: companyName || 'Sample Company',
      address: addressLine,
      pan: 'ABCDE1234F',
      tan: 'ABCD12345E',
      logoUrl: logoUrl || '',
      brandingSnapshot,
    },
    employee: {
      employeeId: 'sample',
      employeeCode: 'SAMPLE001',
      name: 'Sample Employee',
      department: 'Sample Department',
      designation: 'Sample Role',
      joiningDate: '2024-04-01',
      bankName: 'Sample Bank',
      accountNumberMasked: 'XXXX-0000',
      uan: '000000000000',
      pan: 'ABCDE0000A',
    },
    payroll: {
      month: '2026-09',
      monthLabel: 'September 2026',
      cycle: 'MONTHLY',
      paymentDate: null,
      payslipNumber: 'SAMPLE-0000',
    },
    salary: {
      grossSalary: 100000,
      totalEarnings: 100000,
      totalReimbursements: 0,
      totalDeductions: 12400,
      netSalary: 87600,
      totalEmployerContributions: 11800,
    },
    earnings: [
      { name: 'Basic Salary', amount: 60000 },
      { name: 'House Rent Allowance', amount: 24000 },
      { name: 'Special Allowance', amount: 16000 },
    ],
    variableEarnings: [],
    reimbursements: [],
    deductions: [
      { name: 'Provident Fund', amount: 7200 },
      { name: 'Professional Tax', amount: 200 },
      { name: 'TDS', amount: 5000 },
    ],
    employerContributions: [
      { name: 'Employer PF', amount: 7200 },
      { name: 'Employer ESI', amount: 4600 },
    ],
    attendance: {
      workingDays: 26,
      presentDays: 26,
      paidDays: 26,
      lopDays: 0,
      overtimeHours: 0,
    },
    payment: { method: 'Bank Transfer' },
    generatedAt: new Date().toISOString(),
  };
};

// ── MINIMAL template ──────────────────────────────────────────
// Printer-friendly: grayscale, hairlines instead of fills, no badges or
// zebra rows, high contrast. Reads the EXACT same snapshot fields as
// CLASSIC — the values are identical by construction.
const GRAY = { ink: '#111111', body: '#333333', label: '#777777', rule: '#999999' };

const minimalMoneyTable = (doc, { title, rows, totalLabel, total, startY }) => {
  let y = ensureSpace(doc, startY, 60 + (rows.length || 1) * 15);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAY.ink).text(title.toUpperCase(), M.left, y);
  y += 13;
  doc.save().moveTo(M.left, y).lineTo(M.left + CONTENT_WIDTH, y).lineWidth(0.8).stroke(GRAY.rule).restore();
  y += 7;
  if (!rows.length) {
    doc.font('Helvetica').fontSize(8).fillColor(GRAY.label).text('None recorded', M.left, y);
    y += 15;
  }
  rows.forEach((row) => {
    y = ensureSpace(doc, y, 18);
    doc.font('Helvetica').fontSize(8.4).fillColor(GRAY.body).text(String(row.name || ''), M.left, y);
    doc
      .font('Helvetica')
      .fontSize(8.4)
      .fillColor(GRAY.ink)
      .text(rupees(row.amount), M.left, y, { width: CONTENT_WIDTH, align: 'right' });
    y += 15;
  });
  doc.save().moveTo(M.left, y).lineTo(M.left + CONTENT_WIDTH, y).lineWidth(0.5).stroke(GRAY.rule).restore();
  y += 6;
  doc.font('Helvetica-Bold').fontSize(8.6).fillColor(GRAY.ink).text(totalLabel, M.left, y);
  doc
    .font('Helvetica-Bold')
    .fontSize(8.6)
    .fillColor(GRAY.ink)
    .text(rupees(total), M.left, y, { width: CONTENT_WIDTH, align: 'right' });
  return y + 24;
};

export const renderMinimalPayslip = (snapshot = {}, options = {}) =>
  new Promise((resolve, reject) => {
    try {
      const company = snapshot.company || {};
      const employee = snapshot.employee || {};
      const payroll = snapshot.payroll || {};
      const salary = snapshot.salary || {};
      const attendance = snapshot.attendance || {};
      const payment = snapshot.payment || null;
      const layout = sanitizeLogoLayout(
        options?.layout || snapshot?.company?.brandingSnapshot?.layout
      );
      const preview = Boolean(options?.preview);

      const chunks = [];
      const doc = new PDFDocument({
        size: 'A4',
        margin: M.top,
        info: {
          Title: `Payslip ${payroll.monthLabel || payroll.month || ''} - ${employee.name || ''}`,
          Author: company.name || 'Crewly HRMS',
          Subject: `Payslip ${payroll.payslipNumber || ''}`,
        },
      });
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // ── 1. header ──
      doc.save().moveTo(M.left, M.top - 8).lineTo(M.left + CONTENT_WIDTH, M.top - 8).lineWidth(1.4).stroke(GRAY.ink).restore();
      const boxW = layout.width;
      const boxH = layout.maxHeight;
      const boxX = logoBoxX(layout.alignment, boxW, M.left, CONTENT_WIDTH);
      const logo =
        options?.logo && Buffer.isBuffer(options.logo.buffer) ? options.logo.buffer : null;
      const drawn =
        logo && logo.length ? drawCompanyLogo(doc, logo, boxX, M.top, boxW, boxH, layout.fit) : false;
      if (!drawn) {
        doc.save().rect(boxX, M.top, boxW, boxH).lineWidth(0.8).stroke(GRAY.ink).restore();
        doc
          .font('Helvetica-Bold')
          .fontSize(12)
          .fillColor(GRAY.ink)
          .text(initialsOf(company.name), boxX, M.top, {
            width: boxW,
            height: boxH,
            align: 'center',
            valign: 'center',
          });
      }

      doc.font('Helvetica-Bold').fontSize(13).fillColor(GRAY.ink).text(String(company.name || 'Company').toUpperCase(), M.left, M.top + boxH + 6, { width: CONTENT_WIDTH });
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(GRAY.body)
        .text(String(company.address || 'Address not set'), M.left, M.top + boxH + 24, { width: CONTENT_WIDTH });
      const taxLine = [company.pan ? `PAN: ${company.pan}` : '', company.tan ? `TAN: ${company.tan}` : '']
        .filter(Boolean)
        .join('   ');
      if (taxLine) {
        doc.font('Helvetica').fontSize(7.4).fillColor(GRAY.label).text(taxLine, M.left, M.top + boxH + 36, { width: CONTENT_WIDTH });
      }

      doc.font('Helvetica-Bold').fontSize(12).fillColor(GRAY.ink).text(`PAYSLIP — ${payroll.monthLabel || payroll.month || ''}`, M.left, M.top + boxH + 50, { width: CONTENT_WIDTH, align: 'right' });
      doc.font('Helvetica').fontSize(7.6).fillColor(GRAY.label).text(`No: ${payroll.payslipNumber || '—'}   ·   Cycle: ${String(payroll.cycle || 'MONTHLY')}`, M.left, M.top + boxH + 66, { width: CONTENT_WIDTH, align: 'right' });

      let y = M.top + boxH + 84;
      doc.save().moveTo(M.left, y).lineTo(M.left + CONTENT_WIDTH, y).lineWidth(0.6).stroke(GRAY.rule).restore();

      if (preview) {
        y += 10;
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#b42318').text('SAMPLE PREVIEW — NOT A REAL PAYSLIP', M.left, y, { width: CONTENT_WIDTH, align: 'center' });
        y += 6;
      }

      // ── 2. employee ──
      y += 14;
      const pairs = [
        ['Employee ID', employee.employeeCode || employee.employeeId],
        ['Name', employee.name],
        ['Department', employee.department],
        ['Designation', employee.designation],
        ['Date of Joining', fmtDate(employee.joiningDate)],
        ['UAN', employee.uan],
        ['PAN', employee.pan],
        ['Bank', employee.bankName],
        ['Account Number', employee.accountNumberMasked],
        ['Payment Mode', payment?.method || 'Bank Transfer'],
      ];
      const colW = CONTENT_WIDTH / 2;
      pairs.forEach(([label, value], index) => {
        const col = index % 2;
        if (col === 0) y = ensureSpace(doc, y, 16);
        const x = M.left + col * colW;
        doc.font('Helvetica-Bold').fontSize(7.6).fillColor(GRAY.label).text(`${label}: `, x, y, { continued: true });
        doc.font('Helvetica').fontSize(8).fillColor(GRAY.ink).text(String(value ?? '—'));
        if (col === 1) y += 14;
      });
      if (pairs.length % 2 === 1) y += 14;
      y += 6;
      doc.save().moveTo(M.left, y).lineTo(M.left + CONTENT_WIDTH, y).lineWidth(0.6).stroke(GRAY.rule).restore();
      y += 12;

      // ── 3. attendance (one line) ──
      doc
        .font('Helvetica')
        .fontSize(7.8)
        .fillColor(GRAY.body)
        .text(
          `Attendance — Working: ${attendance.workingDays ?? '—'}   Present: ${attendance.presentDays ?? '—'}   Paid: ${attendance.paidDays ?? '—'}   LOP: ${attendance.lopDays ?? '—'}   OT Hours: ${attendance.overtimeHours ?? '—'}`,
          M.left,
          y,
          { width: CONTENT_WIDTH }
        );
      y += 22;

      // ── 4–6. money tables (same fields as CLASSIC, same rupee values) ──
      y = minimalMoneyTable(doc, {
        title: 'Earnings',
        rows: [...(snapshot.earnings || []), ...(snapshot.variableEarnings || [])],
        totalLabel: 'Total Earnings',
        total: salary.totalEarnings,
        startY: y,
      });
      if ((snapshot.reimbursements || []).length) {
        y = minimalMoneyTable(doc, {
          title: 'Reimbursements',
          rows: snapshot.reimbursements || [],
          totalLabel: 'Total Reimbursements',
          total: salary.totalReimbursements,
          startY: y,
        });
      }
      y = minimalMoneyTable(doc, {
        title: 'Deductions',
        rows: snapshot.deductions || [],
        totalLabel: 'Total Deductions',
        total: salary.totalDeductions,
        startY: y,
      });
      y = minimalMoneyTable(doc, {
        title: 'Employer Contributions',
        rows: snapshot.employerContributions || [],
        totalLabel: 'Total Employer Contributions',
        total: salary.totalEmployerContributions,
        startY: y,
      });
      doc.font('Helvetica').fontSize(7.4).fillColor(GRAY.label).text('Paid by the employer on top of salary — these do not reduce Net Pay.', M.left, y, { width: CONTENT_WIDTH });
      y += 16;

      // ── 7. totals ──
      y = ensureSpace(doc, y, 90);
      doc.save().moveTo(M.left, y).lineTo(M.left + CONTENT_WIDTH, y).lineWidth(1).stroke(GRAY.ink).restore();
      y += 8;
      doc.font('Helvetica').fontSize(9).fillColor(GRAY.body).text('Gross Salary', M.left, y);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAY.ink).text(rupees(salary.grossSalary), M.left, y, { width: CONTENT_WIDTH, align: 'right' });
      y += 16;
      doc.font('Helvetica').fontSize(9).fillColor(GRAY.body).text('Less: Total Deductions', M.left, y);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAY.ink).text(`- ${rupees(salary.totalDeductions)}`, M.left, y, { width: CONTENT_WIDTH, align: 'right' });
      y += 18;
      doc.font('Helvetica-Bold').fontSize(12).fillColor(GRAY.ink).text('Net Pay', M.left, y);
      doc.font('Helvetica-Bold').fontSize(13).fillColor(GRAY.ink).text(rupees(salary.netSalary), M.left, y - 1, { width: CONTENT_WIDTH, align: 'right' });
      y += 22;

      // ── 8. footer ──
      const footerY = 792;
      doc.save().moveTo(M.left, footerY - 10).lineTo(M.left + CONTENT_WIDTH, footerY - 10).lineWidth(0.6).stroke(GRAY.rule).restore();
      doc
        .font('Helvetica')
        .fontSize(7)
        .fillColor(GRAY.label)
        .text(
          `Payslip ${payroll.payslipNumber || ''}   ·   Generated ${fmtDate(snapshot.generatedAt)}${preview ? '   ·   SAMPLE PREVIEW' : ''}`,
          M.left,
          footerY,
          { width: CONTENT_WIDTH, align: 'center' }
        );

      if (preview) drawPreviewWatermark(doc);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });

// Template-id resolver shared by the classic entry point: explicit option
// wins, then the snapshot capture (immutable history), then the default.
export const resolvePayslipTemplate = (snapshot = {}, options = {}) =>
  sanitizePayslipTemplateId(
    options?.templateId ?? snapshot?.company?.brandingSnapshot?.templateId
  );
