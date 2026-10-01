// Backfill one-shot: preenche city/neighborhood/state dos eleitores que têm
// zone+section mas estão sem city. Espelha inferCityFromZoneSection
// (api/src/routes/voters.js): 1) tabela oficial TRE-CE (ce-secoes.json);
// 2) fallback = cidade/bairro/state predominantes (mais frequentes) entre os
// eleitores JÁ cadastrados com city para a mesma zona+seção.
//
// Idempotente: só toca em linhas com city IS NULL; na 2ª execução não há nada.
// Não sobrescreve nenhum campo já preenchido.
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

  console.log(`Resumo: total=${candidates.length}, TRE-CE=${viaTre}, frequente=${viaFreq}, não resolvidos=${unresolved}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());