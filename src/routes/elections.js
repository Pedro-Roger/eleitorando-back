// Resultados eleitorais: painel "Principais Cidades" (total = VOTOS) e
// cruzamento eleição passada (TSE, ElectionResult) vs atual (intenção dos
// eleitores cadastrados, Voter.candidateId). Agregações via Knex.
const { Router } = require('express');
const PDFDocument = require('pdfkit');
const knex = require('../db/knex');
const { requireRole } = require('../middleware/auth');
const { buildComparisonRows } = require('../lib/electionComparison');
const { buildElectionReport } = require('../lib/electionReport');

const router = Router();

const DEFAULT_PAST_YEAR = 2022; // eleição passada (base TSE importada)
const DEFAULT_OFFICE = 'GOVERNADOR';
// Ordem preferida dos cargos no seletor do front (principal primeiro).
const OFFICE_ORDER = ['DEPUTADO ESTADUAL', 'GOVERNADOR', 'DEPUTADO FEDERAL', 'SENADOR'];
const MAX_CANDIDATES_PER_CITY = 5; // payload enxuto: top N + "Outros"

// Params tolerantes: valor inválido → fallback padrão (front nunca quebra)
function safeInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (min !== undefined && n < min) return fallback;
  if (max !== undefined && n > max) return fallback;
  return Math.trunc(n);
}

function queryBase(req) {
  // year: inválido (não numérico) → padrão; fora de range → respeitado (retorna vazio)
  const rawYear = Number(req.query.year);
  const year = Number.isFinite(rawYear) ? Math.trunc(rawYear) : DEFAULT_PAST_YEAR;
  return {
    year,
    office: String(req.query.office || DEFAULT_OFFICE).toUpperCase() || DEFAULT_OFFICE,
    turn: req.query.turn !== undefined && req.query.turn !== '' ? safeInt(req.query.turn, 1, 1, 3) : 1,
    // Teto alto (999): CE tem ~184 municípios — o front pede limit=999 no
    // comparativo para o "Por Cidade" mostrar todas as cidades.
    limit: safeInt(req.query.limit, 10, 1, 999),
  };
}

// Cargos disponíveis na base TSE (eleição passada) para o seletor do cruzamento.
router.get('/offices', requireRole('ADMIN'), async (req, res) => {
  const rows = await knex('election_results')
    .where({ year: DEFAULT_PAST_YEAR, source: 'TSE' })
    .distinct('office');
  const found = rows.map((r) => r.office);
  // Ordem estável: cargos conhecidos primeiro (DEPUTADO ESTADUAL à frente),
  // depois quaisquer outros achados na base, em ordem alfabética.
  const offices = [
    ...OFFICE_ORDER.filter((o) => found.includes(o)),
    ...found.filter((o) => !OFFICE_ORDER.includes(o)).sort(),
  ];
  res.json({ offices: offices.length ? offices : OFFICE_ORDER });
});

// Lista statewide de candidatos da eleição passada (base TSE), agregada por
// nome em TODAS as cidades (sem limite): alimenta o seletor do cruzamento,
// que antes só via os nomes presentes nas top-N cidades do comparativo —
// candidatos que votaram só em cidades pequenas ficavam de fora.
router.get('/candidates', requireRole('ADMIN'), async (req, res) => {
  let { year, office, turn } = queryBase(req);
  const candidateName = String(req.query.candidateName || '').trim();
  
  if (candidateName && !req.query.office) {
    const foundOffice = await knex('election_results')
      .where('candidateName', candidateName)
      .andWhere('year', year)
      .first('office');
    if (foundOffice) {
      office = foundOffice.office;
    }
  }

  const rows = await knex('election_results')
    .where({ year, office, source: 'TSE' })
    .where({ turn })
    .select('candidateName', knex.raw("COALESCE(MAX(party), '') as party"), knex.raw('SUM(votes) as votes'))
    .groupBy('candidateName')
    .orderBy('votes', 'desc');

  res.json({
    year,
    office,
    turn,
    candidates: rows.map((r) => ({
      candidateName: r.candidateName,
      party: r.party || '',
      votes: Number(r.votes) || 0,
    })),
  });
});

