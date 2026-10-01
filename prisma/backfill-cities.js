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
// FASE 3 — residuais das fases 1/2, usando a própria base como fonte: tabela
// election_results (resultado oficial TSE 2022, source='TSE').
//   3a) par zona+seção → cidade: mapa DISTINCT de pares em election_results;
//       mesmo par mapeando 2 cidades não deveria acontecer (o par é por
//       município) — se acontecer, mantém a mais frequente e registra aviso.
//   3b) zona → cidade única: mesma lógica da 2b, mas a partir dos pares do
//       TSE (uma zona ausente na tabela TRE-CE pode aparecer aqui, e a
//       confirmação de cidade única adiciona segurança).
//   Em ambas: preenche city (+ state CE se NULL); neighborhood fica como está.
//
// FASE 4 — residuais das fases 1-3, heurísticas de diagnóstico do coordenador
// (servidor: ~152 eleitores sem city):
//   4a) zona↔seção trocadas: se o par (zona,seção) é desconhecido (tabela
//       oficial OU mapa de pares do TSE da fase 3) mas o par invertido
//       (seção,zona) é conhecido, preenche city (+ state CE se NULL) com a
//       cidade do par invertido. Pares válidos/conhecidos nunca são tocados.
//   4b) predominância por zona: entre eleitores JÁ cadastrados com city na
//       MESMA zona (qualquer seção), preenche com a cidade predominante SE
//       uma única cidade detém >=80% dos conhecidos da zona (mín. 2 eleitores)
//       OU todos concordam. Cada decisão de zona é logada (zona, cidade, n, %).
//   4c) bairro fuzzy (linhas com neighborhood não resolvidas): match exato
//       normalizado primeiro; senão, se o bairro normalizado é prefixo único e
//       não-ambíguo de exatamente UMA cidade no mapa oficial bairro→cidade
//       (todas as cidades que compartilham o prefixo idênticas), preenche;
//       senão deixa como está. Valores brutos das linhas são impressos p/
//       inspeção no servidor.
//   Em toda a fase 4: zona "lixo" (número de título com 10-14 dígitos colado
//   no campo zone, ex. 035212670752) é IGNORADA — nunca preenche nada com ela.
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

// ---------- FASE 3: helpers ----------
// 3a) par (zona,seção) -> cidade a partir de election_results. GROUP BY traz a
// contagem de linhas por cidade pra desempatar caso o mesmo par aponte para
// mais de uma cidade (mantém a mais frequente, determinístico via
// mostFrequentCity). zone/section estão como string na tabela; normaliza com
// normNum igual ao resto do script.
async function buildTsePairMap() {
  const rows = await prisma.$queryRaw`
    SELECT "zone", "section", "city", count(*)::int AS total
    FROM "election_results"
    GROUP BY "zone", "section", "city"`;
  const perPair = new Map(); // "z-s" -> Map(city -> total)
  let conflicts = 0;
  for (const r of rows) {
    const z = normNum(r.zone);
    const s = normNum(r.section);
    if (z === null || s === null || !r.city) continue;
    const key = `${z}-${s}`;
    if (!perPair.has(key)) perPair.set(key, new Map());
    const counts = perPair.get(key);
    counts.set(r.city, (counts.get(r.city) || 0) + r.total);
  }
  const map = new Map();
  for (const [key, counts] of perPair) {
    if (counts.size > 1) {
      conflicts += 1;
      console.warn(`Aviso fase 3: par ${key} mapeia para ${counts.size} cidades (${[...counts.keys()].join(', ')}) — mantendo a mais frequente.`);
    }
    map.set(key, mostFrequentCity(counts));
  }
  return { map, conflicts };
}

