// Backfill one-shot: preenche city/neighborhood/state dos eleitores que estão
// sem city. Idempotente: só toca em linhas com city IS NULL; na 2ª execução
// não há nada. Não sobrescreve nenhum campo já preenchido.
//
// FASE 1 — zone+section presentes: espelha inferCityFromZoneSection
// (api/src/routes/voters.js): 1) tabela oficial TRE-CE (ce-secoes.json);
// 2) fallback = cidade/bairro/state predominantes (mais frequentes) entre os
// eleitores JÁ cadastrados com city para a mesma zona+seção.
//
// FASE 2 — residuais da fase 1 (causa diagnosticada: seção com typo — o par
// zona+seção não existe na tabela oficial, ex. zona 116 seção 287 — ou zona
// inválida, ex. 359):
//   2a) bairro → cidade: cidade mais frequente para o bairro normalizado na
//       tabela oficial; fallback = cidade predominante entre eleitores já
//       cadastrados com city e esse bairro. Preenche city (+ state CE se
//       NULL); neighborhood fica como está.
//   2b) zona → cidade única: se uma zona da tabela oficial só tem UMA cidade
//       distinta em todas as seções, qualquer eleitor dessa zona recebe essa
//       cidade (typo de seção não muda a cidade). Preenche city (+ state CE
//       se NULL); neighborhood fica como está.
//
// Uso: node prisma/backfill-cities.js
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const secoesCE = require('../src/data/ce-secoes.json');

const BATCH_LOG = 500;

// Mesma normalização de voters.js: remove não-dígitos e converte pra Number.
function normNum(v) {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/\D/g, ''));
  return Number.isInteger(n) ? n : null;
}

// Mapa "zona-secao" -> { city, neighborhood, state, fonte } a partir da tabela oficial.
const zonaSecaoToLocal = new Map();
for (const row of secoesCE) {
  zonaSecaoToLocal.set(`${Number(row.z)}-${Number(row.s)}`, {
    city: row.c,
    neighborhood: row.b,
    state: 'CE',
    fonte: 'TRE-CE',
  });
}

// Mapa "zona-secao" -> { city, neighborhood, state, fonte: 'frequente' } com o
// par city/bairro/state mais frequente entre eleitores com city preenchida
// (mesmo comportamento do fallback em inferCityFromZoneSection: groupBy +
// orderBy total desc, limit 1).
async function buildPredominantMap() {
  const rows = await prisma.$queryRaw`
    SELECT zone, section, state, city, neighborhood, count(*)::int AS total
    FROM voters
    WHERE city IS NOT NULL AND zone IS NOT NULL AND section IS NOT NULL
    GROUP BY zone, section, state, city, neighborhood
    ORDER BY zone, section, total DESC`;
  const map = new Map();
  for (const r of rows) {
    const z = normNum(r.zone);
    const s = normNum(r.section);
    if (z === null || s === null) continue;
    const key = `${z}-${s}`;
    if (!map.has(key)) {
      map.set(key, {
        city: r.city,
        neighborhood: r.neighborhood,
        state: r.state,
        fonte: 'frequente',
      });
    }
  }
  return map;
}

function infer(zone, section, predominant) {
  const z = normNum(zone);
  const s = normNum(section);
  if (z === null || s === null) return null;
  return zonaSecaoToLocal.get(`${z}-${s}`) || predominant.get(`${z}-${s}`) || null;
}

// ---------- FASE 2: helpers ----------
// Mesma normalização de voters.js (normLookup): NFD, remove diacríticos,
// maiúsculas, trim.
function normBairro(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();
}

// Cidade mais frequente de um Map(city -> count); empate quebra alfabético
// pra ser determinístico.
function mostFrequentCity(counts) {
  let best = null;
  for (const [city, count] of counts) {
    if (
      best === null ||
      count > best.count ||
      (count === best.count && city < best.city)
    ) {
      best = { city, count };
    }
  }
  return best ? best.city : null;
}

// 2a) bairro (normalizado) -> cidade mais frequente na tabela oficial.
function buildBairroCityFromTre() {
  const perBairro = new Map(); // normBairro -> Map(city -> count)
  for (const row of secoesCE) {
    if (!row.c || !row.b) continue;
    const key = normBairro(row.b);
    if (!key) continue;
    if (!perBairro.has(key)) perBairro.set(key, new Map());
    const counts = perBairro.get(key);
    counts.set(row.c, (counts.get(row.c) || 0) + 1);
  }
  const map = new Map();
  for (const [key, counts] of perBairro) map.set(key, mostFrequentCity(counts));
  return map;
}

// 2a) fallback: bairro (normalizado) -> cidade predominante entre eleitores
// já cadastrados com city e esse bairro.
async function buildBairroCityFromVoters() {
  const rows = await prisma.$queryRaw`
    SELECT neighborhood, city, count(*)::int AS total
    FROM voters
    WHERE city IS NOT NULL AND neighborhood IS NOT NULL
    GROUP BY neighborhood, city`;
  const perBairro = new Map();
  for (const r of rows) {
    const key = normBairro(r.neighborhood);
    if (!key) continue;
    if (!perBairro.has(key)) perBairro.set(key, new Map());
    const counts = perBairro.get(key);
    counts.set(r.city, (counts.get(r.city) || 0) + r.total);
  }
  const map = new Map();
  for (const [key, counts] of perBairro) map.set(key, mostFrequentCity(counts));
  return map;
}