// Painel: Principais Cidades — total = VOTOS da eleição passada (TSE)
router.get('/principais-cidades', requireRole('ADMIN'), async (req, res) => {
  const { year, office, turn, limit } = queryBase(req);

  const base = knex('election_results').where({ year, office, source: 'TSE' }).where({ turn });
  const rows = await base
    .select('city')
    .sum('votes as total')
    .groupBy('city')
    .orderBy('total', 'desc')
    .limit(limit);

  res.json({
    year,
    office,
    turn,
    cities: rows.map((r) => ({ city: r.city, total: Number(r.total) || 0 })),
  });
});

// Cruzamento atual vs passada, por cidade: votos nominais do TSE (passada)
// vs intenção de voto dos eleitores cadastrados (atual).
// Por cidade: top N candidatos de cada lado + "outros" agregado.
router.get('/comparativo', requireRole('ADMIN'), async (req, res) => {
  const { year: pastYear, office, turn, limit } = queryBase(req);

  const past = await knex('election_results')
    .where({ year: pastYear, office, source: 'TSE' })
    .where({ turn })
    .select('city', 'candidateName', 'party', 'candidateId')
    .sum('votes as total')
    .groupBy('city', 'candidateName', 'party', 'candidateId')
    .orderBy('city');

  const current = await knex('voters')
    .join('candidates', 'candidates.id', 'voters.candidateId')
    .whereNotNull('voters.city')
    .where('candidates.deletedAt', null)
    .select(
      knex.raw('UPPER(voters.city) as city'),
      'candidates.id as candidateId',
      'candidates.name as candidateName',
      'candidates.photoUrl as photoUrl'
    )
    .sum('votes as total')
    .groupByRaw('UPPER(voters.city), "candidates"."id", "candidates"."name", "candidates"."photoUrl"')
    .orderByRaw('UPPER(voters.city)');

  const byCity = new Map();
  const cityEntry = (city) => {
    if (!byCity.has(city)) byCity.set(city, { city, pastTotal: 0, past: [], currentTotal: 0, current: [] });
    return byCity.get(city);
  };
  for (const r of past) {
    const e = cityEntry(r.city);
    const votes = Number(r.total) || 0;
    e.pastTotal += votes;
    if (r.candidateName) {
      e.past.push({ candidateId: r.candidateId || null, name: r.candidateName, party: r.party || null, votes });
    }
  }
  for (const r of current) {
    const e = cityEntry(r.city);
    const voters = Number(r.total) || 0;
    e.currentTotal += voters;
    e.current.push({
      candidateId: r.candidateId,
      name: r.candidateName,
      photoUrl: r.photoUrl || null,
      voters,
    });
  }

  // Ordena por votos e agrega excedentes em "outros" (payload estável pro front)
  const cities = [...byCity.values()]
    .sort((a, b) => b.pastTotal - a.pastTotal)
    .slice(0, limit);
  for (const e of cities) {
    e.past.sort((a, b) => b.votes - a.votes);
    e.current.sort((a, b) => b.voters - a.voters);
    if (e.past.length > MAX_CANDIDATES_PER_CITY) {
      e.pastOthers = e.past.slice(MAX_CANDIDATES_PER_CITY).reduce((s, c) => s + c.votes, 0);
      e.past = e.past.slice(0, MAX_CANDIDATES_PER_CITY);
    } else {
      e.pastOthers = 0;
    }
    if (e.current.length > MAX_CANDIDATES_PER_CITY) {
      e.currentOthers = e.current.slice(MAX_CANDIDATES_PER_CITY).reduce((s, c) => s + c.voters, 0);
      e.current = e.current.slice(0, MAX_CANDIDATES_PER_CITY);
    } else {
      e.currentOthers = 0;
    }
  }

  res.json({
    pastYear,
    office,
    turn,
    cities, // [] se base vazia — front trata como "sem dados"
  });
});

