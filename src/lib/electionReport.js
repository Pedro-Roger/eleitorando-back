function teamKey(cabo, subcabo) {
  return `${cabo}\u0000${subcabo}`;
}

function sectionKey(row) {
  return `${String(row.city || '').trim().toLocaleUpperCase('pt-BR')}\u0000${row.zona}\u0000${row.secao}`;
}

function compareNames(a, b) {
  return String(a || '').localeCompare(String(b || ''), 'pt-BR');
}

function buildElectionReport({ candidateName, year, office, turn, filters = {}, comparisonRows, rows = [] }) {
  const sourceRows = comparisonRows || rows;
  const teams = new Map();
  const sections = new Map();

  for (const row of sourceRows) {
    const cabo = String(row.cabo || '').trim();
    const subcabo = String(row.subcabo || '').trim();
    const key = sectionKey(row);
    const cadastrados = Number(row.cadastrados) || 0;
    const apurado = Number(row.apurado) || 0;
    const teamId = teamKey(cabo, subcabo);
    const team = teams.get(teamId) || {
      cabo,
      subcabo,
      cadastrados: 0,
      sections: new Set(),
    };
    team.cadastrados += cadastrados;
    team.sections.add(key);
    teams.set(teamId, team);

    const section = sections.get(key) || {
      ...(row.city ? { city: row.city } : {}),
      zona: row.zona,
      secao: row.secao,
      cadastrados: 0,
      apurado: 0,
      teams: new Map(),
    };
    section.cadastrados += cadastrados;
    section.apurado = Math.max(section.apurado, apurado);
    section.teams.set(teamId, { cabo, subcabo });
    sections.set(key, section);
  }

  const sectionDetails = [...sections.values()]
    .map((section) => {
      const confirmados = Math.min(section.cadastrados, section.apurado);
      const faltantes = Math.max(section.cadastrados - section.apurado, 0);
      const { teams: sectionTeams, ...detail } = section;
      return {
        ...detail,
        confirmados,
        faltantes,
        percentualFaltantes: section.cadastrados
          ? Math.round((faltantes / section.cadastrados) * 100)
          : 0,
        teams: [...sectionTeams.values()].sort((a, b) => (
          compareNames(a.cabo, b.cabo) || compareNames(a.subcabo, b.subcabo)
        )),
      };
    })
    .sort((a, b) => (
      compareNames(a.city, b.city)
      || Number(a.zona) - Number(b.zona)
      || Number(a.secao) - Number(b.secao)
    ));

  const missingKeys = new Set(sectionDetails
    .filter((section) => section.faltantes > 0)
    .map((section) => sectionKey(section)));
  const summary = [...teams.values()]
    .map(({ sections: teamSections, ...team }) => ({
      ...team,
      secoes: teamSections.size,
      secoesComFaltantes: [...teamSections].filter((key) => missingKeys.has(key)).length,
    }))
    .sort((a, b) => (
      compareNames(a.cabo, b.cabo)
      || (a.subcabo ? 0 : 1) - (b.subcabo ? 0 : 1)
      || compareNames(a.subcabo, b.subcabo)
    ));

  return {
    candidateName,
    year,
    office,
    turn,
    filters,
    summary,
    details: sectionDetails,
    missing: sectionDetails.filter((section) => section.faltantes > 0),
    totalCadastrados: sectionDetails.reduce((total, section) => total + section.cadastrados, 0),
    totalConfirmados: sectionDetails.reduce((total, section) => total + section.confirmados, 0),
    totalApurado: sectionDetails.reduce((total, section) => total + section.apurado, 0),
    totalFaltantes: sectionDetails.reduce((total, section) => total + section.faltantes, 0),
  };
}

module.exports = { buildElectionReport };
