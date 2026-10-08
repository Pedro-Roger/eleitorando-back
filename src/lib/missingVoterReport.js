function normalizedSection(zone, section) {
  const z = Number.parseInt(String(zone ?? ''), 10);
  const s = Number.parseInt(String(section ?? ''), 10);
  return `${Number.isFinite(z) ? z : ''}\u0000${Number.isFinite(s) ? s : ''}`;
}

function findMissingSections(rows = []) {
  const sections = new Map();
  for (const row of rows) {
    const key = normalizedSection(row.zona, row.secao);
    const current = sections.get(key) || {
      zona: String(row.zona ?? ''),
      secao: String(row.secao ?? ''),
      cadastrados: 0,
      apurado: 0,
    };
    current.cadastrados += Number(row.cadastrados) || 0;
    current.apurado = Math.max(current.apurado, Number(row.apurado) || 0);
    sections.set(key, current);
  }
  return [...sections.values()].filter((row) => row.cadastrados > row.apurado);
}

function buildMissingVoterRows({ voters = [], missingSections = [] }) {
  const sections = new Set(missingSections.map((row) => normalizedSection(row.zona, row.secao)));

  return voters
    .filter((voter) => sections.has(normalizedSection(voter.zone, voter.section)))
    .map((voter) => ({
      name: String(voter.name || '').trim() || 'Sem nome informado',
      phone: String(voter.phone || '').trim() || '—',
      cabo: String(voter.creatorRole || '').toUpperCase() === 'SUBCABO'
        ? String(voter.caboName || '').trim()
        : String(voter.creatorName || '').trim(),
      subcabo: String(voter.creatorRole || '').toUpperCase() === 'SUBCABO'
        ? String(voter.creatorName || '').trim()
        : '',
      zona: String(voter.zone || '').padStart(2, '0'),
      secao: String(voter.section || '').padStart(4, '0'),
    }))
    .sort((a, b) => (
      Number(a.zona) - Number(b.zona)
      || Number(a.secao) - Number(b.secao)
      || a.cabo.localeCompare(b.cabo, 'pt-BR')
      || a.subcabo.localeCompare(b.subcabo, 'pt-BR')
      || a.name.localeCompare(b.name, 'pt-BR')
    ));
}

module.exports = { buildMissingVoterRows, findMissingSections };