// Base de eleitores cadastrados de um político, por bairro: voters apontando
// para o Candidate agrupados por neighborhood. Parâmetro preferido é
// candidateId (o front conhece a linha cadastrada do político); aceita também
// candidateName (match case-insensitive exato, sem unaccent no SQL).
router.get('/base-bairros', requireRole('ADMIN'), async (req, res) => {
  const candidateId = safeInt(req.query.candidateId, 0, 1);
  let resolvedId = candidateId;

  if (!resolvedId) {
    const name = String(req.query.candidateName || '').trim();
    if (name) {
      const row = await knex('candidates')
        .whereNull('deletedAt')
        .andWhereRaw('UPPER(TRIM(name)) = UPPER(?)', [name])
        .first('id');
      resolvedId = row ? row.id : 0;
    }
  }

  // Político sem linha cadastrada → lista vazia (front mostra aviso).
  if (!resolvedId) {
    return res.json({ candidateId: null, bairros: [] });
  }

  const rows = await knex('voters')
    .join('candidates', 'candidates.id', 'voters.candidateId')
    .where('voters.candidateId', resolvedId)
    .whereNotNull('voters.neighborhood')
    .whereNot('voters.neighborhood', '')
    .select('voters.neighborhood')
    .sum('votes as total')
    .groupBy('voters.neighborhood')
    .orderBy('total', 'desc');

  res.json({
    candidateId: resolvedId,
    bairros: rows.map((r) => ({ neighborhood: r.neighborhood, total: Number(r.total) || 0 })),
  });
});

