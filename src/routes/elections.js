// Resultados eleitorais: painel "Principais Cidades" (total = VOTOS) e
// cruzamento eleição passada (TSE, ElectionResult) vs atual (intenção dos
// eleitores cadastrados, Voter.candidateId). Agregações via Knex.
const { Router } = require('express');
const PDFDocument = require('pdfkit');
const knex = require('../db/knex');
const { requireRole } = require('../middleware/auth');
const { buildComparisonRows } = require('../lib/electionComparison');
const { buildElectionReport } = require('../lib/electionReport');
const { buildElectionIntelligenceReport, buildCaboSummaryModel } = require('../lib/electionIntelligenceReport');
const { buildMissingVoterRows } = require('../lib/missingVoterReport');
const { addPdfPageNumbers } = require('../lib/pdfPageNumbers');

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

function matchesNumberFilter(value, filter) {
  const rawFilter = String(filter ?? '').trim();
  if (!rawFilter) return true;
  if (!/^\d+$/.test(rawFilter)) return false;
  return Number.parseInt(String(value ?? '').trim(), 10) === Number.parseInt(rawFilter, 10);
}

async function resolveTeamFilterLabels(caboId, subcaboId) {
  const [cabo, subcabo] = await Promise.all([
    caboId ? knex('users').where({ id: caboId }).first('name') : null,
    subcaboId ? knex('users').where({ id: subcaboId }).first('name') : null,
  ]);
  return {
    cabo: cabo?.name || (caboId ? `ID ${caboId}` : ''),
    subcabo: subcabo?.name || (subcaboId ? `ID ${subcaboId}` : ''),
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
  const teamFilters = await resolveTeamFilterLabels(caboId, subcaboId);
  const teamSectionRows = await voterQuery.clone()
    .select(
      'v.city', 'v.zone', 'v.section',
      'creator.name as creatorName', 'creator.role as creatorRole', 'cabo.name as caboName'
    )
    .count('v.id as prometidos')
    .groupBy('v.city', 'v.zone', 'v.section', 'creator.name', 'creator.role', 'cabo.name');
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
  const cityFilter = String(req.query.city || '').trim().toLocaleUpperCase('pt-BR');
  if (cityFilter) rows = rows.filter((row) => String(row.city || '').toLocaleUpperCase('pt-BR').includes(cityFilter));
  if (zoneFilter) rows = rows.filter((row) => matchesNumberFilter(row.zona, zoneFilter));
  if (sectionFilter) rows = rows.filter((row) => matchesNumberFilter(row.secao, sectionFilter));

  const selectedSectionKeys = new Set(rows.map((row) => reportSectionKey(row.city, row.zona, row.secao)));
  const scopedTeamSectionRows = teamSectionRows.filter((row) => selectedSectionKeys.has(reportSectionKey(row.city, row.zone, row.section)));
  const comparison = {
    candidateName, year, office, turn, rows,
    filters: {
      ...teamFilters,
      city: String(req.query.city || '').trim(),
      zone: zoneFilter,
      section: sectionFilter,
    },
  };
  Object.defineProperty(comparison, 'teamSectionRows', { value: scopedTeamSectionRows, enumerable: false });
  return comparison;
}

async function loadMissingVoterReport(req) {
  const comparison = await loadDetailedComparison(req);
  const auditReport = buildElectionReport(comparison);
  const missingSections = auditReport.missing;
  if (!missingSections.length) return { comparison, voters: [], auditReport };

  let voterQuery = knex('voters as v')
    .leftJoin('users as creator', 'v.createdById', 'creator.id')
    .leftJoin('users as cabo', 'creator.parentId', 'cabo.id')
    .whereNotNull('v.zone')
    .whereNotNull('v.section');

  const voters = await voterQuery.select(
    'v.name', 'v.phone', 'v.city', 'v.neighborhood', 'v.zone', 'v.section',
    'creator.name as creatorName', 'creator.role as creatorRole', 'cabo.name as caboName'
  );

  return {
    comparison,
    voters: buildMissingVoterRows({ voters, missingSections }),
    auditReport,
  };
}

// Comparativo detalhado: cada linha representa cabo/subcabo + zona/seção,
// cruzando os cadastros da equipe com os votos TSE da candidata selecionada.
router.get('/comparativo-eleitores', requireRole('ADMIN'), async (req, res) => {
  const comparison = await loadDetailedComparison(req);
  res.json(comparison);
});

/**
 * Desenha uma linha de tabela com suporte a quebra de linha (word-wrap) e
 * repetição automática do cabeçalho ao trocar de página.
 * Retorna a altura real da linha desenhada.
 */
function drawWrappedTableRow(doc, values, widths, options = {}) {
  const { header = false, fontSize = 8, lineHeight = 1.3, padding = 4 } = options;
  const font = header ? 'Helvetica-Bold' : 'Helvetica';
  const fontSizePt = fontSize;
  const leading = fontSizePt * lineHeight;
  const bottomMargin = doc.page.margins.bottom;
  const pageBottom = doc.page.height - bottomMargin;
  const xStart = doc.page.margins.left;

  // Medir a altura necessária para cada célula
  doc.font(font).fontSize(fontSizePt);
  const cellHeights = values.map((value, i) => {
    const text = String(value ?? '');
    const w = widths[i] - padding * 2;
    if (!text) return leading;
    // heightOfString considera word-wrap quando width é passado
    return Math.max(leading, doc.heightOfString(text, { width: w, align: 'left', lineBreak: true }) + padding * 2);
  });
  const rowHeight = Math.max(...cellHeights);

  // Verificar se precisa de nova página ANTES de desenhar
  if (doc.y + rowHeight > pageBottom) {
    doc.addPage();
    // Redesenhar cabeçalho na nova página se esta linha for cabeçalho ou se tivermos header salvo
    if (options.headerRow && !header) {
      drawWrappedTableRow(doc, options.headerRow.values, options.headerRow.widths, { ...options.headerRow.options, header: true });
    }
  }

  const y = doc.y;
  let x = xStart;

  // Fundo do cabeçalho
  if (header) {
    doc.fillColor('#E8EEF8').rect(xStart, y, widths.reduce((a, b) => a + b, 0), rowHeight).fill();
  }

  // Desenhar texto de cada célula com word-wrap
  doc.font(font).fontSize(fontSizePt).fillColor('#111827');
  values.forEach((value, i) => {
    const cellX = x + padding;
    const cellW = widths[i] - padding * 2;
    const text = String(value ?? '');
    if (text) {
      doc.text(text, cellX, y + padding, {
        width: cellW,
        align: 'left',
        lineBreak: true,
      });
    }
    x += widths[i];
  });

  // Linha inferior
  const lineY = y + rowHeight;
  doc.moveTo(xStart, lineY)
    .lineTo(xStart + widths.reduce((a, b) => a + b, 0), lineY)
    .strokeColor(header ? '#94A3B8' : '#E2E8F0')
    .lineWidth(header ? 1 : 0.5)
    .stroke();

  doc.y = lineY;
  return rowHeight;
}

/**
 * Desenha uma tabela completa com cabeçalho que repete nas páginas seguintes.
 * rows = array de arrays de valores (strings/números)
 */
function drawFullTable(doc, headers, rows, widths, options = {}) {
  const { headerFontSize = 8, bodyFontSize = 7.5, headerBg = '#E8EEF8', altRowBg = '#F8FAFC' } = options;

  // Guardar info do cabeçalho para repetir em novas páginas
  const headerInfo = { values: headers, widths, options: { header: true, fontSize: headerFontSize } };

  // Desenhar cabeçalho
  drawWrappedTableRow(doc, headers, widths, { header: true, fontSize: headerFontSize, ...options });

  // Desenhar linhas do corpo
  rows.forEach((row, rowIndex) => {
    // Fundo alternado
    if (rowIndex % 2 === 1 && altRowBg) {
      const yBefore = doc.y;
      const rowH = drawWrappedTableRow(doc, row, widths, { fontSize: bodyFontSize, headerRow: headerInfo, ...options });
      // Pintar fundo depois de saber a altura (pdfkit não suporta bem rect atrás do texto já escrito)
      // Alternativa: medir antes e desenhar rect antes do texto
    } else {
      drawWrappedTableRow(doc, row, widths, { fontSize: bodyFontSize, headerRow: headerInfo, ...options });
    }
  });
}

/**
 * Versão melhorada que mede altura primeiro, desenha fundo, depois texto
 */
function drawTableWithBackground(doc, headers, rows, widths, options = {}) {
  const { headerFontSize = 8, bodyFontSize = 7.5, headerBg = '#E8EEF8', altRowBg = '#F8FAFC', padding = 3 } = options;
  const pageBottom = doc.page.height - doc.page.margins.bottom;
  const totalWidth = widths.reduce((a, b) => a + b, 0);
  const xStart = doc.page.margins.left;

  function measureRowHeight(values, fontSize, isHeader = false) {
    doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
    return Math.max(...values.map((value, i) => {
      const text = String(value ?? '');
      const w = widths[i] - padding * 2;
      if (!text) return fontSize * 1.3;
      return Math.max(fontSize * 1.3, doc.heightOfString(text, { width: w, align: 'left', lineBreak: true }) + padding * 2);
    }));
  }

  function drawRow(values, fontSize, isHeader, rowIdx) {
    const rowHeight = measureRowHeight(values, fontSize, isHeader);

    // Nova página se não couber
    if (doc.y + rowHeight > pageBottom) {
      doc.addPage();
      // Redesenhar cabeçalho
      const headerY = doc.y;
      const h = measureRowHeight(headers, headerFontSize, true);
      doc.fillColor(headerBg).rect(xStart, headerY, totalWidth, h).fill();
      doc.font('Helvetica-Bold').fontSize(headerFontSize).fillColor('#111827');
      let hx = xStart;
      headers.forEach((hv, i) => {
        doc.text(String(hv), hx + padding, headerY + padding, { width: widths[i] - padding * 2, align: options.alignments?.[i] || 'left', lineBreak: true });
        hx += widths[i];
      });
      doc.moveTo(xStart, headerY + h).lineTo(xStart + totalWidth, headerY + h).strokeColor('#94A3B8').lineWidth(1).stroke();
      doc.y = headerY + h;
    }

    const y = doc.y;
    // Fundo da linha
    if (isHeader) {
      doc.fillColor(headerBg).rect(xStart, y, totalWidth, rowHeight).fill();
    } else if (rowIdx % 2 === 1 && altRowBg) {
      doc.fillColor(altRowBg).rect(xStart, y, totalWidth, rowHeight).fill();
    }

    // Texto
    doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize).fillColor('#111827');
    let cx = xStart;
    values.forEach((value, i) => {
      doc.text(String(value ?? ''), cx + padding, y + padding, {
        width: widths[i] - padding * 2,
        align: options.alignments?.[i] || 'left',
        lineBreak: true,
      });
      cx += widths[i];
    });

    // Linha inferior
    const lineY = y + rowHeight;
    doc.moveTo(xStart, lineY)
      .lineTo(xStart + totalWidth, lineY)
      .strokeColor(isHeader ? '#94A3B8' : '#E2E8F0')
      .lineWidth(isHeader ? 1 : 0.5)
      .stroke();

    doc.y = lineY;
  }

  // Cabeçalho
  drawRow(headers, headerFontSize, true, -1);
  // Corpo
  rows.forEach((row, idx) => drawRow(row, bodyFontSize, false, idx));
  doc.x = xStart;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('pt-BR');
}

