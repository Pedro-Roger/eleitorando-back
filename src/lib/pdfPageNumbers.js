function addPdfPageNumbers(doc) {
  const pages = doc.bufferedPageRange();
  for (let page = pages.start; page < pages.start + pages.count; page += 1) {
    doc.switchToPage(page);
    doc.save();
    const footer = `Página ${page - pages.start + 1} de ${pages.count}`;
    doc.font('Helvetica').fontSize(8).fillColor('#64748B');
    const x = doc.page.width - doc.page.margins.right - doc.widthOfString(footer);
    doc.text(footer, x, doc.page.height - 24, { lineBreak: false });
    doc.restore();
  }
  doc.flushPages();
}

module.exports = { addPdfPageNumbers };