// Cruzamento por zona/seção para um único candidato: votos TSE da eleição
// passada vs eleitores coletados (atual) na mesma seção. Zona/seção já estão
// em formato canônico numérico nos dois lados (ver normalize-zona-secao.js).
// candidateName é obrigatório (candidato TSE); candidateId identifica o
// político do sistema — se ausente, tenta resolver pelo mesmo nome (como
// /base-bairros) e, sem match, coletado fica 0 em todas as seções.
// Contrato do front: cada item = { zona, secao, coletado, tse }.
router.get('/comparativo-zona', requireRole('ADMIN'), async (req, res) => {
  let { year, office, turn } = queryBase(req);
  const tempName = String(req.query.candidateName || '').trim();
  if (tempName) {
    const foundRecord = await knex('election_results').whereRaw('UPPER(TRIM("candidateName")) = UPPER(?)', [tempName]).first('office', 'year');
    if (foundRecord) {
      if (!req.query.office) office = foundRecord.office;
      if (!req.query.year) year = foundRecord.year;
    }
  }
  // Por seção a lista é grande (ex.: Governador 2026 CE = ~23k seções) —
  // teto próprio, bem acima do cap global de 999 do queryBase.
  const limit = safeInt(req.query.limit, 999, 1, 30000);
  const candidateName = String(req.query.candidateName || '').trim();
  if (!candidateName) {
    return res.status(400).json({ error: 'Parâmetro candidateName é obrigatório.' });
  }

  const candidateId = safeInt(req.query.candidateId, 0, 1);
  let resolvedId = candidateId;
  if (!resolvedId) {
    const row = await knex('candidates')
      .whereNull('deletedAt')
      .andWhereRaw('UPPER(TRIM(name)) = UPPER(?)', [candidateName])
      .first('id');
    resolvedId = row ? row.id : 0;
  }

  const tseRows = await knex('election_results')
    .where({ year, office, source: 'TSE' })
    .where({ turn })
    .whereRaw('UPPER(TRIM("candidateName")) = UPPER(?)', [candidateName])
    .select('city', 'zone', 'section').sum('votes as total').groupBy('city', 'zone', 'section');

    let voterQuery = knex('voters')
    .whereNotNull('zone')
    .whereNotNull('section');

  const caboId = Number(req.query.caboId) || 0;
  const subcaboId = Number(req.query.subcaboId) || 0;

  if (subcaboId) {
    voterQuery = voterQuery.where('createdById', subcaboId);
  } else if (caboId) {
    const subs = await knex('users').where('parentId', caboId).select('id');
    const ids = [caboId, ...subs.map(s => s.id)];
    voterQuery = voterQuery.whereIn('createdById', ids);
  }

  const voterRows = await voterQuery
    .select('city', 'zone', 'section')
    .count('* as total')
    .groupBy('city', 'zone', 'section');

  const bySecao = new Map();
  for (const r of tseRows) {
    const c = String(r.city || '').trim().toUpperCase();
    const z = parseInt(r.zone, 10) || 0;
    const s = parseInt(r.section, 10) || 0;
    const key = `${c}-${z}-${s}`;
    const e = bySecao.get(key) || { city: c, zona: z, secao: s, tse: 0, coletado: 0 };
    e.tse += Number(r.total) || 0;
    bySecao.set(key, e);
  }
  for (const r of voterRows) {
    const c = String(r.city || '').trim().toUpperCase();
    const z = parseInt(r.zone, 10) || 0;
    const s = parseInt(r.section, 10) || 0;
    const key = `${c}-${z}-${s}`;
    const e = bySecao.get(key) || { city: c, zona: z, secao: s, tse: 0, coletado: 0 };
    e.coletado += Number(r.total) || 0;
    bySecao.set(key, e);
  }

  const allSections = [...bySecao.values()].sort((a, b) => b.tse - a.tse);
  // Totais sobre a lista completa (antes do slice) — seções coletadas fora do
  // top N por votos TSE ainda contam no cruzamento.
  const totalTse = allSections.reduce((s, e) => s + e.tse, 0);
  const totalCollected = allSections.reduce((s, e) => s + e.coletado, 0);

  res.json({
    year,
    office,
    turn,
    candidateName,
    candidateId: resolvedId || null,
    totalTseVotes: totalTse,
    totalCollectedVoters: totalCollected,
    sections: allSections.slice(0, limit), // [] se candidato sem votos na base — front trata como "sem dados"
  });
});

async function loadDetailedComparison(req) {
  let { year, office, turn } = queryBase(req);
  const candidateName = String(req.query.candidateName || '').trim();
  if (!candidateName) {
    const error = new Error('Parâmetro candidateName é obrigatório.');
    error.status = 400;
    throw error;
  }

  if (!req.query.office || !req.query.year) {
    const foundRecord = await knex('election_results')
      .whereRaw('UPPER(TRIM("candidateName")) = UPPER(?)', [candidateName])
      .orderBy('year', 'desc')
      .first('office', 'year');
    if (foundRecord) {
      if (!req.query.office) office = foundRecord.office;
      if (!req.query.year) year = foundRecord.year;
    }
  }

  let voterQuery = knex('voters as v')
    .leftJoin('users as creator', 'v.createdById', 'creator.id')
    .leftJoin('users as cabo', 'creator.parentId', 'cabo.id')
    .whereNotNull('v.zone')
    .whereNotNull('v.section');

  const caboId = Number(req.query.caboId) || 0;
  const subcaboId = Number(req.query.subcaboId) || 0;
  if (subcaboId) {
    voterQuery = voterQuery.where('v.createdById', subcaboId);
  } else if (caboId) {
    const subs = await knex('users').where('parentId', caboId).select('id');
    voterQuery = voterQuery.whereIn('v.createdById', [caboId, ...subs.map((s) => s.id)]);
  }

  const voters = await voterQuery.select(
    'v.city',
    'v.zone',
    'v.section',
    'creator.name as creatorName',
    'creator.role as creatorRole',
    'cabo.name as caboName'
  );

  const tseRows = await knex('election_results')
    .where({ year, office, turn, source: 'TSE' })
    .whereRaw('UPPER(TRIM("candidateName")) = UPPER(?)', [candidateName])
    .select('candidateName', 'city', 'zone', 'section')
    .sum('votes as total')
    .groupBy('candidateName', 'city', 'zone', 'section');

  let rows = buildComparisonRows({ voters, tseRows, candidateName });

  // Quando o usuário restringe uma equipe, linhas apenas do TSE não pertencem
  // ao recorte escolhido e não devem aparecer como se fossem da equipe.
  if (caboId || subcaboId) rows = rows.filter((row) => row.cadastrados > 0);

  const zoneFilter = String(req.query.zone || '').trim();
  const sectionFilter = String(req.query.section || '').trim();
  if (zoneFilter) rows = rows.filter((row) => row.zona.includes(zoneFilter));
  if (sectionFilter) rows = rows.filter((row) => row.secao.includes(sectionFilter));

  return { candidateName, year, office, turn, rows };
}