function reportSectionKey(city, zone, section) {
  const normalizeNumber = (value, width) => {
    const parsed = Number.parseInt(String(value ?? '').trim(), 10);
    return Number.isFinite(parsed) ? String(parsed).padStart(width, '0') : '';
  };
  return `${String(city || '').trim().toLocaleUpperCase('pt-BR')}|${normalizeNumber(zone, 2)}|${normalizeNumber(section, 4)}`;
}

function compactPdfValue(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function formatPercent(value) {
  return `${Number(value || 0).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function compactCityNames(values = []) {
  const names = [...new Set(values.map((value) => compactPdfValue(value)).filter(Boolean))];
  if (names.length <= 3) return names.join(', ') || '-';
  return `${names.slice(0, 3).join(', ')} + ${formatNumber(names.length - 3)} outras`;
}

function formatReportFilters(filters = {}) {
  const labels = [
    ['Cabo', filters.cabo], ['Subcabo', filters.subcabo], ['Cidade', filters.city],
    ['Zona', filters.zone], ['Seção', filters.section],
  ].filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
    .map(([label, value]) => `${label}: ${compactPdfValue(value)}`);
  return labels.length ? `Filtros - ${labels.join(' | ')}` : 'Filtros - todos os cabos, cidades, zonas e seções';
}

function drawIntelligenceHeader(doc, report, title, reportType) {
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#18344B').text(title, { width, lineGap: 2 });
  doc.font('Helvetica').fontSize(9).fillColor('#475569')
    .text(`Candidato: ${compactPdfValue(report.candidateName) || 'Não informado'} | ${report.office} | ${report.year} | ${report.turn}º turno`, { width })
    .text(`Cabo: ${report.filters?.cabo || 'Todos'} | Subcabo: ${report.filters?.subcabo || 'Todos'}`, { width })
    .text(`Tipo: ${reportType} | ${formatReportFilters(report.filters)}`, { width })
    .text(`Gerado em ${new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`, { width });
  doc.moveDown(0.45);
}

function drawMetricCards(doc, metrics, options = {}) {
  const { gap = 6, height = 48, fontSize = 17 } = options;
  const xStart = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cardWidth = (width - gap * (metrics.length - 1)) / metrics.length;
  const y = doc.y;
  metrics.forEach((metric, index) => {
    const x = xStart + index * (cardWidth + gap);
    doc.roundedRect(x, y, cardWidth, height, 5).fill(metric.background || '#F0F5F9');
    const displayValue = typeof metric.value === 'number' ? formatNumber(metric.value) : String(metric.value ?? '0');
    doc.font('Helvetica-Bold').fontSize(fontSize).fillColor(metric.color || '#18344B')
      .text(displayValue, x + 4, y + 6, { width: cardWidth - 8, align: 'center', lineBreak: false });
    doc.font('Helvetica').fontSize(7.5).fillColor('#52677A')
      .text(metric.label, x + 4, y + height - 17, { width: cardWidth - 8, align: 'center', lineBreak: false });
  });
  doc.y = y + height + 8;
  doc.x = xStart;
}

function drawReportBand(doc, text, color = '#B74343') {
  const x = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const y = doc.y;
  doc.font('Helvetica-Bold').fontSize(11);
  const height = Math.max(26, doc.heightOfString(text, { width: width - 20 }) + 12);
  if (y + height > doc.page.height - doc.page.margins.bottom) doc.addPage();
  const top = doc.y;
  doc.rect(x, top, width, height).fill(color);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#FFFFFF')
    .text(text, x + 10, top + 7, { width: width - 20 });
  doc.y = top + height + 8;
  doc.x = x;
}

function drawIntelligenceSection(doc, cabo, subcabo, city, bairro, section) {
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const x = doc.page.margins.left;
  const label = `CABO: ${cabo.cabo}  |  SUBCABO: ${subcabo.subcabo} (${formatNumber(subcabo.prometidos)} promessas)`;
  if (doc.y > doc.page.height - 92) doc.addPage();
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#18344B').text(label, { width });
  doc.font('Helvetica').fontSize(9).fillColor('#334155')
    .text(`Cidade: ${city.city} (${formatNumber(city.prometidos)} promessas)  >  Bairro: ${bairro.bairro} (${formatNumber(bairro.prometidos)} promessas)  >  Zona: ${section.zona}  >  Seção: ${section.secao}`, { width });

  if (section.compartilhada) {
    const teams = section.equipes.map((team) => [team.cabo, team.subcabo].filter(Boolean).join(' / ') || 'Cadastro direto').join(', ');
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#9A3412')
      .text(`SEÇÃO COMPARTILHADA (${teams}). A lista abaixo é deste grupo; o resumo é da seção inteira e entra uma única vez nos totais globais.`, { width });
  }

  doc.moveDown(0.2);
  const tableWidths = [width * 0.78, width * 0.22];
  const names = section.eleitores.map((name) => [name || 'Eleitor sem nome', '1 voto prometido']);
  drawTableWithBackground(doc, ['PESSOAS CADASTRADAS NESTE GRUPO / SEÇÃO', 'PROMETEU'], names, tableWidths, {
    headerFontSize: 8,
    bodyFontSize: 9,
    padding: 4,
    alignments: ['left', 'right'],
  });

  if (doc.y > doc.page.height - doc.page.margins.bottom - 60) doc.addPage();
  drawMetricCards(doc, [
    { value: section.eleitores.length, label: 'PESSOAS NESTE GRUPO' },
    { value: section.prometidosSecao, label: 'PROMESSAS NA SEÇÃO' },
    { value: section.apurado, label: 'VOTOS NA SEÇÃO (TSE)' },
    { value: section.faltantes, label: 'VOTOS FALTANTES', color: '#B74343', background: '#FFF1F0' },
    { value: formatPercent(section.percentualVotos), label: 'COBERTURA NUMÉRICA' },
  ], { height: 45, fontSize: 14, gap: 4 });
  doc.moveDown(0.25);
}

function walkIntelligenceSections(doc, report, missing) {
  let drawn = 0;
  for (const cabo of report.hierarchy || []) {
    for (const subcabo of cabo.subcabos) {
      for (const city of subcabo.cidades) {
        for (const bairro of city.bairros) {
          const sections = missing ? bairro.secoesComFaltas : bairro.demaisSecoes;
          for (const section of sections) {
            drawIntelligenceSection(doc, cabo, subcabo, city, bairro, section);
            drawn += 1;
          }
        }
      }
    }
  }
  if (!drawn) {
    doc.font('Helvetica').fontSize(10).fillColor('#52677A')
      .text(missing ? 'Nenhuma seção com diferença positiva entre promessas e apuração oficial.' : 'Nenhuma outra seção encontrada para os filtros aplicados.');
  }
  return drawn;
}

function sendMissingReportPdf(res, report, meta) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="relatorio-votos-faltantes.pdf"');
  doc.pipe(res);

  const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  drawIntelligenceHeader(doc, report, 'RELATÓRIO GERAL - AUDITORIA POR EQUIPE E SEÇÃO', 'Relatório geral de votos prometidos e apuração TSE');
  drawMetricCards(doc, [
    { value: report.totalCadastrados, label: 'VOTOS PROMETIDOS' },
    { value: report.totalApurado, label: 'VOTOS TSE (SEÇÕES ÚNICAS)' },
    { value: report.totalConfirmados, label: 'CONFIRMADOS' },
    { value: report.totalFaltantes, label: 'VOTOS FALTANTES', color: '#B74343', background: '#FFF1F0' },
    { value: formatPercent(report.totalCadastrados ? report.totalConfirmados * 100 / report.totalCadastrados : 0), label: 'COBERTURA NUMÉRICA' },
  ], { height: 48, fontSize: 15 });
  doc.font('Helvetica').fontSize(8.5).fillColor('#52677A')
    .text('Critério: faltantes = máximo(prometidos - apurado, 0); confirmados = mínimo(prometidos, apurado). Votos TSE são contados uma vez por cidade, zona e seção.');
  doc.moveDown(0.45);

  // Resumo por cabo e subcabo
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#0F172A').text('Resumo por cabo e subcabo');
  doc.moveDown(0.3);
  const summaryWidths = [usable * 0.27, usable * 0.27, usable * 0.14, usable * 0.14, usable * 0.18];
  const summaryRows = report.summary.map(row => [
    row.cabo || '-', row.subcabo || '-', formatNumber(row.cadastrados),
    formatNumber(row.secoes), formatNumber(row.secoesComFaltantes)
  ]);
  if (summaryRows.length) {
    drawTableWithBackground(doc, ['Cabo', 'Subcabo', 'Prometidos', 'Seções', 'Seções com faltantes'], summaryRows, summaryWidths);
  } else {
    doc.font('Helvetica').fontSize(9).fillColor('#52677A').text('Nenhuma equipe encontrada para os filtros aplicados.', { width: usable });
  }

  doc.moveDown(1);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#0F172A').text('Detalhamento por zona e seção');
  doc.moveDown(0.3);
  const detailWidths = [usable * 0.17, usable * 0.10, usable * 0.06, usable * 0.06, usable * 0.09, usable * 0.09, usable * 0.09, usable * 0.07, usable * 0.08, usable * 0.07, usable * 0.12];
  const detailRows = report.details.map(row => [
    row.teams.map((team) => [team.cabo, team.subcabo].filter(Boolean).join(' / ') || 'Cadastro direto').join(', '),
    row.city || '-', row.zona, row.secao,
    formatNumber(row.cadastrados), formatNumber(row.apurado), formatNumber(row.confirmados),
    formatNumber(row.faltantes), formatPercent(row.percentualFaltantes),
    row.compartilhadaEntreCabos ? 'Sim' : 'Não',
    row.apurado > row.cadastrados ? 'OK' : row.faltantes ? 'Faltam votos' : 'OK'
  ]);
  if (detailRows.length) {
    drawTableWithBackground(doc, ['Equipes associadas', 'Cidade', 'Zona', 'Seção', 'Prometidos', 'Apurado TSE', 'Confirmados', 'Faltantes', '% faltantes', 'Compartilhada', 'Status'], detailRows, detailWidths, {
      headerFontSize: 8,
      bodyFontSize: 8,
      padding: 3,
      alignments: ['left', 'left', 'center', 'center', 'right', 'right', 'right', 'right', 'right', 'center', 'center'],
    });
  } else {
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(9).fillColor('#047857').text('Nenhum cadastro encontrado.', { width: usable });
  }

  addPdfPageNumbers(doc);
  doc.end();
}

function sendMissingVotersPdf(res, report, voters, auditReport) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="relatorio-eleitores-secoes-faltantes.pdf"');
  doc.pipe(res);

  const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  drawIntelligenceHeader(doc, report, 'ELEITORES CADASTRADOS NAS SEÇÕES COM FALTA', 'Listagem nominal das seções abaixo da meta');
  drawMetricCards(doc, [
    { value: auditReport.totalCadastrados, label: 'VOTOS PROMETIDOS' },
    { value: auditReport.totalApurado, label: 'VOTOS TSE (SEÇÕES ÚNICAS)' },
    { value: auditReport.totalFaltantes, label: 'FALTANTES', color: '#B74343', background: '#FFF1F0' },
    { value: formatPercent(auditReport.totalCadastrados ? auditReport.totalConfirmados * 100 / auditReport.totalCadastrados : 0), label: 'COBERTURA NUMÉRICA' },
  ], { height: 46, fontSize: 14 });
  doc.font('Helvetica').fontSize(9).fillColor('#475569')
    .text(`${voters.length} eleitor(es). A diferença é da seção; este relatório não identifica individualmente quem compareceu.`);
  doc.moveDown(0.35);

  const widths = [usable * 0.16, usable * 0.09, usable * 0.10, usable * 0.10, usable * 0.10, usable * 0.10, usable * 0.06, usable * 0.06, usable * 0.08, usable * 0.15];
  const rows = voters.map(v => [
    v.name, v.phone, v.city || '-', v.neighborhood || '-',
    v.cabo || '-', v.subcabo || '-', v.zona, v.secao, v.compartilhada ? 'Sim' : 'Não', 'Seção abaixo da meta'
  ]);
  drawTableWithBackground(doc, ['Eleitor', 'Telefone', 'Cidade', 'Bairro', 'Cabo', 'Subcabo', 'Zona', 'Seção', 'Compartilhada', 'Situação da seção'], rows, widths);
  if (!voters.length) {
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(9).fillColor('#047857').text('Nenhum eleitor encontrado nas seções abaixo da meta.');
  }
  addPdfPageNumbers(doc);
  doc.end();
}

function sendElectionIntelligencePdf(res, report) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="possiveis-nao-votantes-detalhado.pdf"');
  doc.pipe(res);
  drawIntelligenceHeader(doc, report, 'POSSÍVEIS NÃO VOTANTES - DIVERGÊNCIAS POR SEÇÃO', 'Detalhado por cabo, subcabo e seção');
  doc.font('Helvetica').fontSize(9).fillColor('#334155')
    .text('A diferença e a cobertura aparecem junto de cada seção e consideram todos os cadastros nela. O TSE informa somente o total da seção e não identifica quem votou. Seções compartilhadas entre cabos são identificadas e listadas uma única vez.');
  doc.moveDown(0.6);

  drawReportBand(doc, '1º: POSSÍVEIS NÃO VOTANTES - SEÇÕES COM VOTOS INSUFICIENTES');
  walkIntelligenceSections(doc, report, true);
  drawReportBand(doc, '2º: DEMAIS SEÇÕES - SEM FALTA NUMÉRICA', '#607D91');
  walkIntelligenceSections(doc, report, false);
  doc.moveDown(0.5);
  doc.font('Helvetica').fontSize(8).fillColor('#52677A')
    .text('Critério: faltantes = máximo(promessas totais da seção - votos TSE, 0); cobertura = mínimo(promessas totais da seção, votos TSE) / promessas totais da seção. Seções acima do apurado não são tratadas como divergência negativa.');
  addPdfPageNumbers(doc);
  doc.end();
}

function sendCaboSummaryPdf(res, report) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
  const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const summary = buildCaboSummaryModel(report);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="resumo-votos-por-cabo.pdf"');
  doc.pipe(res);
  drawIntelligenceHeader(doc, report, 'RELATÓRIO RESUMIDO POR CABO', 'Ranking de promessas e detalhamento das seções');
  drawReportBand(doc, 'RANKING DE CABOS - MAIOR PARA MENOR NÚMERO DE PROMESSAS', '#2861A8');
  const rows = summary.cabos.map((cabo) => [
    cabo.cabo || 'Cadastro direto',
    formatNumber(cabo.prometidos),
    formatNumber(cabo.apurado),
    formatNumber(cabo.faltantes),
    formatPercent(cabo.percentualVotos),
  ]);
  if (rows.length) {
    drawTableWithBackground(doc, ['Cabo', 'Prometidos total', 'Votos TSE*', 'Faltantes*', 'Cobertura*'], rows,
      [usable * .27, usable * .18, usable * .19, usable * .18, usable * .18], {
      headerFontSize: 8.5,
      bodyFontSize: 9,
      padding: 5,
      alignments: ['left', 'right', 'right', 'right', 'right'],
    });
  } else {
    doc.font('Helvetica').fontSize(9).fillColor('#52677A').text('Nenhum cabo com cadastro para os filtros selecionados.', { width: usable });
  }

  doc.moveDown(0.35);
  doc.font('Helvetica').fontSize(8).fillColor('#52677A')
    .text('* TSE, faltantes e cobertura usam somente as seções exclusivas de cada cabo. Seções compartilhadas são mostradas abaixo uma vez, sem atribuir seus votos a um cabo.', { width: usable });

  for (const cabo of summary.cabos) {
    const hierarchy = (report.hierarchy || []).find((row) => row.cabo === cabo.cabo);
    if (!hierarchy) continue;
    if (doc.y > doc.page.height - 150) doc.addPage();
    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(15).fillColor('#18344B')
      .text(`CABO: ${cabo.cabo} - DETALHAMENTO`, { width: usable });
    drawMetricCards(doc, [
      { value: cabo.prometidosExclusivos, label: 'PROMESSAS EXCLUSIVAS' },
      { value: cabo.apurado, label: 'VOTOS TSE EXCLUSIVOS' },
      { value: cabo.faltantes, label: 'FALTANTES EXCLUSIVOS', color: '#B74343', background: '#FFF1F0' },
      { value: formatPercent(cabo.percentualVotos), label: 'COBERTURA EXCLUSIVA' },
    ], { height: 55, fontSize: 16, gap: 0 });
    if (cabo.prometidosCompartilhados) {
      doc.font('Helvetica').fontSize(8).fillColor('#9A3412')
        .text(`Total cadastrado neste cabo: ${formatNumber(cabo.prometidos)} promessas. Outras ${formatNumber(cabo.prometidosCompartilhados)} estão em seções compartilhadas e ficam fora dos indicadores exclusivos abaixo.`, { width: usable });
    }

    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#18344B').text('SUBCABOS POR VOTOS PROMETIDOS', { width: usable });
    const subcaboRows = cabo.subcabos.map((subcabo) => [
      subcabo.subcabo || 'Cadastro direto', formatNumber(subcabo.prometidos), formatNumber(subcabo.secoes),
      formatNumber(subcabo.apurado), formatNumber(subcabo.faltantes),
    ]);
    if (subcaboRows.length) {
      drawTableWithBackground(doc, ['Subcabo', 'Promessas', 'Seções', 'Votos TSE*', 'Faltantes*'], subcaboRows,
        [usable * .29, usable * .17, usable * .14, usable * .2, usable * .2], {
          headerFontSize: 8,
          bodyFontSize: 8.5,
          padding: 4,
          alignments: ['left', 'right', 'right', 'right', 'right'],
        });
    } else {
      doc.font('Helvetica').fontSize(8.5).fillColor('#52677A').text('Nenhum subcabo cadastrado para este cabo.', { width: usable });
    }
    doc.font('Helvetica').fontSize(7.5).fillColor('#52677A')
      .text('* TSE e faltantes dos subcabos usam somente seções exclusivas daquele subcabo.', { width: usable });

    const caboSections = summary.sections.filter((section) => section.teams.some((team) => team.cabo === cabo.cabo));
    const orderedSections = [...caboSections].sort((a, b) => (
      Number(b.faltantes > 0) - Number(a.faltantes > 0)
      || b.faltantes - a.faltantes
      || b.prometidos - a.prometidos
      || a.city.localeCompare(b.city, 'pt-BR')
      || Number(a.zona) - Number(b.zona)
      || Number(a.secao) - Number(b.secao)
    ));
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#18344B')
      .text('SEÇÕES COM DIFERENÇA PRIMEIRO; DEMAIS DEPOIS', { width: usable });
    const sectionRows = orderedSections.map((section) => [
      `${section.teams.filter((team) => team.cabo === cabo.cabo).map((team) => team.subcabo || 'Cadastro direto').join(', ')} / ${section.city} / ${section.bairros.join(', ') || 'Bairro não informado'}`,
      section.zona, section.secao, formatNumber(section.prometidos), formatNumber(section.apurado), formatNumber(section.faltantes),
    ]);
    if (sectionRows.length) {
      drawTableWithBackground(doc, ['Subcabo / Cidade / Bairro', 'Zona', 'Seção', 'Prom.', 'TSE', 'Faltam'], sectionRows,
        [usable * .36, usable * .12, usable * .12, usable * .12, usable * .12, usable * .16], {
          headerFontSize: 7.5,
          bodyFontSize: 8,
          padding: 3,
          alignments: ['left', 'center', 'center', 'right', 'right', 'right'],
        });
    } else {
      doc.font('Helvetica').fontSize(8.5).fillColor('#52677A').text('Nenhuma seção exclusiva encontrada para este cabo.', { width: usable });
    }
  }

  drawReportBand(doc, 'SEÇÕES COMPARTILHADAS ENTRE CABOS - CONTADAS UMA ÚNICA VEZ', '#8A5A24');
  const sharedRows = summary.sharedSections.map((section) => [
    section.teams.map((team) => [team.cabo, team.subcabo].filter(Boolean).join(' / ') || 'Cadastro direto').join(', '),
    section.city || '-', section.bairros.join(', ') || 'Bairro não informado', section.zona, section.secao,
    formatNumber(section.prometidos), formatNumber(section.apurado), formatNumber(section.faltantes), formatPercent(section.percentualVotos),
  ]);
  if (sharedRows.length) {
    drawTableWithBackground(doc,
      ['Cabos / subcabos', 'Cidade', 'Bairro(s)', 'Zona', 'Seção', 'Prometidos', 'TSE', 'Faltantes', 'Cobertura'],
      sharedRows,
      [usable * .18, usable * .11, usable * .14, usable * .07, usable * .07, usable * .11, usable * .11, usable * .1, usable * .11],
      { headerFontSize: 7.5, bodyFontSize: 8, padding: 3, alignments: ['left', 'left', 'left', 'center', 'center', 'right', 'right', 'right', 'right'] }
    );
  } else {
    doc.font('Helvetica').fontSize(8).fillColor('#52677A').text('Nenhuma seção associada a mais de um cabo nos filtros selecionados.', { width: usable });
  }
  doc.moveDown(0.35);
  doc.font('Helvetica').fontSize(8).fillColor('#52677A')
    .text('Cobertura exclusiva = mínimo(promessas exclusivas, votos TSE exclusivos) / promessas exclusivas. Nas seções compartilhadas, o TSE mostra o total oficial da seção, não quantos votos pertencem a cada equipe.', { width: usable });
  addPdfPageNumbers(doc);
  doc.end();
}

function sendCaboRankingPdf(res, report) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true });
  const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="inteligencia-eleitoral-cabos.pdf"');
  doc.pipe(res);
  drawIntelligenceHeader(doc, report, 'RANKING DE CABOS E SUBCABOS', 'Classificação por votos prometidos');
  doc.font('Helvetica').fontSize(9).fillColor('#475569')
    .text('Ordenação: votos prometidos (decrescente); * identifica empate em votos prometidos. Apuração, confirmados e faltantes por equipe consideram apenas seções exclusivas; seções compartilhadas são detalhadas à parte para não duplicar votos TSE.');
  doc.moveDown(0.4);

  const widths = [usable * 0.04, usable * 0.18, usable * 0.14, usable * 0.12, usable * 0.12, usable * 0.12, usable * 0.12, usable * 0.08, usable * 0.08];
  const caboRows = report.cabos.map((cabo, index) => {
    const firstTied = report.cabos.findIndex((entry) => entry.prometidos === cabo.prometidos);
    const tied = firstTied < index;
    return [
      tied ? `${firstTied + 1}*` : index + 1, cabo.cabo || 'Cadastro direto', formatNumber(cabo.prometidos), formatNumber(cabo.apurado),
      formatNumber(cabo.votos), formatPercent(cabo.percentualVotos), formatNumber(cabo.faltantes),
      formatNumber(cabo.secoesCompartilhadas), compactCityNames(cabo.cidades)
  ];
  });
  if (caboRows.length) {
    drawTableWithBackground(doc, ['#', 'Cabo', 'Prometidos', 'TSE exclusivo', 'Confirmados exclusivos', 'Cobertura exclusiva', 'Faltantes exclusivos', 'Seções compartilhadas', 'Cidades'], caboRows, widths, {
      headerFontSize: 8,
      bodyFontSize: 9,
      padding: 4,
      alignments: ['center', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'left'],
    });
  } else {
    doc.font('Helvetica').fontSize(10).fillColor('#52677A').text('Nenhum cabo com zona e seção encontrado.', { width: usable });
  }

  for (const cabo of report.cabos) {
    if (doc.y > doc.page.height - 100) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#334155').text(`Subcabos de ${cabo.cabo || 'Cadastro direto'}`);
    doc.moveDown(0.2);
    const subWidths = [usable * 0.04, usable * 0.19, usable * 0.14, usable * 0.12, usable * 0.12, usable * 0.12, usable * 0.12, usable * 0.08, usable * 0.07];
    const subRows = cabo.subcabos.map((subcabo, subIndex) => {
      const firstTied = cabo.subcabos.findIndex((entry) => entry.prometidos === subcabo.prometidos);
      const tied = firstTied < subIndex;
      return [
        tied ? `${firstTied + 1}*` : subIndex + 1, subcabo.subcabo, formatNumber(subcabo.prometidos), formatNumber(subcabo.apurado),
        formatNumber(subcabo.votos), formatPercent(subcabo.percentualVotos),
        formatNumber(subcabo.faltantes), formatNumber(subcabo.secoesCompartilhadas), compactCityNames(subcabo.cidades)
      ];
    });
    if (subRows.length) {
      drawTableWithBackground(doc, ['#', 'Subcabo', 'Prometidos', 'TSE exclusivo', 'Confirmados exclusivos', 'Cobertura exclusiva', 'Faltantes exclusivos', 'Seções compartilhadas', 'Cidades'], subRows, subWidths, {
        headerFontSize: 8,
        bodyFontSize: 9,
        padding: 4,
        alignments: ['center', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'left'],
      });
    } else {
      doc.font('Helvetica').fontSize(9).fillColor('#52677A').text('Nenhum subcabo encontrado.', { width: usable });
    }
    doc.moveDown(0.4);
  }
  addPdfPageNumbers(doc);
  doc.end();
}

async function loadElectionIntelligenceReport(req) {
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
  const teamFilters = await resolveTeamFilterLabels(caboId, subcaboId);
  const city = String(req.query.city || '').trim();
  const zoneInput = String(req.query.zone || '').trim();
  const sectionInput = String(req.query.section || '').trim();
  const zone = /^\d+$/.test(zoneInput) ? Number.parseInt(zoneInput, 10) : Number.NaN;
  const section = /^\d+$/.test(sectionInput) ? Number.parseInt(sectionInput, 10) : Number.NaN;
  if (city) voterQuery = voterQuery.whereRaw('UPPER(TRIM(v.city)) LIKE UPPER(?)', [`%${city}%`]);
  if (Number.isFinite(zone)) voterQuery = voterQuery.where('v.zone', zone);
  if (Number.isFinite(section)) voterQuery = voterQuery.where('v.section', section);
  if ((zoneInput && !Number.isFinite(zone)) || (sectionInput && !Number.isFinite(section))) {
    voterQuery = voterQuery.whereRaw('1 = 0');
  }

  const teamSectionRows = await voterQuery.clone()
    .select(
      'v.city', 'v.neighborhood', 'v.zone', 'v.section',
      'creator.name as creatorName', 'creator.role as creatorRole', 'cabo.name as caboName'
    )
    .count('v.id as prometidos')
    .groupBy('v.city', 'v.neighborhood', 'v.zone', 'v.section', 'creator.name', 'creator.role', 'cabo.name');

  if (subcaboId) voterQuery = voterQuery.where('v.createdById', subcaboId);
  else if (caboId) {
    const subs = await knex('users').where('parentId', caboId).select('id');
    voterQuery = voterQuery.whereIn('v.createdById', [caboId, ...subs.map((row) => row.id)]);
  }

  const voters = await voterQuery.select(
    'v.name', 'v.phone', 'v.city', 'v.neighborhood', 'v.zone', 'v.section',
    'creator.name as creatorName', 'creator.role as creatorRole', 'cabo.name as caboName'
  );
  let tseQuery = knex('election_results')
    .where({ year, office, turn, source: 'TSE' })
    .whereRaw('UPPER(TRIM("candidateName")) = UPPER(?)', [candidateName]);
  if (city) tseQuery = tseQuery.whereRaw('UPPER(TRIM(city)) LIKE UPPER(?)', [`%${city}%`]);
  if (Number.isFinite(zone)) tseQuery = tseQuery.where('zone', zone);
  if (Number.isFinite(section)) tseQuery = tseQuery.where('section', section);
  if ((zoneInput && !Number.isFinite(zone)) || (sectionInput && !Number.isFinite(section))) {
    tseQuery = tseQuery.whereRaw('1 = 0');
  }
  const tseRows = await tseQuery.select('city', 'zone', 'section').sum('votes as total').groupBy('city', 'zone', 'section');
  return buildElectionIntelligenceReport({
    voters,
    teamSectionRows,
    tseRows,
    candidateName,
    year,
    office,
    turn,
    filters: {
      ...teamFilters,
      city,
      zone: zoneInput,
      section: sectionInput,
    },
  });
}

router.get('/relatorio-faltantes', requireRole('ADMIN'), async (req, res) => {
  const comparison = await loadDetailedComparison(req);
  res.json(buildElectionReport(comparison));
});

router.get('/relatorio-faltantes/eleitores', requireRole('ADMIN'), async (req, res) => {
  const { comparison, voters } = await loadMissingVoterReport(req);
  res.json({ candidateName: comparison.candidateName, voters, total: voters.length });
});

router.get('/relatorio-faltantes/eleitores/pdf', requireRole('ADMIN'), async (req, res) => {
  const { comparison, voters, auditReport } = await loadMissingVoterReport(req);
  sendMissingVotersPdf(res, comparison, voters, auditReport);
});

router.get('/relatorio-faltantes/pdf', requireRole('ADMIN'), async (req, res) => {
  const comparison = await loadDetailedComparison(req);
  const report = buildElectionReport(comparison);
  report.filters = comparison.filters;
  sendMissingReportPdf(res, report, comparison);
});

router.get('/inteligencia-eleitoral/eleitores/pdf', requireRole('ADMIN'), async (req, res) => {
  sendElectionIntelligencePdf(res, await loadElectionIntelligenceReport(req));
});

router.get('/inteligencia-eleitoral/resumo-cabos/pdf', requireRole('ADMIN'), async (req, res) => {
  sendCaboSummaryPdf(res, await loadElectionIntelligenceReport(req));
});

router.get('/inteligencia-eleitoral/cabos/pdf', requireRole('ADMIN'), async (req, res) => {
  sendCaboRankingPdf(res, await loadElectionIntelligenceReport(req));
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
