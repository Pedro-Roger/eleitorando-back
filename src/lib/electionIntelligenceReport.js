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

function percentage(value, total) {
  return total ? Math.round((value / total) * 1000) / 10 : 0;
}

function byVotes(a, b) {
  return b.votos - a.votos
    || b.prometidos - a.prometidos
    || compareText(a.cabo, b.cabo)
    || compareText(a.subcabo, b.subcabo)
    || compareText(a.city, b.city);
}

function summarize(sections) {
  const values = [...sections.values()];
  const prometidos = values.reduce((sum, section) => sum + section.prometidos, 0);
  const apurado = values.reduce((sum, section) => sum + section.apurado, 0);
  const votos = values.reduce((sum, section) => sum + Math.min(section.prometidos, section.apurado), 0);
  const faltantes = Math.max(prometidos - votos, 0);
  return {
    prometidos,
    apurado,
    votos,
    faltantes,
    percentualVotos: percentage(votos, prometidos),
    percentualFaltantes: percentage(faltantes, prometidos),
  };
}

function finishSection(section) {
  const votos = Math.min(section.prometidos, section.apurado);
  const faltantes = Math.max(section.prometidos - votos, 0);
  return {
    ...section,
    votos,
    faltantes,
    percentualVotos: percentage(votos, section.prometidos),
    percentualFaltantes: percentage(faltantes, section.prometidos),
    eleitores: [...section.eleitores].sort(compareText),
  };
}

function createSection(location, apurado) {
  return { ...location, prometidos: 0, apurado, eleitores: [] };
}

function finishGroup(group) {
  const summary = summarize(group.sections);
  return {
    cabo: group.cabo,
    subcabo: group.subcabo,
    city: group.city,
    ...summary,
    secoes: [...group.sections.values()].map(finishSection).sort(byVotes),
  };
}

function finishCabo(cabo) {
  const subcabos = [...cabo.subcabos.values()]
    .map((subcabo) => ({
      cabo: cabo.cabo,
      subcabo: subcabo.subcabo || 'Cadastro direto',
      cidades: [...subcabo.cities].sort(compareText),
      localidades: [...subcabo.localities].sort(compareText),
      ...summarize(subcabo.sections),
    }))
    .sort(byVotes);
  return {
    cabo: cabo.cabo,
    subcabos,
    cidades: [...cabo.cities].sort(compareText),
    localidades: [...cabo.localities].sort(compareText),
    ...summarize(cabo.sections),
  };
}

