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
  return `${normalized(row.city)}|${numberText(row.zone ?? row.zona, 2)}|${numberText(row.section ?? row.secao, 4)}`;
}

function compareText(a, b) {
  return text(a).localeCompare(text(b), 'pt-BR');
}

function percentage(value, total) {
  return total ? Math.round((value / total) * 1000) / 10 : 0;
}

function byPromised(a, b) {
  return b.prometidos - a.prometidos
    || compareText(a.cabo, b.cabo)
    || compareText(a.subcabo, b.subcabo)
    || compareText(a.city, b.city);
}

function byMissingThenPromised(a, b) {
  return b.faltantes - a.faltantes || byPromised(a, b);
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

function finishGroup(group, auditBySection) {
  const summary = summarize(group.sections);
  const bairros = new Map();
  for (const [key, section] of group.neighborhoodSections) {
    const audit = auditBySection.get(sectionOf(section));
    const detail = {
      ...finishSection(section),
      prometidosGrupo: section.prometidos,
      prometidosSecao: audit?.prometidos ?? section.prometidos,
      apurado: audit?.apurado ?? section.apurado,
      votos: audit?.votos ?? Math.min(section.prometidos, section.apurado),
      faltantes: audit?.faltantes ?? Math.max(section.prometidos - section.apurado, 0),
      percentualVotos: audit?.percentualVotos ?? percentage(Math.min(section.prometidos, section.apurado), section.prometidos),
      percentualFaltantes: audit?.percentualFaltantes ?? percentage(Math.max(section.prometidos - section.apurado, 0), section.prometidos),
      equipes: audit?.teams || [],
      compartilhada: Boolean(audit?.teams?.length > 1),
      compartilhadaEntreCabos: Boolean(audit?.cabos?.length > 1),
      bairrosDaSecao: audit?.bairros || [section.bairro],
    };
    const bairro = bairros.get(normalized(section.bairro)) || {
      bairro: section.bairro,
      prometidos: 0,
      secoes: [],
    };
    bairro.prometidos += section.prometidos;
    bairro.secoes.push(detail);
    bairros.set(normalized(section.bairro), bairro);
  }
  return {
    cabo: group.cabo,
    subcabo: group.subcabo,
    city: group.city,
    ...summary,
    bairros: [...bairros.values()]
      .map((bairro) => ({ ...bairro, secoes: bairro.secoes.sort(byPromised) }))
      .sort(byPromised),
    secoes: [...group.sections.values()].map(finishSection).sort(byPromised),
  };
}

function finishCabo(cabo, auditBySection) {
  const subcabos = [...cabo.subcabos.values()]
    .map((subcabo) => {
      const exclusiveSections = new Map([...subcabo.sections].filter(([key]) => (auditBySection.get(key)?.teams.length || 0) <= 1));
      const totalSummary = summarize(subcabo.sections);
      const exclusiveSummary = summarize(exclusiveSections);
      return {
        cabo: cabo.cabo,
        subcabo: subcabo.subcabo || 'Cadastro direto',
        cidades: [...subcabo.cities].sort(compareText),
        localidades: [...subcabo.localities].sort(compareText),
        ...exclusiveSummary,
        prometidos: totalSummary.prometidos,
        prometidosExclusivos: exclusiveSummary.prometidos,
        secoes: subcabo.sections.size,
        secoesCompartilhadas: [...subcabo.sections.keys()].filter((key) => (auditBySection.get(key)?.teams.length || 0) > 1).length,
      };
    })
    .sort(byPromised);
  const exclusiveSections = new Map([...cabo.sections].filter(([key]) => (auditBySection.get(key)?.cabos.length || 0) <= 1));
  const exclusiveSummary = summarize(exclusiveSections);
  return {
    cabo: cabo.cabo,
    subcabos,
    cidades: [...cabo.cities].sort(compareText),
    localidades: [...cabo.localities].sort(compareText),
    prometidos: summarize(cabo.sections).prometidos,
    apurado: exclusiveSummary.apurado,
    votos: exclusiveSummary.votos,
    faltantes: exclusiveSummary.faltantes,
    percentualVotos: exclusiveSummary.percentualVotos,
    percentualFaltantes: exclusiveSummary.percentualFaltantes,
    prometidosExclusivos: exclusiveSummary.prometidos,
    prometidosCompartilhados: [...cabo.sections].reduce((sum, [key, section]) => (
      sum + ((auditBySection.get(key)?.cabos.length || 0) > 1 ? section.prometidos : 0)
    ), 0),
    secoesCompartilhadas: [...cabo.sections.keys()].filter((key) => (auditBySection.get(key)?.cabos.length || 0) > 1).length,
    secoes: [...cabo.sections].map(([key, section]) => ({
      ...finishSection(section),
      compartilhadaEntreCabos: Boolean(auditBySection.get(key)?.cabos.length > 1),
      equipes: auditBySection.get(key)?.teams || [],
    })).sort(byPromised),
  };
}

function buildHierarchy(groups) {
  const cabos = new Map();
  for (const group of groups) {
    const caboKey = normalized(group.cabo) || 'CADASTRO DIRETO';
    const cabo = cabos.get(caboKey) || { cabo: group.cabo || 'Cadastro direto', prometidos: 0, subcabos: new Map() };
    cabo.prometidos += group.prometidos;
    const subcaboKey = normalized(group.subcabo) || 'CADASTRO DIRETO';
    const subcabo = cabo.subcabos.get(subcaboKey) || { subcabo: group.subcabo || 'Cadastro direto', prometidos: 0, cidades: new Map() };
    subcabo.prometidos += group.prometidos;
    const cityKey = normalized(group.city);
    const city = subcabo.cidades.get(cityKey) || { city: group.city, prometidos: 0, bairros: new Map() };
    city.prometidos += group.prometidos;
    for (const bairro of group.bairros) {
      const bairroKey = normalized(bairro.bairro);
      const neighborhood = city.bairros.get(bairroKey) || { bairro: bairro.bairro, prometidos: 0, secoes: [] };
      neighborhood.prometidos += bairro.prometidos;
      neighborhood.secoes.push(...bairro.secoes);
      city.bairros.set(bairroKey, neighborhood);
    }
    subcabo.cidades.set(cityKey, city);
    cabo.subcabos.set(subcaboKey, subcabo);
    cabos.set(caboKey, cabo);
  }

  const byCount = (a, b) => b.prometidos - a.prometidos || compareText(a.cabo || a.subcabo || a.city || a.bairro, b.cabo || b.subcabo || b.city || b.bairro);
  return [...cabos.values()].map((cabo) => ({
    ...cabo,
    subcabos: [...cabo.subcabos.values()].map((subcabo) => ({
      ...subcabo,
      cidades: [...subcabo.cidades.values()].map((city) => ({
        ...city,
        bairros: [...city.bairros.values()].map((bairro) => ({
          ...bairro,
          secoesComFaltas: bairro.secoes.filter((section) => section.faltantes > 0).sort(byMissingThenPromised),
          demaisSecoes: bairro.secoes.filter((section) => section.faltantes <= 0).sort(byPromised),
          secoes: bairro.secoes.sort(byPromised),
        })).sort(byCount),
      })).sort(byCount),
    })).sort(byCount),
  })).sort(byCount);
}

function buildElectionIntelligenceReport({ voters = [], teamSectionRows, tseRows = [], candidateName = '', filters = {}, year, office, turn }) {
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
      neighborhoodSections: new Map(),
    };
    const groupSection = group.sections.get(sectionKey) || createSection(location, apurado);
    groupSection.prometidos += 1;
    groupSection.apurado = Math.max(groupSection.apurado, apurado);
    groupSection.eleitores.push(text(voter.name) || 'Eleitor sem nome');
    group.sections.set(sectionKey, groupSection);
    const neighborhoodKey = `${sectionKey}|${normalized(bairro)}`;
    const neighborhoodSection = group.neighborhoodSections.get(neighborhoodKey) || createSection(location, apurado);
    neighborhoodSection.prometidos += 1;
    neighborhoodSection.eleitores.push(text(voter.name) || 'Eleitor sem nome');
    group.neighborhoodSections.set(neighborhoodKey, neighborhoodSection);
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

  if (teamSectionRows) {
    const selectedSections = new Set(sectionAudits.keys());
    for (const audit of sectionAudits.values()) {
      audit.prometidos = 0;
      audit.teams.clear();
      audit.bairros.clear();
    }
    for (const row of teamSectionRows) {
      const key = sectionOf(row);
      if (!selectedSections.has(key)) continue;
      const audit = sectionAudits.get(key);
      const team = teamOf(row);
      audit.prometidos += Number(row.prometidos || 0);
      audit.bairros.add(text(row.neighborhood) || 'Bairro não informado');
      audit.teams.set(`${normalized(team.cabo)}\u0000${normalized(team.subcabo)}`, team);
    }
  }

  const sectionAuditRows = [...sectionAudits.values()]
    .map((section) => {
      const votos = Math.min(section.prometidos, section.apurado);
      const faltantes = Math.max(section.prometidos - section.apurado, 0);
      const teams = [...section.teams.values()].sort((a, b) => (
        compareText(a.cabo, b.cabo) || compareText(a.subcabo, b.subcabo)
      ));
      const cabos = [...new Set(teams.map((team) => normalized(team.cabo)))];
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
        teams,
        cabos,
        compartilhada: teams.length > 1,
        compartilhadaEntreCabos: cabos.length > 1,
      };
    })
    .sort((a, b) => compareText(a.city, b.city) || Number(a.zona) - Number(b.zona) || Number(a.secao) - Number(b.secao));
  const auditBySection = new Map(sectionAuditRows.map((section) => [sectionOf(section), section]));

  const detailed = [...groups.values()].map((group) => finishGroup(group, auditBySection)).sort(byPromised);
  const hierarchy = buildHierarchy(detailed);
  const selectedPrometidos = detailed.reduce((sum, group) => sum + group.prometidos, 0);
  const caboRanking = [...cabos.values()].map((cabo) => finishCabo(cabo, auditBySection)).sort(byPromised);
  const subcaboRanking = [...subcabos.values()].map((subcabo) => {
    const exclusiveSections = new Map([...subcabo.sections].filter(([key]) => (auditBySection.get(key)?.teams.length || 0) <= 1));
    const totalSummary = summarize(subcabo.sections);
    const exclusiveSummary = summarize(exclusiveSections);
    return {
      cabo: subcabo.cabo,
      subcabo: subcabo.subcabo || 'Cadastro direto',
      cidades: [...subcabo.cities].sort(compareText),
      localidades: [...subcabo.localities].sort(compareText),
      ...exclusiveSummary,
      prometidos: totalSummary.prometidos,
      prometidosExclusivos: exclusiveSummary.prometidos,
      secoes: subcabo.sections.size,
      secoesCompartilhadas: subcabo.sections.size - exclusiveSections.size,
    };
  }).sort(byPromised);
  const totals = sectionAuditRows.reduce((total, section) => ({
    prometidos: total.prometidos + section.prometidos,
    apurado: total.apurado + section.apurado,
    votos: total.votos + section.votos,
    faltantes: total.faltantes + section.faltantes,
  }), { prometidos: 0, apurado: 0, votos: 0, faltantes: 0 });
  totals.percentualVotos = percentage(totals.votos, totals.prometidos);
  totals.percentualFaltantes = percentage(totals.faltantes, totals.prometidos);
  const sharedSections = sectionAuditRows.filter((section) => section.compartilhadaEntreCabos);

  return {
    candidateName, year, office, turn, filters, detailed, hierarchy, selectedPrometidos,
    cabos: caboRanking, subcabos: subcaboRanking, sharedSections,
    sectionAudits: sectionAuditRows, totals,
  };
}

function buildCaboSummaryModel(report) {
  const caboNames = new Set(report.cabos.map((cabo) => normalized(cabo.cabo)));
  const relevantSections = report.sectionAudits.filter((section) => (
    section.teams.some((team) => caboNames.has(normalized(team.cabo)))
  ));
  return {
    cabos: report.cabos,
    sections: relevantSections.filter((section) => !section.compartilhadaEntreCabos),
    sharedSections: relevantSections.filter((section) => section.compartilhadaEntreCabos),
  };
}

module.exports = { buildElectionIntelligenceReport, buildCaboSummaryModel };
