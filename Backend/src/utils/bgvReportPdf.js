import PDFDocument from 'pdfkit';

// Phase 30.10 — final BGV report PDF (private, deterministic).
// Renders ONLY the stored report snapshot — never from live mutable records,
// never with QA notes, tokens, raw identifiers, or payment information.
// Follows the established payslip PDFKit pattern (build → Buffer).

const safe = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text.length ? text.slice(0, 400) : fallback;
};

const dateLabel = (value) =>
  value ? new Date(value).toLocaleDateString('en-IN') : '';

const methodLabel = (method) =>
  method === 'DIGILOCKER_ISSUER_ASSISTED'
    ? 'DigiLocker / issuer-assisted manual verification'
    : String(method || '')
        .toLowerCase()
        .replace(/_/g, ' ');

export const buildBgvReportPdf = (snapshot = {}) =>
  new Promise((resolve, reject) => {
    try {
      const chunks = [];
      const doc = new PDFDocument({
        size: 'A4',
        margin: 48,
        info: {
          Title: `BGV Report ${snapshot.reportNumber || ''}`,
          Author: 'Crewly HRMS',
          Subject: `Final background verification report ${snapshot.reportNumber || ''}`,
        },
      });

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Header band — Crewly / Infolexus identity.
      doc.rect(0, 0, doc.page.width, 96).fill('#0d1117');
      doc.fillColor('#3fb950').fontSize(15).text('Crewly — Background Verification', 48, 30);
      doc.fontSize(9).fillColor('#9aa4af').text('Operated by Infolexus', 48, 52);
      doc.fillColor('#000000');

      doc.y = 120;
      doc.fontSize(13).text('Final Background Verification Report');
      doc.moveDown(0.4).fontSize(9).fillColor('#57606a');
      doc.text(`Report reference: ${safe(snapshot.reportNumber, '—')}`);
      doc.text(`Report version: v${Number(snapshot.version || 1)}`);
      doc.text(`Overall outcome: ${safe(snapshot.overallOutcome, '—').replace(/_/g, ' ')}`);
      doc.text(`Report date: ${dateLabel(snapshot.generatedAt)}`);

      doc.moveDown(0.8).fontSize(10).fillColor('#000000');
      doc.text(`Requesting organization: ${safe(snapshot.tenantName, '—')}`);
      doc.text(`Candidate: ${safe(snapshot.candidateName, '—')}`);
      (snapshot.identity || []).forEach((entry) => {
        doc.text(
          `Identity document: ${safe(entry.documentType, '—')} — ${safe(entry.identifierMasked, 'masked value not provided')}`
        );
      });

      // Per-check summary.
      doc.moveDown(1).fontSize(12).fillColor('#1a7f37').text('Checks performed');
      doc.fillColor('#000000');
      (snapshot.checks || []).forEach((check) => {
        doc.moveDown(0.6).fontSize(10);
        doc.text(`${safe(check.checkType, '—')} — ${safe(check.conclusion, '—').replace(/_/g, ' ')}`);
        doc.fontSize(8).fillColor('#57606a');
        doc.text(`QA-approved revision: v${Number(check.revision || 1)}`);
        const methods = (check.methods || []).map(methodLabel);
        doc.text(`Verification methods: ${methods.join(', ') || 'document review'}`);
        doc.text(`Completed: ${dateLabel(check.completedAt)}`);
        if ((check.discrepancies || []).length) {
          doc.fillColor('#8d6b2a');
          doc.text('Discrepancies noted:');
          check.discrepancies.forEach((discrepancy) => {
            doc.text(
              `  • ${safe(discrepancy.field, 'field')} [${safe(discrepancy.severity, 'INFO')}]: ${safe(discrepancy.explanation, '')}`
            );
          });
          doc.fillColor('#000000');
        }
        if (check.conclusion === 'UNABLE_TO_VERIFY' || check.conclusion === 'INCONCLUSIVE') {
          doc.fillColor('#8d6b2a');
          doc.text('This check could not be conclusively verified from the available sources.');
          doc.fillColor('#000000');
        }
        doc.fontSize(10);
      });

      // Footer disclaimer — human decision boundary.
      doc.moveDown(1.2).fontSize(8).fillColor('#57606a');
      doc.text(safe(snapshot.disclaimer, ''));

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
