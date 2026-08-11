const { Router } = require('express');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const prisma = require('../db/prisma');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('../lib/helpers');

const router = Router();

// Compartilhamento de dados é recurso exclusivo do administrador
router.use(requireRole('ADMIN'));

// Colunas disponíveis para exportação. "name" é sempre incluída.
const COLUMNS = {
  name: { label: 'Nome', get: (v) => v.name },
  phone: { label: 'Telefone', get: (v) => v.phone || '' },
  city: { label: 'Cidade', get: (v) => v.city },
  neighborhood: { label: 'Bairro', get: (v) => v.neighborhood || '' },
  state: { label: 'Estado', get: (v) => v.state },
  gender: { label: 'Gênero', get: (v) => v.gender || '' },
  age: { label: 'Idade', get: (v) => (v.age != null ? v.age : '') },
  zone: { label: 'Zona', get: (v) => v.zone || '' },
  section: { label: 'Seção', get: (v) => v.section || '' },
  createdBy: { label: 'Cadastrado por', get: (v) => v.createdBy?.name || '' },
  cabo: { label: 'Cabo responsável', get: (v) => v.caboGroup || '' },
};

// Opções para montar a tela: árvore cabo→subcabos e valores existentes p/ filtros
router.get('/options', async (req, res) => {
  const cabos = await prisma.user.findMany({
    where: { role: 'CABO', deletedAt: null },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      subcabos: {
        where: { deletedAt: null },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      },
    },
  });
  const [cities, neighborhoods, genders] = await Promise.all([
    prisma.voter.findMany({ distinct: ['city'], select: { city: true }, orderBy: { city: 'asc' } }),
    prisma.voter.findMany({
      distinct: ['neighborhood'],
      select: { neighborhood: true },
      where: { neighborhood: { not: null } },
      orderBy: { neighborhood: 'asc' },
    }),
    prisma.voter.findMany({
      distinct: ['gender'],
      select: { gender: true },
      where: { gender: { not: null } },
      orderBy: { gender: 'asc' },
    }),
  ]);
  res.json({
    cabos,
    cities: cities.map((c) => c.city),
    neighborhoods: neighborhoods.map((n) => n.neighborhood),
    genders: genders.map((g) => g.gender),
  });
});

// Telefone no formato aceito pelas listas de transmissão: só dígitos, com DDI 55
function wppPhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return null;
  return digits.startsWith('55') && digits.length >= 12 ? digits : `55${digits}`;
}

function csvField(value) {
  const s = String(value ?? '');
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildWhere(query) {
  const where = {};
  const ids = String(query.createdByIds || '')
    .split(',')
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length) where.createdById = { in: ids };
  if (query.city) where.city = String(query.city);
  if (query.neighborhood) where.neighborhood = String(query.neighborhood);
  if (query.gender) where.gender = String(query.gender);
  return where;
}

