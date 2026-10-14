function text(value) {
  return String(value || '').trim();
}

function normalized(value) {
  return text(value).toUpperCase();
}

function numberText(value, width) {
  const number = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(number) ? String(number).padStart(width, '0') : '';
}

function teamOf(voter) {
  if (normalized(voter.creatorRole) === 'SUBCABO') {
    return { cabo: text(voter.caboName), subcabo: text(voter.creatorName) };
  }
  return { cabo: text(voter.creatorName), subcabo: '' };
}

function sectionOf(row) {
  return `${normalized(row.city)}|${numberText(row.zone, 2)}|${numberText(row.section, 4)}`;
}

function compareText(a, b) {
  return text(a).localeCompare(text(b), 'pt-BR');
}

function byVotes(a, b) {
  return b.votos - a.votos
    || b.prometidos - a.prometidos
    || compareText(a.cabo, b.cabo)
    || compareText(a.subcabo, b.subcabo);
}

function summarize(sections) {
  const values = [...sections.values()];
  const prometidos = values.reduce((sum, section) => sum + section.prometidos, 0);
  const apurado = values.reduce((sum, section) => sum + section.apurado, 0);
  const votos = values.reduce((sum, section) => sum + Math.min(section.prometidos, section.apurado), 0);
  return { prometidos, apurado, votos, faltantes: Math.max(prometidos - votos, 0) };
}

function buildElectionIntelligenceReport({ voters = [], tseRows = [], candidateName = '' }) {
  const official = new Map();
  for (const row of tseRows) {
    const key = sectionOf(row);
    official.set(key, (official.get(key) || 0) + Number(row.total || row.votes || 0));
  }

  const groups = new Map();
  const caboSections = new Map();
  for (const voter of voters) {
    const zona = numberText(voter.zone, 2);
    const secao = numberText(voter.section, 4);
    if (!zona || !secao) continue;

    const team = teamOf(voter);
    const location = {
      city: text(voter.city),
      bairro: text(voter.neighborhood),
      zona,
      secao,
    };
    const sectionKey = sectionOf(voter);
    const apurado = official.get(sectionKey) || 0;
    const groupKey = `${normalized(team.cabo)}\u0000${normalized(team.subcabo)}`;
    const group = groups.get(groupKey) || {
      cabo: team.cabo,
      subcabo: team.subcabo,
      sections: new Map(),
      eleitores: [],
    };
    const groupSection = group.sections.get(sectionKey) || {
      ...location,
      prometidos: 0,
      apurado,
    };
    groupSection.prometidos += 1;
    groupSection.apurado = Math.max(groupSection.apurado, apurado);
    group.sections.set(sectionKey, groupSection);
    group.eleitores.push({
      name: text(voter.name) || 'Eleitor sem nome',
      phone: text(voter.phone),
      ...location,
    });
    groups.set(groupKey, group);

    const caboKey = normalized(team.cabo);
    const cabo = caboSections.get(caboKey) || { cabo: team.cabo, sections: new Map(), subcabos: new Set(), cities: new Set(), neighborhoods: new Set() };
    const caboSection = cabo.sections.get(sectionKey) || {
      ...location,
      prometidos: 0,
      apurado,
    };
    caboSection.prometidos += 1;
    caboSection.apurado = Math.max(caboSection.apurado, apurado);
    cabo.sections.set(sectionKey, caboSection);
    if (team.subcabo) cabo.subcabos.add(team.subcabo);
    if (location.city) cabo.cities.add(location.city);
    if (location.city || location.bairro) cabo.neighborhoods.add(`${location.city || '—'} / ${location.bairro || '—'}`);
    caboSections.set(caboKey, cabo);
  }

  const detailed = [...groups.values()].map((group) => ({
    cabo: group.cabo,
    subcabo: group.subcabo,
    ...summarize(group.sections),
    eleitores: group.eleitores.sort((a, b) => compareText(a.name, b.name)),
  })).sort(byVotes);

  const cabos = [...caboSections.values()].map((cabo) => ({
    cabo: cabo.cabo,
    subcabos: [...cabo.subcabos].sort(compareText),
    cidades: [...cabo.cities].sort(compareText),
    localidades: [...cabo.neighborhoods].sort(compareText),
    ...summarize(cabo.sections),
  })).sort(byVotes);

  return { candidateName, detailed, cabos };
}

module.exports = { buildElectionIntelligenceReport };
