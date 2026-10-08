function normalizeText(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeNumberText(value, width = 2) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) ? String(parsed).padStart(width, '0') : '';
}

function canonicalNumber(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) ? String(parsed) : '';
}

function displayName(value) {
  return String(value || '').trim();
}

function sectionKey(row) {
  return [
    normalizeText(row.city),
    canonicalNumber(row.zone),
    canonicalNumber(row.section),
  ].join('|');
}

function teamForVoter(voter) {
  if (normalizeText(voter.creatorRole) === 'SUBCABO') {
    return { cabo: displayName(voter.caboName), subcabo: displayName(voter.creatorName) };
  }

  return { cabo: displayName(voter.creatorName), subcabo: '' };
}

function comparisonStatus(diferenca) {
  if (diferenca > 0) return `Faltam ${diferenca} votos`;
  return 'OK';
}

function buildComparisonRows({ voters = [], tseRows = [], candidateName = '' }) {
  const targetCandidate = normalizeText(candidateName);
  const collected = new Map();
  const official = new Map();

  for (const voter of voters) {
    const zona = normalizeNumberText(voter.zone, 2);
    const secao = normalizeNumberText(voter.section, 4);
    if (!zona || !secao) continue;

    const { cabo, subcabo } = teamForVoter(voter);
    const key = `${sectionKey(voter)}|${normalizeText(cabo)}|${normalizeText(subcabo)}`;
    const existing = collected.get(key) || {
      city: normalizeText(voter.city), zona, secao, cabo, subcabo, cadastrados: 0,
    };
    existing.cadastrados += 1;
    collected.set(key, existing);
  }

  for (const tse of tseRows) {
    if (targetCandidate && normalizeText(tse.candidateName) !== targetCandidate) continue;
    const zona = normalizeNumberText(tse.zone, 2);
    const secao = normalizeNumberText(tse.section, 4);
    if (!zona || !secao) continue;

    const key = sectionKey(tse);
    official.set(key, (official.get(key) || 0) + Number(tse.total || tse.votes || 0));
  }

  const collectedSections = new Set([...collected.values()].map((row) => `${row.city}|${canonicalNumber(row.zona)}|${canonicalNumber(row.secao)}`));
  const officialOnlyKeys = [...official.keys()]
    .filter((key) => !collectedSections.has(key))
    .map((key) => `${key}||`);
  const allKeys = new Set([...collected.keys(), ...officialOnlyKeys]);
  const rows = [];

  for (const key of allKeys) {
    const collectedRow = collected.get(key);
    const section = collectedRow || {
      city: key.split('|')[0],
      zona: normalizeNumberText(key.split('|')[1], 2),
      secao: normalizeNumberText(key.split('|')[2], 4),
      cabo: '',
      subcabo: '',
      cadastrados: 0,
    };
    const officialKey = [section.city, canonicalNumber(section.zona), canonicalNumber(section.secao)].join('|');
    const apurado = official.get(officialKey) || 0;
    const diferenca = section.cadastrados - apurado;

    rows.push({
      cabo: section.cabo,
      subcabo: section.subcabo,
      zona: section.zona,
      secao: section.secao,
      cadastrados: section.cadastrados,
      apurado,
      diferenca,
      status: comparisonStatus(diferenca),
    });
  }

  return rows.sort((a, b) => (
    Number(a.zona) - Number(b.zona)
    || Number(a.secao) - Number(b.secao)
    || (a.cabo ? 0 : 1) - (b.cabo ? 0 : 1)
    || a.cabo.localeCompare(b.cabo)
    || a.subcabo.localeCompare(b.subcabo)
  ));
}

module.exports = { buildComparisonRows };