// Exportação de eleitores.
// Params: format=xlsx|csv|pdf|wpp · columns=name,phone,... · createdByIds=1,2 (vazio = todos)
//         city · neighborhood · gender · count=1 (retorna só a contagem, para a prévia)
router.get('/voters', async (req, res) => {
  const where = buildWhere(req.query);

  if (req.query.count) {
    const total = await prisma.voter.count({ where });
    return res.json({ total });
  }

  const format = String(req.query.format || 'csv');
  const requested = String(req.query.columns || '')
    .split(',')
    .filter((c) => COLUMNS[c]);
  const colKeys = ['name', ...requested.filter((c) => c !== 'name')];
  const cols = colKeys.map((k) => COLUMNS[k]);

  const voters = await prisma.voter.findMany({
    where,
    orderBy: { name: 'asc' },
    include: { createdBy: { select: { name: true, role: true, parentId: true } } },
  });

  // Agrupa por cabo responsável: eleitores do cabo e dos seus subcabos ficam juntos.
  // Inclui cabos já excluídos (dado histórico); cadastros do admin formam grupo próprio.
  const cabosAll = await prisma.user.findMany({ where: { role: 'CABO' }, select: { id: true, name: true } });
  const caboName = new Map(cabosAll.map((c) => [c.id, c.name]));
  voters.forEach((v) => {
    const c = v.createdBy;
    if (!c) v.caboGroup = 'Sem responsável';
    else if (c.role === 'CABO') v.caboGroup = c.name;
    else if (c.role === 'SUBCABO') v.caboGroup = caboName.get(c.parentId) || c.name;
    else v.caboGroup = 'Administração';
  });
  voters.sort(
    (a, b) => a.caboGroup.localeCompare(b.caboGroup, 'pt-BR') || a.name.localeCompare(b.name, 'pt-BR')
  );
  const groupLabel = (g) => (g === 'Administração' || g === 'Sem responsável' ? g : `Cabo: ${g}`);
  const groupCount = new Map();
  voters.forEach((v) => groupCount.set(v.caboGroup, (groupCount.get(v.caboGroup) || 0) + 1));

  const today = new Date().toISOString().slice(0, 10);
  const filename = `eleitores-${today}`;

  await logActivity(
    req.user.id,
    'DADOS_EXPORTADOS',
    `${req.user.name} exportou ${voters.length} eleitor(es) em formato ${format.toUpperCase()}`
  );

  // Lista para WhatsApp: Nome,5585999999999 — sem cabeçalho; quem não tem telefone fica de fora
  if (format === 'wpp') {
    const lines = voters
      .map((v) => {
        const phone = v.phone ? wppPhone(v.phone) : null;
        return phone ? `${csvField(v.name)},${phone}` : null;
      })
      .filter(Boolean);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}-whatsapp.csv"`);
    return res.send('\ufeff' + `${lines.join('\r\n')}`);
  }

  if (format === 'csv') {
    const header = cols.map((c) => csvField(c.label)).join(',');
    const rows = voters.map((v) => cols.map((c) => csvField(c.get(v))).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    return res.send('\ufeff' + `${[header, ...rows].join('\r\n')}`);
  }

  if (format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Eleitores');
    ws.columns = colKeys.map((k) => ({
      header: COLUMNS[k].label,
      key: k,
      width: k === 'name' || k === 'createdBy' ? 32 : 16,
    }));
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
    let lastGroup = null;
    voters.forEach((v) => {
      if (v.caboGroup !== lastGroup) {
        lastGroup = v.caboGroup;
        const r = ws.addRow([`${groupLabel(v.caboGroup)} — ${groupCount.get(v.caboGroup)} eleitor(es)`]);
        r.font = { bold: true };
        r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E9F5' } };
        if (colKeys.length > 1) ws.mergeCells(r.number, 1, r.number, colKeys.length);
      }
      ws.addRow(Object.fromEntries(colKeys.map((k) => [k, COLUMNS[k].get(v)])));
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    await wb.xlsx.write(res);
    return res.end();
  }

  if (format === 'pdf') {
    const landscape = cols.length > 5;
    const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 36 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
    doc.pipe(res);

    const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    // Nome e "Cadastrado por" ganham o dobro do espaço das colunas curtas
    const weights = colKeys.map((k) => (k === 'name' || k === 'createdBy' ? 2 : 1));
    const totalW = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (usable * w) / totalW);
    const rowH = 18;
    const bottom = () => doc.page.height - doc.page.margins.bottom;

    doc.fontSize(14).font('Helvetica-Bold').text('Eleitores — Eleitorando');
    doc.fontSize(9).font('Helvetica').fillColor('#555')
      .text(`Gerado em ${new Date().toLocaleDateString('pt-BR')} · ${voters.length} eleitor(es)`);
    doc.moveDown(0.8);

    const drawRow = (values, bold) => {
      const y = doc.y;
      if (y + rowH > bottom()) {
        doc.addPage();
        drawRow(cols.map((c) => c.label), true);
        return drawRow(values, bold);
      }
      let x = doc.page.margins.left;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor('#111');
      values.forEach((val, i) => {
        doc.text(String(val), x + 2, y + 4, { width: widths[i] - 4, height: rowH, ellipsis: true, lineBreak: false });
        x += widths[i];
      });
      doc
        .moveTo(doc.page.margins.left, y + rowH)
        .lineTo(doc.page.margins.left + usable, y + rowH)
        .strokeColor('#ddd')
        .lineWidth(0.5)
        .stroke();
      doc.y = y + rowH;
      doc.x = doc.page.margins.left;
    };

    // Faixa destacada que abre a seção de cada cabo
    const drawGroupHeader = (group) => {
      if (doc.y + rowH + 6 > bottom()) doc.addPage();
      const y = doc.y + 4;
      doc.rect(doc.page.margins.left, y, usable, rowH).fill('#E8E9F5');
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#3730a3')
        .text(`${groupLabel(group)} — ${groupCount.get(group)} eleitor(es)`, doc.page.margins.left + 4, y + 4, {
          width: usable - 8,
          lineBreak: false,
        });
      doc.y = y + rowH;
      doc.x = doc.page.margins.left;
    };

    drawRow(cols.map((c) => c.label), true);
    let lastPdfGroup = null;
    voters.forEach((v) => {
      if (v.caboGroup !== lastPdfGroup) {
        lastPdfGroup = v.caboGroup;
        drawGroupHeader(v.caboGroup);
      }
      drawRow(cols.map((c) => c.get(v)), false);
    });
    doc.end();
    return;
  }

  res.status(400).json({ error: 'Formato inválido. Use xlsx, csv, pdf ou wpp.' });
});

module.exports = router;