// Comparativo detalhado: cada linha representa cabo/subcabo + zona/seção,
// cruzando os cadastros da equipe com os votos TSE da candidata selecionada.
router.get('/comparativo-eleitores', requireRole('ADMIN'), async (req, res) => {
  const comparison = await loadDetailedComparison(req);
  res.json(comparison);
});

function drawPdfTableRow(doc, values, widths, { header = false } = {}) {
  const rowHeight = 20;
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + rowHeight > bottom) doc.addPage();
  const y = doc.y;
  let x = doc.page.margins.left;
  doc.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor('#111827');
  values.forEach((value, index) => {
    if (header) doc.rect(x, y, widths[index], rowHeight).fill('#E8EEF8');
    doc.fillColor('#111827').text(String(value ?? ''), x + 4, y + 6, {
      width: widths[index] - 8,
      height: rowHeight,
      ellipsis: true,
      lineBreak: false,
    });
    x += widths[index];
  });
  doc.moveTo(doc.page.margins.left, y + rowHeight)
    .lineTo(doc.page.width - doc.page.margins.right, y + rowHeight)
    .strokeColor('#CBD5E1')
    .lineWidth(0.5)
    .stroke();
  doc.y = y + rowHeight;
}

function sendMissingReportPdf(res, report, meta) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="relatorio-votos-faltantes.pdf"');
  doc.pipe(res);

  const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#0F172A').text('Relatório de votos faltantes');
  doc.font('Helvetica').fontSize(10).fillColor('#475569')
    .text(`Candidata: ${report.candidateName} · ${meta.office} · ${meta.turn}º turno`)
    .text(`Gerado em ${new Date().toLocaleDateString('pt-BR')}`);
  doc.moveDown(0.8);

  const metricWidth = usable / 3;
  const metricY = doc.y;
  [['Prometidos', report.totalCadastrados], ['Confirmados TSE', report.totalConfirmados], ['Faltantes', report.totalFaltantes]]
    .forEach(([label, value], index) => {
      const x = doc.page.margins.left + index * metricWidth;
      doc.roundedRect(x, metricY, metricWidth - 8, 42, 6).fill('#F8FAFC');
      doc.font('Helvetica-Bold').fontSize(16).fillColor('#0F172A').text(String(value), x + 10, metricY + 8);
      doc.font('Helvetica').fontSize(8).fillColor('#64748B').text(label, x + 10, metricY + 27);
    });
  doc.y = metricY + 56;

  doc.font('Helvetica-Bold').fontSize(12).fillColor('#0F172A').text('Resumo por cabo e subcabo');
  doc.moveDown(0.3);
  const summaryWidths = [usable * 0.24, usable * 0.24, usable * 0.18, usable * 0.18, usable * 0.16];
  drawPdfTableRow(doc, ['Cabo', 'Subcabo', 'Prometidos', 'Confirmados', 'Faltantes'], summaryWidths, { header: true });
  report.summary.forEach((row) => drawPdfTableRow(doc, [row.cabo || '—', row.subcabo || '—', row.cadastrados, row.confirmados, row.faltantes], summaryWidths));

  doc.moveDown(1);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#0F172A').text('Detalhamento por zona e seção');
  doc.moveDown(0.3);
  const detailWidths = [usable * 0.16, usable * 0.16, usable * 0.11, usable * 0.14, usable * 0.14, usable * 0.12, usable * 0.09, usable * 0.08];
  drawPdfTableRow(doc, ['Cabo', 'Subcabo', 'Zona', 'Seção', 'Prometidos', 'Confirmados', 'Faltantes', 'Status'], detailWidths, { header: true });
  report.details.forEach((row) => drawPdfTableRow(doc, [row.cabo || '—', row.subcabo || '—', row.zona, row.secao, row.cadastrados, row.confirmados, row.faltantes, row.faltantes ? 'Faltam votos' : 'OK'], detailWidths));
  if (!report.details.length) doc.font('Helvetica').fontSize(9).fillColor('#047857').text('Nenhum cadastro encontrado.');

  doc.end();
}