// 2b) zona -> cidade única: zonas da tabela oficial com exatamente UMA cidade
// distinta em todas as suas seções.
function buildZoneSingleCity() {
  const perZone = new Map(); // zona -> Set(cidade)
  for (const row of secoesCE) {
    if (!row.c) continue;
    const z = Number(row.z);
    if (!Number.isInteger(z)) continue;
    if (!perZone.has(z)) perZone.set(z, new Set());
    perZone.get(z).add(row.c);
  }
  const map = new Map();
  let single = 0;
  let multi = 0;
  for (const [z, cities] of perZone) {
    if (cities.size === 1) {
      map.set(z, [...cities][0]);
      single += 1;
    } else {
      multi += 1;
    }
  }
  return { map, single, multi };
}

async function main() {
  const predominant = await buildPredominantMap();
  console.log(`Tabela TRE-CE: ${zonaSecaoToLocal.size} chaves zona-seção.`);
  console.log(`Fallback 'frequente': ${predominant.size} chaves zona-seção.`);

  const candidates = await prisma.voter.findMany({
    where: { city: null, zone: { not: null }, section: { not: null } },
    select: { id: true, zone: true, section: true, neighborhood: true, state: true },
  });
  console.log(`Candidatos ao backfill (city IS NULL, zone+section presentes): ${candidates.length}`);

  let viaTre = 0;
  let viaFreq = 0;
  let unresolved = 0;
  let processed = 0;

  for (const v of candidates) {
    const local = infer(v.zone, v.section, predominant);
    if (local) {
      // city está NULL por construction do filtro; neighborhood/state só se
      // também estiverem NULL (não sobrescreve nada já preenchido).
      await prisma.voter.update({
        where: { id: v.id },
        data: {
          city: local.city,
          ...(v.neighborhood === null ? { neighborhood: local.neighborhood } : {}),
          ...(v.state === null ? { state: local.state } : {}),
        },
      });
      if (local.fonte === 'TRE-CE') viaTre += 1;
      else viaFreq += 1;
    } else {
      unresolved += 1;
    }
    processed += 1;
    if (processed % BATCH_LOG === 0) {
      console.log(`Progresso: ${processed}/${candidates.length} (TRE-CE: ${viaTre}, frequente: ${viaFreq}, não resolvidos: ${unresolved})`);
    }
  }

  console.log(`Resumo fase 1: total=${candidates.length}, TRE-CE=${viaTre}, frequente=${viaFreq}, não resolvidos=${unresolved}`);

  // ---------- FASE 2a: bairro → cidade ----------
  const bairroTre = buildBairroCityFromTre();
  const bairroVot = await buildBairroCityFromVoters();
  console.log(`Fase 2a — mapa bairro→cidade: TRE-CE ${bairroTre.size} bairros, eleitores ${bairroVot.size} bairros.`);

  const candBairro = await prisma.voter.findMany({
    where: { city: null, neighborhood: { not: null } },
    select: { id: true, neighborhood: true, state: true },
  });
  let filledByBairro = 0;
  for (const v of candBairro) {
    const key = normBairro(v.neighborhood);
    const city = bairroTre.get(key) || bairroVot.get(key) || null;
    if (!city) continue;
    await prisma.voter.update({
      where: { id: v.id },
      data: { city, ...(v.state === null ? { state: 'CE' } : {}) },
    });
    filledByBairro += 1;
  }
  console.log(`Fase 2a — preenchidos por bairro: ${filledByBairro} (de ${candBairro.length} candidatos).`);

  // ---------- FASE 2b: zona → cidade única ----------
  const { map: zoneSingleCity, single, multi } = buildZoneSingleCity();
  console.log(`Fase 2b — zonas na tabela oficial: ${single} com cidade única, ${multi} multi-cidade.`);

  const candZone = await prisma.voter.findMany({
    where: { city: null, zone: { not: null } },
    select: { id: true, zone: true, state: true },
  });
  let filledByZoneUnique = 0;
  for (const v of candZone) {
    const z = normNum(v.zone);
    if (z === null) continue;
    const city = zoneSingleCity.get(z);
    if (!city) continue;
    await prisma.voter.update({
      where: { id: v.id },
      data: { city, ...(v.state === null ? { state: 'CE' } : {}) },
    });
    filledByZoneUnique += 1;
  }
  console.log(`Fase 2b — preenchidos por zona com cidade única: ${filledByZoneUnique} (de ${candZone.length} candidatos).`);

  // ---------- Residual: o que ficou sem city depois de tudo ----------
  const still = await prisma.voter.findMany({
    where: { city: null },
    select: { id: true, zone: true, section: true, neighborhood: true },
  });
  const withPair = still.filter((v) => normNum(v.zone) !== null && normNum(v.section) !== null).length;
  const withNeigh = still.filter((v) => v.neighborhood !== null).length;
  console.log(`Residual — city ainda NULL: ${still.length} (com zona+seção: ${withPair}, com bairro: ${withNeigh}).`);
  if (still.length > 0) {
    console.log('Amostra dos residuais (até 10):');
    for (const v of still.slice(0, 10)) {
      console.log(`  id=${v.id} zona=${v.zone ?? '—'} seção=${v.section ?? '—'} bairro=${v.neighborhood ?? '—'}`);
    }
  }
  console.log(`Resumo fase 2: filledByBairro=${filledByBairro}, filledByZoneUnique=${filledByZoneUnique}, stillUnresolved=${still.length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());