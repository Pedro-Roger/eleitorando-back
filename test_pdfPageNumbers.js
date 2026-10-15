const test = require('node:test');
const assert = require('node:assert/strict');
const PDFDocument = require('pdfkit');

const { addPdfPageNumbers } = require('./src/lib/pdfPageNumbers');

test('adiciona rodapés sem criar páginas em branco', () => {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true });
  let pageAdded = 0;
  doc.on('pageAdded', () => { pageAdded += 1; });
  doc.addPage();
  doc.addPage();
  const expectedPageAdditions = pageAdded;

  addPdfPageNumbers(doc);

  assert.equal(pageAdded, expectedPageAdditions);
  doc.end();
});