router.get('/relatorio-faltantes', requireRole('ADMIN'), async (req, res) => {
  const comparison = await loadDetailedComparison(req);
  res.json(buildElectionReport(comparison));
});

router.get('/relatorio-faltantes/pdf', requireRole('ADMIN'), async (req, res) => {
  const comparison = await loadDetailedComparison(req);
  sendMissingReportPdf(res, buildElectionReport(comparison), comparison);
});


router.get('/relatorio-eleitores', requireRole('ADMIN'), async (req, res) => {
  const voters = await knex('voters')
    .leftJoin('users as creator', 'voters.createdById', 'creator.id')
    .leftJoin('users as cabo', 'creator.parentId', 'cabo.id')
    .select(
      'voters.id',
      'voters.name',
      'voters.city',
      'voters.zone',
      'voters.section',
      'creator.name as creatorName',
      'creator.role as creatorRole',
      'cabo.name as caboName'
    )
    .whereNotNull('voters.zone')
    .whereNotNull('voters.section');

  const { year = 2026, turn = 1 } = req.query;

  // Obter votos TSE por zona/secao
  const tseRows = await knex('election_results')
    .where({ year, turn, source: 'TSE' })
    .whereIn('candidateName', ['KEIVILANNY DIAS MOURA GONÇALVES', 'ERICA AMORIM'])
    .select('candidateName', 'city', 'zone', 'section')
    .sum('votes as total')
    .groupBy('candidateName', 'city', 'zone', 'section');

  const tseMap = new Map();
  for (const r of tseRows) {
    const key = `${r.zone}-${r.section}`;
    if (!tseMap.has(key)) tseMap.set(key, { keivia: 0, erika: 0 });
    const entry = tseMap.get(key);
    if (r.candidateName === 'KEIVILANNY DIAS MOURA GONÇALVES') entry.keivia = Number(r.total) || 0;
    if (r.candidateName === 'ERICA AMORIM') entry.erika = Number(r.total) || 0;
  }

  // Contar cadastros na mesma secao
  const countMap = new Map();
  for (const v of voters) {
    const key = `${v.zone}-${v.section}`;
    countMap.set(key, (countMap.get(key) || 0) + 1);
  }

  const result = voters.map(v => {
    const key = `${v.zone}-${v.section}`;
    const tse = tseMap.get(key) || { keivia: 0, erika: 0 };
    return {
      ...v,
      subcaboName: v.creatorRole === 'SUBCABO' ? v.creatorName : null,
      caboFinalName: v.creatorRole === 'CABO' ? v.creatorName : v.caboName,
      cadastrosSecao: countMap.get(key) || 0,
      tseKeivia: tse.keivia,
      tseErika: tse.erika
    };
  });

  res.json({ items: result });
});

module.exports = router;
