// ─────────────────────────────────────────────────────────────
// Payslip PDF generator (PDFKit)
// Layout mirrors the professional reference slip:
//   header (company badge + name/address | Payslip: Mon YYYY)
//   net pay strip  →  employee details column (left)
//   + Gross Pay / Deductions sections with accent brackets (right)
//   → compliance footer.
// This file only DRAWS — all data is prepared by the controller.
// ─────────────────────────────────────────────────────────────
import PDFDocument from 'pdfkit';

const C = {
  ink: '#111827',        // amounts / strong text
  navy: '#16324f',       // company name & badge
  label: '#8a94a6',      // small gray labels
  subtle: '#5b6472',     // table row labels
  green: '#12b76a',
  greenBg: '#eaf8f0',
  orange: '#f9700b',
  orangeBg: '#fdeee1',
  red: '#e5484d',
  divider: '#c7cff1',
  lineGreen: '#cfe7da',
  lineOrange: '#f2d9c3',
};

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Indian digit grouping → 45833 = "45,833" | 1234567 = "12,34,567"
const inr = (n) => {
  const neg = Number(n) < 0 ? '-' : '';
  let s = String(Math.round(Math.abs(Number(n) || 0)));
  if (s.length <= 3) return neg + s;
  const tail = s.slice(-3);
  let head = s.slice(0, -3);
  const parts = [];
  while (head.length > 2) { parts.unshift(head.slice(-2)); head = head.slice(0, -2); }
  if (head) parts.unshift(head);
  return neg + parts.join(',') + ',' + tail;
};

// dd/mm/yyyy (dates arrive as UTC-midnight Date objects)
const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return `${String(dt.getUTCDate()).padStart(2, '0')}/${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${dt.getUTCFullYear()}`;
};

const ROLE_LABEL = {
  COMPANY_ADMIN: 'Company Admin', HR_MANAGER: 'HR Manager', MANAGER: 'Manager',
  TEAM_LEAD: 'Team Lead', EMPLOYEE: 'Employee', SUPER_ADMIN: 'Super Admin',
};

// small rotated-square marker (the ♦ next to titles & bracket tips)
const diamond = (doc, cx, cy, r, color) =>
  doc.save().moveTo(cx, cy - r).lineTo(cx + r, cy).lineTo(cx, cy + r).lineTo(cx - r, cy)
    .closePath().fill(color).restore();

// accent bracket: short top hook → long vertical line → diamond tip
const bracket = (doc, x, yTop, yBottom, color) => {
  doc.save().lineWidth(1.6).lineCap('round')
    .moveTo(x + 18, yTop).lineTo(x + 5, yTop)
    .quadraticCurveTo(x, yTop, x, yTop + 5)
    .lineTo(x, yBottom)
    .stroke(color).restore();
  diamond(doc, x, yBottom + 7, 2.6, color);
};

// One tinted section (Gross Pay OR Deductions): bg + title + table + footer total
const moneySection = (doc, { top, title, sub, accent, diamondColor, bg, line, head, rows, footerLabel, footerTotal }) => {
  const X = 166.5, W = 385.3;
  const headerY = top + 26;
  const firstRow = headerY + 17;
  const rowH = 24.4;
  const bgTop = top - 4;
  const bgBottom = firstRow + rows.length * rowH + 6;

  doc.save().roundedRect(X, bgTop, W, bgBottom - bgTop, 8).fill(bg).restore();
  bracket(doc, X + 6, top + 3, bgBottom - 13, accent);

  // title + diamond + gray subtitle
  doc.font('Helvetica-Bold').fontSize(9).fillColor(C.ink).text(title, 201, top);
  const dx = 201 + doc.widthOfString(title) + 8;
  diamond(doc, dx, top + 3.6, 2.6, diamondColor);
  doc.font('Helvetica').fontSize(6.5).fillColor(C.label).text(sub, dx + 9, top + 1.6);

  // table header + hairline
  doc.font('Helvetica-Bold').fontSize(8).fillColor(C.ink);
  doc.text(head, 186, headerY);
  doc.text('Monthly', 350, headerY, { width: 75, align: 'right' });
  doc.text('Total Amount', 438, headerY, { width: 75, align: 'right' });
  doc.save().moveTo(186, headerY + 12).lineTo(513, headerY + 12).lineWidth(0.6).stroke(line).restore();

  // rows (alternate white pills, like the reference)
  rows.forEach(([label, amount], i) => {
    const y = firstRow + i * rowH;
    if (i % 2 === 0) doc.save().roundedRect(180, y - 2, 337.5, rowH - 3, 4).fill('#ffffff').restore();
    doc.font('Helvetica').fontSize(8.2).fillColor(C.subtle).text(label, 186, y + 4);
    doc.font('Helvetica').fontSize(8.2).fillColor(C.ink).text(inr(amount), 350, y + 4, { width: 75, align: 'right' });
    doc.text(inr(amount), 438, y + 4, { width: 75, align: 'right' });
  });

  // footer total (right aligned, bold)
  const fy = firstRow + rows.length * rowH + 10;
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.ink);
  doc.text(footerLabel, 400, fy, { width: 90, align: 'right' });
  doc.text(inr(footerTotal), 491, fy, { width: 60, align: 'right' });
  return bgBottom;
};