// 3b) zona -> cidade única a partir dos pares do TSE (mesma lógica da 2b).
function buildTseZoneSingleCity(pairMap) {
  const perZone = new Map(); // zona -> Set(cidade)
  for (const [key, city] of pairMap) {
    const z = Number(key.split('-')[0]);
    if (!perZone.has(z)) perZone.set(z, new Set());
    perZone.get(z).add(city);
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

// ---------- FASE 4: helpers ----------
// Zona "lixo": número de título (10-14 dígitos) colado por engano no campo
// zone (ex. 035212670752). Nunca preencher cidade baseado num valor desses.
function isGarbageZone(v) {
  if (v === null || v === undefined) return false;
  const digits = String(v).replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 14;
}

// 4c) contagens brutas bairro normalizado -> Map(city -> count) na tabela
// oficial (mesma construção da fase 2a, sem colapsar pra cidade mais
// frequente — necessário pra checar ambiguidade no match por prefixo).
function buildBairroCountsFromTre() {
  const perBairro = new Map(); // normBairro -> Map(city -> count)
  for (const row of secoesCE) {
    if (!row.c || !row.b) continue;
    const key = normBairro(row.b);
    if (!key) continue;
    if (!perBairro.has(key)) perBairro.set(key, new Map());
    const counts = perBairro.get(key);
    counts.set(row.c, (counts.get(row.c) || 0) + 1);
  }
  return perBairro;
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

  // ---------- FASE 3a: par zona+seção → cidade (election_results) ----------
  const { map: tsePair, conflicts } = await buildTsePairMap();
  console.log(`Fase 3 — pares zona+seção distintos em election_results: ${tsePair.size}${conflicts > 0 ? ` (${conflicts} com mais de uma cidade — mantida a mais frequente)` : ''}.`);

  const candTsePair = await prisma.voter.findMany({
    where: { city: null, zone: { not: null }, section: { not: null } },
    select: { id: true, zone: true, section: true, state: true },
  });
  let filledByTsePair = 0;
  for (const v of candTsePair) {
    const z = normNum(v.zone);
    const s = normNum(v.section);
    if (z === null || s === null) continue;
    const city = tsePair.get(`${z}-${s}`);
    if (!city) continue;
    await prisma.voter.update({
      where: { id: v.id },
      data: { city, ...(v.state === null ? { state: 'CE' } : {}) },
    });
    filledByTsePair += 1;
  }
  console.log(`Fase 3a — preenchidos por par TSE: ${filledByTsePair} (de ${candTsePair.length} candidatos).`);

  // ---------- FASE 3b: zona → cidade única (election_results) ----------
  const tseZone = buildTseZoneSingleCity(tsePair);
  console.log(`Fase 3b — zonas em election_results: ${tseZone.single} com cidade única, ${tseZone.multi} multi-cidade.`);

  const candTseZone = await prisma.voter.findMany({
    where: { city: null, zone: { not: null } },
    select: { id: true, zone: true, state: true },
  });
  let filledByTseZoneUnique = 0;
  for (const v of candTseZone) {
    const z = normNum(v.zone);
    if (z === null) continue;
    const city = tseZone.map.get(z);
    if (!city) continue;
    await prisma.voter.update({
      where: { id: v.id },
      data: { city, ...(v.state === null ? { state: 'CE' } : {}) },
    });
    filledByTseZoneUnique += 1;
  }
  console.log(`Fase 3b — preenchidos por zona TSE com cidade única: ${filledByTseZoneUnique} (de ${candTseZone.length} candidatos).`);

  // ---------- FASE 4a: zona↔seção trocadas ----------
  // Candidato: city IS NULL + zona+seção presentes. Se o par (zona,seção) é
  // desconhecido mas o par invertido (seção,zona) é conhecido (tabela oficial
  // TRE-CE OU mapa de pares do TSE da fase 3), preenche com a cidade do par
  // invertido. Pares válidos (conhecidos na ordem correta) nunca são tocados —
  // eles já teriam sido preenchidos nas fases 1/3; a checagem abaixo é defesa
  // extra contra sobrescrita.
  const candSwap = await prisma.voter.findMany({
    where: { city: null, zone: { not: null }, section: { not: null } },
    select: { id: true, zone: true, section: true, state: true },
  });
  let filledBySwap = 0;
  for (const v of candSwap) {
    const z = normNum(v.zone);
    const s = normNum(v.section);
    if (z === null || s === null || isGarbageZone(v.zone)) continue;
    const fwd = `${z}-${s}`;
    if (zonaSecaoToLocal.has(fwd) || tsePair.has(fwd)) continue; // par válido: nunca tocar
    const revKey = `${s}-${z}`;
    const revLocal = zonaSecaoToLocal.get(revKey);
    const revCity = revLocal ? revLocal.city : tsePair.get(revKey) || null;
    if (!revCity) continue;
    await prisma.voter.update({
      where: { id: v.id },
      data: { city: revCity, ...(v.state === null ? { state: 'CE' } : {}) },
    });
    filledBySwap += 1;
    console.log(`Fase 4a — id=${v.id} par (${z},${s}) desconhecido; invertido (${s},${z}) → ${revCity}`);
  }
  console.log(`Fase 4a — preenchidos por par invertido (swap): ${filledBySwap} (de ${candSwap.length} candidatos).`);

  // ---------- FASE 4b: predominância por zona ----------
  // Referência: TODOS os eleitores com city preenchida na mesma zona
  // (qualquer seção). Preenche só se uma única cidade detém >=80% dos
  // conhecidos da zona (mín. 2 eleitores) OU todos concordam. Zona "lixo"
  // (título colado) é ignorada — nunca preenche.
  const zoneCityRows = await prisma.$queryRaw`
    SELECT zone, city, count(*)::int AS total
    FROM voters
    WHERE city IS NOT NULL AND zone IS NOT NULL
    GROUP BY zone, city`;
  const zoneCityCounts = new Map(); // zona normalizada -> { total, counts: Map(city->n) }
  for (const r of zoneCityRows) {
    const z = normNum(r.zone);
    if (z === null || isGarbageZone(r.zone) || !r.city) continue;
    if (!zoneCityCounts.has(z)) zoneCityCounts.set(z, { total: 0, counts: new Map() });
    const entry = zoneCityCounts.get(z);
    entry.total += r.total;
    entry.counts.set(r.city, (entry.counts.get(r.city) || 0) + r.total);
  }

  const candZonePred = await prisma.voter.findMany({
    where: { city: null, zone: { not: null } },
    select: { id: true, zone: true, state: true },
  });
  // Decisão por zona (cacheada + logada uma vez por zona).
  const zonePredDecision = new Map(); // zona -> { city, n, pct } | null
  function zonePredominance(z) {
    if (zonePredDecision.has(z)) return zonePredDecision.get(z);
    const entry = zoneCityCounts.get(z);
    let decision = null;
    if (entry && entry.total > 0) {
      const city = mostFrequentCity(entry.counts);
      const n = entry.counts.get(city);
      const pct = n / entry.total;
      if ((entry.total >= 2 && pct >= 0.8) || pct === 1) decision = { city, n, pct, total: entry.total };
    }
    zonePredDecision.set(z, decision);
    return decision;
  }

  let filledByZonePredominance = 0;
  for (const v of candZonePred) {
    const z = normNum(v.zone);
    if (z === null || isGarbageZone(v.zone)) continue;
    const decision = zonePredominance(z);
    if (!decision) continue;
    await prisma.voter.update({
      where: { id: v.id },
      data: { city: decision.city, ...(v.state === null ? { state: 'CE' } : {}) },
    });
    filledByZonePredominance += 1;
  }
  console.log('Fase 4b — decisões por zona (zona, cidade, n, pct dos conhecidos da zona):');
  const loggedZones = new Set();
  for (const v of candZonePred) {
    const z = normNum(v.zone);
    if (z === null || isGarbageZone(v.zone) || loggedZones.has(z)) continue;
    loggedZones.add(z);
    const entry = zoneCityCounts.get(z);
    const decision = zonePredominance(z);
    if (decision) {
      console.log(`  zona=${z} → ${decision.city} n=${decision.n}/${decision.total} (${(decision.pct * 100).toFixed(1)}%) → PREENCHE`);
    } else {
      const detail = entry
        ? `n=${entry.total}, topo=${mostFrequentCity(entry.counts)} (${((entry.counts.get(mostFrequentCity(entry.counts)) || 0) / entry.total * 100).toFixed(1)}%)`
        : 'sem eleitores conhecidos nesta zona';
      console.log(`  zona=${z} → sem preenchimento (${detail})`);
    }
  }
  console.log(`Fase 4b — preenchidos por predominância de zona: ${filledByZonePredominance} (de ${candZonePred.length} candidatos).`);

  // ---------- FASE 4c: bairro fuzzy (linhas não resolvidas com neighborhood) ----------
  const bairroCountsTre = buildBairroCountsFromTre();
  const candBairroFuzzy = await prisma.voter.findMany({
    where: { city: null, neighborhood: { not: null } },
    select: { id: true, zone: true, section: true, neighborhood: true, state: true },
  });
  console.log('Fase 4c — debug: linhas residuais com neighborhood (valores brutos):');
  for (const v of candBairroFuzzy) {
    console.log(`  id=${v.id} bairro="${v.neighborhood}" zona=${v.zone ?? '—'} seção=${v.section ?? '—'} state=${v.state ?? '—'}`);
  }

  let filledByBairroFuzzy = 0;
  for (const v of candBairroFuzzy) {
    const key = normBairro(v.neighborhood);
    if (!key) continue;
    // 1) Match exato normalizado (mesmos mapas da fase 2a).
    let city = bairroTre.get(key) || bairroVot.get(key) || null;
    let via = city ? 'exato' : null;
    // 2) Fuzzy por prefixo seguro: o bairro normalizado é prefixo de chaves da
    //    tabela oficial; preenche SOMENTE se todas as cidades dessas chaves
    //    (prefixo único e não-ambíguo) forem idênticas a UMA cidade.
    if (!city) {
      const prefixCities = new Set();
      for (const [k, counts] of bairroCountsTre) {
        if (k !== key && k.startsWith(key)) {
          for (const c of counts.keys()) prefixCities.add(c);
        }
      }
      if (prefixCities.size === 1) {
        city = [...prefixCities][0];
        via = 'prefixo';
      }
    }
    if (!city) continue;
    await prisma.voter.update({
      where: { id: v.id },
      data: { city, ...(v.state === null ? { state: 'CE' } : {}) },
    });
    filledByBairroFuzzy += 1;
    console.log(`Fase 4c — id=${v.id} bairro="${v.neighborhood}" → ${city} (${via})`);
  }
  console.log(`Fase 4c — preenchidos por bairro fuzzy: ${filledByBairroFuzzy} (de ${candBairroFuzzy.length} candidatos).`);

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
  console.log(`Resumo fase 3: filledByTsePair=${filledByTsePair}, filledByTseZoneUnique=${filledByTseZoneUnique}, stillUnresolved=${still.length}`);
  console.log(`Resumo fase 4: filledBySwap=${filledBySwap}, filledByZonePredominance=${filledByZonePredominance}, filledByBairroFuzzy=${filledByBairroFuzzy}, stillUnresolved=${still.length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());