function buildElectionIntelligenceReport({ voters = [], tseRows = [], candidateName = '', filters = {}, year, office, turn }) {
  const official = new Map();
  for (const row of tseRows) {
    const key = sectionOf(row);
    official.set(key, (official.get(key) || 0) + Number(row.total || row.votes || 0));
  }

  const groups = new Map();
  const cabos = new Map();
  const subcabos = new Map();
  const sectionAudits = new Map();

  for (const voter of voters) {
    const zona = numberText(voter.zone, 2);
    const secao = numberText(voter.section, 4);
    if (!zona || !secao) continue;

    const team = teamOf(voter);
    const city = text(voter.city) || 'Cidade não informada';
    const bairro = text(voter.neighborhood) || 'Bairro não informado';
    const location = { city, bairro, zona, secao };
    const sectionKey = sectionOf(voter);
    const apurado = official.get(sectionKey) || 0;
    const audit = sectionAudits.get(sectionKey) || {
      city, bairros: new Set(), zona, secao, prometidos: 0, apurado, teams: new Map(),
    };
    audit.prometidos += 1;
    audit.apurado = Math.max(audit.apurado, apurado);
    audit.bairros.add(bairro);
    audit.teams.set(`${normalized(team.cabo)}\u0000${normalized(team.subcabo)}`, team);
    sectionAudits.set(sectionKey, audit);
    const groupKey = `${normalized(team.cabo)}\u0000${normalized(team.subcabo)}\u0000${normalized(city)}`;
    const group = groups.get(groupKey) || {
      cabo: team.cabo,
      subcabo: team.subcabo,
      city,
      sections: new Map(),
    };
    const groupSection = group.sections.get(sectionKey) || createSection(location, apurado);
    groupSection.prometidos += 1;
    groupSection.apurado = Math.max(groupSection.apurado, apurado);
    groupSection.eleitores.push(text(voter.name) || 'Eleitor sem nome');
    group.sections.set(sectionKey, groupSection);
    groups.set(groupKey, group);

    const caboKey = normalized(team.cabo);
    const cabo = cabos.get(caboKey) || {
      cabo: team.cabo, sections: new Map(), subcabos: new Map(), cities: new Set(), localities: new Set(),
    };
    const caboSection = cabo.sections.get(sectionKey) || createSection(location, apurado);
    caboSection.prometidos += 1;
    caboSection.apurado = Math.max(caboSection.apurado, apurado);
    cabo.sections.set(sectionKey, caboSection);
    cabo.cities.add(city);
    cabo.localities.add(`${city} / ${bairro}`);

    const subcaboKey = normalized(team.subcabo);
    const subcabo = cabo.subcabos.get(subcaboKey) || {
      subcabo: team.subcabo,
      sections: new Map(),
      cities: new Set(),
      localities: new Set(),
    };
    const subcaboSection = subcabo.sections.get(sectionKey) || createSection(location, apurado);
    subcaboSection.prometidos += 1;
    subcaboSection.apurado = Math.max(subcaboSection.apurado, apurado);
    subcabo.sections.set(sectionKey, subcaboSection);
    subcabo.cities.add(city);
    subcabo.localities.add(`${city} / ${bairro}`);
    cabo.subcabos.set(subcaboKey, subcabo);
    cabos.set(caboKey, cabo);

    const flatSubcaboKey = `${caboKey}\u0000${subcaboKey}`;
    subcabos.set(flatSubcaboKey, { cabo: cabo.cabo, ...subcabo });
  }

  if (!filters.cabo && !filters.subcabo) {
    for (const row of tseRows) {
      const key = sectionOf(row);
      if (sectionAudits.has(key)) continue;
      const zona = numberText(row.zone, 2);
      const secao = numberText(row.section, 4);
      if (!zona || !secao) continue;
      sectionAudits.set(key, {
        city: text(row.city) || 'Cidade não informada',
        bairros: new Set(),
        zona,
        secao,
        prometidos: 0,
        apurado: official.get(key) || 0,
        teams: new Map(),
      });
    }
  }

  const detailed = [...groups.values()].map(finishGroup).sort(byVotes);
  const caboRanking = [...cabos.values()].map(finishCabo).sort(byVotes);
  const subcaboRanking = [...subcabos.values()].map((subcabo) => ({
    cabo: subcabo.cabo,
    subcabo: subcabo.subcabo || 'Cadastro direto',
    cidades: [...subcabo.cities].sort(compareText),
    localidades: [...subcabo.localities].sort(compareText),
    ...summarize(subcabo.sections),
  })).sort(byVotes);

  const sectionAuditRows = [...sectionAudits.values()]
    .map((section) => {
      const votos = Math.min(section.prometidos, section.apurado);
      const faltantes = Math.max(section.prometidos - section.apurado, 0);
      return {
        city: section.city,
        bairros: [...section.bairros].sort(compareText),
        zona: section.zona,
        secao: section.secao,
        prometidos: section.prometidos,
        apurado: section.apurado,
        votos,
        faltantes,
        percentualVotos: percentage(votos, section.prometidos),
        percentualFaltantes: percentage(faltantes, section.prometidos),
        teams: [...section.teams.values()].sort((a, b) => (
          compareText(a.cabo, b.cabo) || compareText(a.subcabo, b.subcabo)
        )),
      };
    })
    .sort((a, b) => (
      compareText(a.city, b.city)
      || Number(a.zona) - Number(b.zona)
      || Number(a.secao) - Number(b.secao)
    ));
  const totals = sectionAuditRows.reduce((total, section) => ({
    prometidos: total.prometidos + section.prometidos,
    apurado: total.apurado + section.apurado,
    votos: total.votos + section.votos,
    faltantes: total.faltantes + section.faltantes,
  }), { prometidos: 0, apurado: 0, votos: 0, faltantes: 0 });
  totals.percentualVotos = percentage(totals.votos, totals.prometidos);
  totals.percentualFaltantes = percentage(totals.faltantes, totals.prometidos);

  return {
    candidateName, year, office, turn, filters, detailed,
    cabos: caboRanking, subcabos: subcaboRanking,
    sectionAudits: sectionAuditRows, totals,
  };
}

module.exports = { buildElectionIntelligenceReport };