// ─────────────────────────────────────────────────────────────
// Main entry: streams the finished PDF into the HTTP response.
// ─────────────────────────────────────────────────────────────
export const streamPayslipPdf = ({ payroll, employee, company, leaveBalance }, res) => {
  const e = payroll.earnings;
  const d = payroll.deductions;
  const [yr, mn] = payroll.month.split('-').map(Number);
  const payableDays = payroll.workingDays - payroll.absentDays;

  const doc = new PDFDocument({
    size: 'A4',
    margin: 30,
    info: { Title: `Payslip ${payroll.month} - ${employee.name}`, Author: company?.name || 'Crewly HRMS' },
  });
  doc.pipe(res);

  // ══ 1. HEADER ══════════════════════════════════════════════
  const initials = (company?.name || 'C').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  doc.save().roundedRect(30, 45, 30, 26, 6).fill(C.navy).restore();
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#ffffff')
    .text(initials, 30, 45, { width: 30, height: 26, align: 'center', valign: 'center' });

  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.navy).text(company?.name?.toUpperCase() || 'COMPANY', 66, 46, { width: 380 });
  const a = company?.address || {};
  const addr = [[a.line, a.city].filter(Boolean).join(', '), [a.state, a.pincode ? `- ${a.pincode}` : ''].filter(Boolean).join(' ')]
    .filter(Boolean).join('\n');
  doc.font('Helvetica').fontSize(6.8).fillColor('#4b5563')
    .text(addr || 'Address not set — update it in Company Profile', 66, 60, { width: 340 });

  doc.save().moveTo(458, 45).lineTo(458, 79).lineWidth(1).stroke(C.divider).restore();
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.ink).text(`Payslip: ${MONTH_SHORT[mn - 1]} ${yr}`, 470, 46);
  doc.font('Helvetica').fontSize(6).fillColor(C.label).text('Generated by', 470, 61);
  doc.save().roundedRect(470, 67, 9, 9, 2).fill(C.green).restore();
  doc.font('Helvetica-Bold').fontSize(6).fillColor('#ffffff').text('C', 470, 68.5, { width: 9, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.ink).text('Crewly HRMS', 482, 68.5);

  // ══ 2. NET PAY STRIP ═══════════════════════════════════════
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#4b5563').text('Net Pay', 170, 93);
  doc.font('Helvetica-Bold').fontSize(14).fillColor(C.ink).text(inr(payroll.netPay), 170, 105);
  doc.font('Helvetica').fontSize(14).fillColor('#9aa3b2').text('=', 300, 106);

  doc.save().roundedRect(320, 93, 4, 28, 2).fill(C.green).restore();
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#4b5563').text('Gross Pay (A)', 332, 93);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(C.ink).text(`+ ${inr(e.gross)}`, 332, 105);

  doc.save().roundedRect(445, 93, 4, 28, 2).fill(C.orange).restore();
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#4b5563').text('Deductions (B)', 457, 93);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(C.ink).text(`- ${inr(d.total)}`, 457, 105);

  // ══ 3. EMPLOYEE DETAILS (left column) ══════════════════════
  const empCode = employee.employeeCode || `EMP-${String(employee._id).slice(-4).toUpperCase()}`;
  const details = [
    ['Employee Code', empCode],
    ['Name', employee.name],
    ['Designation', employee.designation || ROLE_LABEL[employee.role] || '—'],
    ['Department', employee.department?.name || '—'],
    ['Date of birth', fmtDate(employee.dateOfBirth)],
    ['PAN', employee.pan || '—'],
    ['UAN', employee.uan || '—'],
    ['ESIC', employee.esic || '—'],
    ['Account no.', employee.bankAccount || '—'],
    ['IFSC code', employee.ifsc || '—'],
    ['Date of joining', fmtDate(employee.dateOfJoining)],
  ];
  details.forEach(([label, value], i) => {
    const y = 156 + i * 33.5;
    doc.font('Helvetica').fontSize(7).fillColor(C.label).text(label, 30, y);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.ink).text(String(value), 30, y + 9.5, { width: 122, height: 11, ellipsis: true });
  });
  // gap block (mirrors the reference spacing)
  [['Payable Days', String(payableDays)],
   ['Leave Balance', String(leaveBalance)],
   ['Regime Opted', 'New Regime']].forEach(([label, value], i) => {
    const y = 546 + i * 34;
    doc.font('Helvetica').fontSize(7).fillColor(C.label).text(label, 30, y);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.ink).text(String(value), 30, y + 9.5, { width: 122, height: 11, ellipsis: true });
  });

  // ══ 4. GROSS PAY + DEDUCTIONS (right column) ═══════════════
  const bottom = moneySection(doc, {
    top: 156,
    title: 'Gross Pay (A)',
    sub: 'The total money you earned before the deductions',
    accent: C.green, diamondColor: C.green, bg: C.greenBg, line: C.lineGreen,
    head: 'Earnings',
    rows: [
      ['Basic', e.basic],
      ['House Rent Allowance', e.hra],
      ['Special Allowance', e.allowances],
    ],
    footerLabel: 'Gross Pay', footerTotal: e.gross,
  });

  moneySection(doc, {
    top: bottom + 42,
    title: 'Deductions (B)',
    sub: 'The amount deducted for taxes and other benefits',
    accent: C.orange, diamondColor: C.red, bg: C.orangeBg, line: C.lineOrange,
    head: 'Deductions',
    rows: [
      ['Employee PF Contribution', d.pf],
      ['Professional Tax', d.professionalTax],
      ['Loss of Pay (LOP)', d.attendanceDeduction],
    ],
    footerLabel: 'Total Deductions', footerTotal: d.total,
  });

  // ══ 5. FOOTER ══════════════════════════════════════════════
  doc.font('Helvetica').fontSize(6).fillColor(C.label).text('Page 1 of 1', 30, 800);
  doc.text('This is a computer generated payslip and does not require a signature', 300, 800, { width: 265, align: 'right' });

  doc.end();
};

// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.9 — SNAPSHOT-DRIVEN PAYSLIP PDF (§8)
//
//  Built from the frozen 29.9 snapshot, NOT from live payroll data: every
//  figure on the page is a copy of what the 29.6 engine produced and 29.8
//  confirmed as paid. Regenerating (§22) re-renders the SAME snapshot, so a
//  new logo or address can never move a rupee.
//
//  The legacy streamPayslipPdf() above is untouched — it serves the
//  pre-29.9 Payroll records.
// ═══════════════════════════════════════════════════════════════════════════

const M = { left: 40, top: 44, right: 40 };
const PAGE_WIDTH = 595.28; // A4 points
const CONTENT_WIDTH = PAGE_WIDTH - M.left - M.right;

const initialsOf = (name) =>
  String(name || 'C')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();

const rupees = (value) => `Rs ${inr(value)}`;

const ensureSpace = (doc, y, needed) => {
  if (y + needed <= 780) return y;
  doc.addPage();
  return M.top;
};

// A two-column key/value grid (employee details, payment info).
// Each entry is one printed ROW: [leftLabel, leftValue, rightLabel, rightValue].
const detailGrid = (doc, rows, startY) => {
  let y = startY;
  const columnWidth = (CONTENT_WIDTH - 24) / 2;
  const xr = M.left + columnWidth + 24;

  rows.forEach(([leftLabel, leftValue, rightLabel, rightValue]) => {
    doc.font('Helvetica').fontSize(7.2).fillColor(C.label).text(String(leftLabel), M.left, y);
    doc
      .font('Helvetica-Bold')
      .fontSize(8.4)
      .fillColor(C.ink)
      .text(String(leftValue || '—'), M.left, y + 9.5, {
        width: columnWidth - 6,
        height: 12,
        ellipsis: true,
        lineBreak: false,
      });

    if (rightLabel) {
      doc.font('Helvetica').fontSize(7.2).fillColor(C.label).text(String(rightLabel), xr, y);
      doc
        .font('Helvetica-Bold')
        .fontSize(8.4)
        .fillColor(C.ink)
        .text(String(rightValue || '—'), xr, y + 9.5, {
          width: columnWidth - 6,
          height: 12,
          ellipsis: true,
          lineBreak: false,
        });
    }
    y += 30;
  });

  return y + 6;
};

