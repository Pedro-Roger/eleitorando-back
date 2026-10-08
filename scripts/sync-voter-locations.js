const fs = require('node:fs');
const path = require('node:path');
const knex = require('../src/db/knex');

const source = path.join(__dirname, '..', 'src', 'data', 'ce-secoes.json');

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
}

function numberValue(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const valueAsNumber = Number(raw);
  return Number.isInteger(valueAsNumber) ? valueAsNumber : null;
}

function key(zone, section) {
  return `${zone}-${section}`;
}

function loadOfficialLocations() {
  const rows = JSON.parse(fs.readFileSync(source, 'utf8'));
  const locations = new Map();
  const ambiguous = new Set();
  const byCityNeighborhood = new Map();

  for (const row of rows) {
    const zone = numberValue(row.z);
    const section = numberValue(row.s);
    if (zone === null || section === null) continue;
    const location = {
      zone: String(zone),
      section: String(section),
      state: 'CE',
      city: String(row.c || '').trim(),
      neighborhood: String(row.b || '').trim() || null,
    };
    const locationKey = key(zone, section);
    const previous = locations.get(locationKey);
    if (previous && (normalizeText(previous.city) !== normalizeText(location.city)
      || normalizeText(previous.neighborhood) !== normalizeText(location.neighborhood))) {
      ambiguous.add(locationKey);
    } else {
      locations.set(locationKey, location);
    }

    if (location.city && location.neighborhood) {
      const reverseKey = `${normalizeText(location.city)}|${normalizeText(location.neighborhood)}`;
      if (!byCityNeighborhood.has(reverseKey)) byCityNeighborhood.set(reverseKey, new Map());
      byCityNeighborhood.get(reverseKey).set(locationKey, location);
    }
  }

  for (const locationKey of ambiguous) locations.delete(locationKey);
  return { locations, byCityNeighborhood, ambiguous };
}

function resolveVoter(voter, catalog) {
  const zone = numberValue(voter.zone);
  const section = numberValue(voter.section);
  if (zone !== null && section !== null) {
    const location = catalog.locations.get(key(zone, section));
    if (location) return { location, method: 'zona-secao' };
  }

  const reverseKey = `${normalizeText(voter.city)}|${normalizeText(voter.neighborhood)}`;
  const candidates = catalog.byCityNeighborhood.get(reverseKey);
  if (candidates?.size === 1) return { location: [...candidates.values()][0], method: 'cidade-bairro-unico' };
  return { location: null, method: candidates?.size ? 'ambiguous' : 'sem-correspondencia' };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const catalog = loadOfficialLocations();
  const voters = await knex('voters').select('id', 'state', 'city', 'neighborhood', 'zone', 'section');
  const updates = [];
  const unresolved = [];
  const methods = { 'zona-secao': 0, 'cidade-bairro-unico': 0, ambiguous: 0, 'sem-correspondencia': 0 };

  for (const voter of voters) {
    const resolved = resolveVoter(voter, catalog);
    methods[resolved.method] += 1;
    if (!resolved.location) {
      unresolved.push({ id: voter.id, city: voter.city, neighborhood: voter.neighborhood, zone: voter.zone, section: voter.section, reason: resolved.method });
      continue;
    }
    const { location } = resolved;
    if (voter.state !== location.state || voter.city !== location.city || voter.neighborhood !== location.neighborhood
      || voter.zone !== location.zone || voter.section !== location.section) {
      updates.push({ id: voter.id, ...location });
    }
  }

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    total: voters.length,
    updates: updates.length,
    methods,
    unresolved: unresolved.length,
    unresolvedSample: unresolved.slice(0, 20),
    ambiguousOfficialKeys: catalog.ambiguous.size,
  }, null, 2));

  if (apply && updates.length) {
    await knex.transaction(async (trx) => {
      for (const update of updates) {
        await trx('voters').where({ id: update.id }).update({
          state: update.state,
          city: update.city,
          neighborhood: update.neighborhood,
          zone: update.zone,
          section: update.section,
        });
      }
    });
    console.log(`Aplicados ${updates.length} ajustes de localização.`);
  }
  await knex.destroy();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
