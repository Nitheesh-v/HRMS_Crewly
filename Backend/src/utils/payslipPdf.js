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