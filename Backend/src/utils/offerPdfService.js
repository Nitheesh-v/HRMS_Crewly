import PDFDocument from 'pdfkit';

const GREEN = '#22c55e';
const INK = '#172033';
const MUTED = '#5f6b7a';
const BORDER = '#dbe2ea';
const LIGHT = '#f6f8fb';

const money = (value, currency) => {
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(Number(value) || 0);
  } catch {
    return `${currency} ${Number(value || 0).toFixed(2)}`;
  }
};

const date = (value) =>
  new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value));

const label = (value) =>
  String(value || '')
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const addHeader = (doc, offer) => {
  doc
    .rect(0, 0, doc.page.width, 86)
    .fill(INK)
    .fillColor(GREEN)
    .font('Helvetica-Bold')
    .fontSize(20)
    .text('CREWLY', 48, 28, { continued: true })
    .fillColor('#ffffff')
    .text('  OFFER LETTER')
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#cad3df')
    .text(offer.companySnapshot.name, 48, 57);
};

const addFooter = (doc, offer) => {
  const y = doc.page.height - 42;
  doc
    .moveTo(48, y)
    .lineTo(doc.page.width - 48, y)
    .strokeColor(BORDER)
    .stroke()
    .font('Helvetica')
    .fontSize(8)
    .fillColor(MUTED)
    .text(`${offer.offerCode}  |  Confidential`, 48, y + 10, {
      width: doc.page.width - 96,
      align: 'center',
    });
};

const addFact = (doc, title, value, x, y, width) => {
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(MUTED)
    .text(title.toUpperCase(), x, y, { width })
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor(INK)
    .text(String(value || 'Not specified'), x, y + 14, { width });
};

export const generateOfferPdf = async (offer) => {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 112, bottom: 68, left: 48, right: 48 },
    info: {
      Title: `Offer Letter ${offer.offerCode}`,
      Author: offer.companySnapshot.name,
      Subject: `Employment offer for ${offer.candidateSnapshot.name}`,
      Creator: 'Crewly HRMS',
      CreationDate: new Date(offer.approval?.approvedAt || Date.now()),
    },
    bufferPages: true,
  });

  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const completed = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  addHeader(doc, offer);
  doc.on('pageAdded', () => addHeader(doc, offer));

  doc
    .font('Helvetica-Bold')
    .fontSize(25)
    .fillColor(INK)
    .text('Employment Offer', { align: 'left' })
    .moveDown(0.35)
    .font('Helvetica')
    .fontSize(10)
    .fillColor(MUTED)
    .text(`Prepared for ${offer.candidateSnapshot.name}`)
    .moveDown(1.3);

  const factsY = doc.y;
  doc.roundedRect(48, factsY, 499, 68, 7).fill(LIGHT);
  addFact(doc, 'Offer reference', offer.offerCode, 64, factsY + 14, 145);
  addFact(doc, 'Offer date', date(offer.terms.offerDate), 221, factsY + 14, 140);
  addFact(doc, 'Valid until', date(offer.terms.expiryDate), 373, factsY + 14, 154);
  doc.y = factsY + 92;

  doc
    .font('Helvetica')
    .fontSize(10.5)
    .fillColor(INK)
    .text(offer.renderedContent, {
      align: 'left',
      lineGap: 3,
      paragraphGap: 8,
    })
    .moveDown(1.3);

  const section = (title) => {
    if (doc.y > 620) doc.addPage();
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor(INK)
      .text(title)
      .moveDown(0.45);
  };

  section('Position details');
  const positionRows = [
    ['Designation', offer.terms.designation],
    ['Department', offer.terms.departmentName || 'Not specified'],
    ['Work arrangement', label(offer.terms.workMode)],
    ['Employment type', label(offer.terms.employmentType)],
    ['Joining date', date(offer.terms.joiningDate)],
    ['Reporting manager', offer.terms.reportingManagerName || 'To be assigned'],
  ];

  positionRows.forEach(([key, value], index) => {
    const y = doc.y;
    doc
      .rect(48, y, 499, 24)
      .fill(index % 2 ? '#ffffff' : LIGHT)
      .font('Helvetica')
      .fontSize(9)
      .fillColor(MUTED)
      .text(key, 58, y + 7, { width: 170 })
      .font('Helvetica-Bold')
      .fillColor(INK)
      .text(String(value), 236, y + 7, { width: 300 });
    doc.y = y + 24;
  });

  doc.moveDown(1.2);
  section('Compensation snapshot');
  const compensation = offer.compensationSnapshot;
  const compensationRows = [
    ['Annual CTC', money(compensation.annualCTC, compensation.currency)],
    ['Monthly basic', money(compensation.monthly?.basic, compensation.currency)],
    ['Monthly HRA', money(compensation.monthly?.hra, compensation.currency)],
    ['Monthly allowances', money(compensation.monthly?.allowances, compensation.currency)],
    ['Variable pay', money(compensation.variablePay, compensation.currency)],
    ['Offer bonus', money(compensation.bonus, compensation.currency)],
  ];

  compensationRows.forEach(([key, value], index) => {
    const y = doc.y;
    doc
      .rect(48, y, 499, 24)
      .fill(index % 2 ? '#ffffff' : LIGHT)
      .font('Helvetica')
      .fontSize(9)
      .fillColor(MUTED)
      .text(key, 58, y + 7, { width: 230 })
      .font('Helvetica-Bold')
      .fillColor(INK)
      .text(value, 294, y + 7, { width: 242, align: 'right' });
    doc.y = y + 24;
  });

  doc.moveDown(1.3);
  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor(MUTED)
    .text(
      'This document is a fixed snapshot of the approved offer. Compensation is subject to applicable tax, statutory deductions, and the policies referenced in the offer terms.',
      { lineGap: 2 }
    );

  if (doc.y > 625) doc.addPage();
  doc
    .moveDown(1.5)
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor(INK)
    .text(`For ${offer.companySnapshot.name}`)
    .moveDown(1.6)
    .moveTo(48, doc.y)
    .lineTo(250, doc.y)
    .strokeColor(BORDER)
    .stroke()
    .moveDown(0.45)
    .font('Helvetica-Bold')
    .fontSize(9.5)
    .fillColor(INK)
    .text(offer.approvalSignatory?.name || 'Authorized signatory', { width: 260 })
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor(MUTED)
    .text(label(offer.approvalSignatory?.role || 'Authorized signatory'), { width: 260 })
    .text(`Approved through Crewly on ${date(offer.approvalSignatory?.approvedAt || offer.approval?.approvedAt)}`, {
      width: 300,
    });

  const range = doc.bufferedPageRange();
  for (let page = range.start; page < range.start + range.count; page += 1) {
    doc.switchToPage(page);
    addFooter(doc, offer);
  }

  doc.end();
  return completed;
};