// §9 / §10 — one component per line, never merged, with a total row.
const moneyTable = (doc, { title, subtitle, rows, totalLabel, total, accent, startY, columns = 1 }) => {
  let y = ensureSpace(doc, startY, 60 + (rows.length || 1) * 16);
  diamond(doc, M.left + 2.6, y + 3.6, 2.6, accent);
  doc.font('Helvetica-Bold').fontSize(9.2).fillColor(C.ink).text(title, M.left + 12, y);
  doc.font('Helvetica').fontSize(6.8).fillColor(C.label).text(subtitle, M.left + 12, y + 12);

  y += 28;
  doc.font('Helvetica-Bold').fontSize(7.6).fillColor(C.label).text('Component', M.left, y);
  doc
    .font('Helvetica-Bold')
    .fontSize(7.6)
    .fillColor(C.label)
    .text('Amount', M.left, y, { width: CONTENT_WIDTH, align: 'right' });
  y += 10;
  doc.save().moveTo(M.left, y).lineTo(M.left + CONTENT_WIDTH, y).lineWidth(0.7).stroke('#d7dce5').restore();
  y += 6;

  if (!rows.length) {
    doc.font('Helvetica').fontSize(7.8).fillColor(C.label).text('No components recorded', M.left, y + 2);
    y += 18;
  }

  rows.forEach((row, index) => {
    y = ensureSpace(doc, y, 20);
    if (index % 2 === 0) {
      doc.save().rect(M.left, y - 2, CONTENT_WIDTH, 15).fill('#f7f9fc').restore();
    }
    doc.font('Helvetica').fontSize(8.2).fillColor(C.subtle).text(String(row.name || ''), M.left + 4, y + 2);
    doc
      .font('Helvetica')
      .fontSize(8.2)
      .fillColor(C.ink)
      .text(rupees(row.amount), M.left, y + 2, { width: CONTENT_WIDTH - 4, align: 'right' });
    y += 16;
  });

  y = ensureSpace(doc, y, 26);
  doc.save().moveTo(M.left, y).lineTo(M.left + CONTENT_WIDTH, y).lineWidth(0.7).stroke('#d7dce5').restore();
  y += 5;
  doc.font('Helvetica-Bold').fontSize(8.6).fillColor(C.ink).text(totalLabel, M.left + 4, y + 1);
  doc
    .font('Helvetica-Bold')
    .fontSize(8.6)
    .fillColor(C.ink)
    .text(rupees(total), M.left, y + 1, { width: CONTENT_WIDTH - 4, align: 'right' });
  return y + 26;
};

/**
 * Render a payslip snapshot to a PDF buffer.
 *
 * @param {object} snapshot  the frozen 29.9 snapshot (see payslipRules)
 * @returns {Promise<Buffer>}
 */
export const buildPayslipPdf = (snapshot = {}, options = {}) =>
  new Promise((resolve, reject) => {
    try {
      const company = snapshot.company || {};
      const employee = snapshot.employee || {};
      const payroll = snapshot.payroll || {};
      const salary = snapshot.salary || {};
      const attendance = snapshot.attendance || {};
      const payment = snapshot.payment || null;

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

      // ── 1. header (§8) ──────────────────────────────────────────────────
      // §8 asks for the company LOGO. The snapshot stores the URL; the bytes
      // are resolved by the caller (utils/companyLogo.js) and passed in, so a
      // payslip never blocks on the network. No logo → the initials badge.
      const logo = options?.logo && Buffer.isBuffer(options.logo.buffer) ? options.logo.buffer : null;
      let logoDrawn = false;
      if (logo && logo.length) {
        try {
          doc.image(logo, M.left, M.top, { fit: [34, 30], align: 'center', valign: 'center' });
          logoDrawn = true;
        } catch {
          logoDrawn = false; // unsupported or corrupt image → badge
        }
      }

      if (!logoDrawn) {
        doc.save().roundedRect(M.left, M.top, 34, 30, 6).fill(C.navy).restore();
        doc
          .font('Helvetica-Bold')
          .fontSize(12)
          .fillColor('#ffffff')
          .text(initialsOf(company.name), M.left, M.top, { width: 34, height: 30, align: 'center', valign: 'center' });
      }

      doc.font('Helvetica-Bold').fontSize(11).fillColor(C.navy).text(String(company.name || 'Company').toUpperCase(), M.left + 42, M.top - 2, { width: 330 });
      doc
        .font('Helvetica')
        .fontSize(7)
        .fillColor('#4b5563')
        .text(String(company.address || 'Address not set'), M.left + 42, M.top + 14, { width: 330 });
      doc
        .font('Helvetica')
        .fontSize(6.6)
        .fillColor(C.label)
        .text([company.pan ? `PAN: ${company.pan}` : '', company.tan ? `TAN: ${company.tan}` : ''].filter(Boolean).join('   '), M.left + 42, M.top + 24, { width: 330 });

      doc.font('Helvetica-Bold').fontSize(11).fillColor(C.ink).text(`Payslip — ${payroll.monthLabel || payroll.month || ''}`, M.left, M.top + 2, { width: CONTENT_WIDTH, align: 'right' });
      doc
        .font('Helvetica')
        .fontSize(7)
        .fillColor(C.label)
        .text(`Cycle: ${String(payroll.cycle || 'MONTHLY')}`, M.left, M.top + 18, { width: CONTENT_WIDTH, align: 'right' });
      doc
        .font('Helvetica')
        .fontSize(7)
        .fillColor(C.label)
        .text(`Payslip No: ${payroll.payslipNumber || '—'}`, M.left, M.top + 28, { width: CONTENT_WIDTH, align: 'right' });

      let y = M.top + 40;
      doc.save().moveTo(M.left, y).lineTo(M.left + CONTENT_WIDTH, y).lineWidth(1).stroke(C.divider).restore();

      // ── 2. employee details (§8) ────────────────────────────────────────
      y += 12;
      y = detailGrid(
        doc,
        [
          ['Employee ID', employee.employeeCode || employee.employeeId, 'Name', employee.name],
          ['Department', employee.department, 'Designation', employee.designation],
          ['Date of Joining', fmtDate(employee.joiningDate), 'UAN', employee.uan],
          ['PAN', employee.pan, 'Bank', employee.bankName],
          // §13 / §26 — masked, always.
          ['Account Number', employee.accountNumberMasked, 'Payment Mode', payment?.method || 'Bank Transfer'],
        ],
        y,
      );

      // ── 3. attendance summary (§12) ─────────────────────────────────────
      // §12 lists the payroll cycle as part of this block, so it leads the
      // strip. The figures are COPIES from the snapshot — attendance is never
      // recalculated here.
      y = ensureSpace(doc, y, 60);
      doc.font('Helvetica').fontSize(7).fillColor(C.label)
        .text(`Attendance summary — payroll cycle: ${String(payroll.cycle || 'MONTHLY')}`, M.left, y);
      y += 12;
      const boxWidth = CONTENT_WIDTH / 5;
      [
        ['Working Days', attendance.workingDays],
        ['Present Days', attendance.presentDays],
        ['Paid Days', attendance.paidDays],
        ['LOP', attendance.lopDays],
        ['OT Hours', attendance.overtimeHours],
      ].forEach(([label, value], index) => {
        const x = M.left + index * boxWidth;
        doc.save().roundedRect(x + 2, y, boxWidth - 6, 34, 5).fill('#f2f5fa').restore();
        doc.font('Helvetica').fontSize(6.8).fillColor(C.label).text(String(label), x + 8, y + 6);
        doc.font('Helvetica-Bold').fontSize(10).fillColor(C.ink).text(String(value ?? '—'), x + 8, y + 16);
      });
      y += 48;

      // ── 4. earnings (§9) ────────────────────────────────────────────────
      y = moneyTable(doc, {
        title: 'Earnings',
        subtitle: 'Every earning component, shown separately',
        rows: [...(snapshot.earnings || []), ...(snapshot.variableEarnings || [])],
        totalLabel: 'Total Earnings',
        total: salary.totalEarnings,
        accent: C.green,
        startY: y,
      });

      if ((snapshot.reimbursements || []).length) {
        y = moneyTable(doc, {
          title: 'Reimbursements',
          subtitle: 'Claimed and approved outside the salary structure',
          rows: snapshot.reimbursements,
          totalLabel: 'Total Reimbursements',
          total: salary.totalReimbursements,
          accent: C.green,
          startY: y,
        });
      }

      // ── 5. deductions (§10) ─────────────────────────────────────────────
      y = moneyTable(doc, {
        title: 'Deductions',
        subtitle: 'Why money was deducted from your salary',
        rows: snapshot.deductions || [],
        totalLabel: 'Total Deductions',
        total: salary.totalDeductions,
        accent: C.orange,
        startY: y,
      });

      // ── 6. employer contributions (§11) ─────────────────────────────────
      y = ensureSpace(doc, y, 70);
      doc.save().roundedRect(M.left, y, CONTENT_WIDTH, 44, 6).fill('#eef2fb').restore();
      diamond(doc, M.left + 8, y + 12, 2.6, C.navy);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(C.navy).text('Company Contributions', M.left + 18, y + 8);
      doc
        .font('Helvetica')
        .fontSize(6.8)
        .fillColor(C.subtle)
        .text('Paid by the employer on top of your salary — these do NOT reduce your Net Pay.', M.left + 18, y + 20, {
          width: CONTENT_WIDTH - 36,
        });
      const contributions = snapshot.employerContributions || [];
      if (contributions.length) {
        doc
          .font('Helvetica')
          .fontSize(7.4)
          .fillColor(C.subtle)
          .text(contributions.map((row) => `${row.name}: ${rupees(row.amount)}`).join('   ·   '), M.left + 18, y + 30, {
            width: CONTENT_WIDTH - 36,
          });
      }
      doc
        .font('Helvetica-Bold')
        .fontSize(7.6)
        .fillColor(C.navy)
        .text(rupees(salary.totalEmployerContributions), M.left, y + 30, { width: CONTENT_WIDTH - 8, align: 'right' });
      y += 58;

      // ── 7. salary summary (§8) ──────────────────────────────────────────
      y = ensureSpace(doc, y, 66);
      doc.save().roundedRect(M.left, y, CONTENT_WIDTH, 52, 6).fill('#f7f9fc').restore();
      doc.font('Helvetica').fontSize(7.4).fillColor(C.label).text('Gross Salary', M.left + 12, y + 8);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(C.ink).text(rupees(salary.grossSalary), M.left + 12, y + 18);
      doc.font('Helvetica').fontSize(7.4).fillColor(C.label).text('Total Deductions', M.left + 200, y + 8);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(C.ink).text(`- ${rupees(salary.totalDeductions)}`, M.left + 200, y + 18);
      doc.save().roundedRect(M.left + CONTENT_WIDTH - 190, y + 6, 178, 40, 5).fill(C.greenBg).restore();
      doc.font('Helvetica-Bold').fontSize(7.6).fillColor('#0f7a4a').text('Net Salary', M.left + CONTENT_WIDTH - 178, y + 12);
      doc
        .font('Helvetica-Bold')
        .fontSize(14)
        .fillColor('#0f7a4a')
        .text(rupees(salary.netSalary), M.left + CONTENT_WIDTH - 178, y + 24);
      y += 62;

      // ── 8. payment information (§13) ────────────────────────────────────
      y = ensureSpace(doc, y, 60);
      y = detailGrid(
        doc,
        [
          ['Payment Date', fmtDate(payment?.paymentDate || payroll.paymentDate), 'Payment Mode', payment?.method || 'Bank Transfer'],
          ['Bank', payment?.bankName || employee.bankName, 'Account Number', payment?.accountNumberMasked || employee.accountNumberMasked],
          ['Payment Reference', payment?.reference, 'Payslip Number', payroll.payslipNumber],
        ],
        y,
      );

      // ── 9. footer (§8) ──────────────────────────────────────────────────
      const footerY = 792;
      doc.save().moveTo(M.left, footerY - 10).lineTo(M.left + CONTENT_WIDTH, footerY - 10).lineWidth(0.6).stroke('#d7dce5').restore();
      doc
        .font('Helvetica')
        .fontSize(6.4)
        .fillColor(C.label)
        .text(`Payslip ${payroll.payslipNumber || ''}   ·   Generated ${fmtDate(snapshot.generatedAt)}`, M.left, footerY, {
          width: CONTENT_WIDTH / 2,
        });
      doc
        .font('Helvetica')
        .fontSize(6.4)
        .fillColor(C.label)
        .text('System generated — no signature required', M.left, footerY, {
          width: CONTENT_WIDTH,
          align: 'right',
        });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });

export default { streamPayslipPdf, buildPayslipPdf };
