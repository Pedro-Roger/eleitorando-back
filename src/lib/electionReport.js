function reportTeam(row) {
  return { cabo: String(row.cabo || '').trim(), subcabo: String(row.subcabo || '').trim() };
}

function teamKey(team) {
  return `${team.cabo}\u0000${team.subcabo}`;
}

function sectionKey(row) {
  return `${row.zona}\u0000${row.secao}`;
}

function compareNames(a, b) {
  return String(a || '').localeCompare(String(b || ''), 'pt-BR');
}

function buildElectionReport({ candidateName, comparisonRows = [] }) {
  const summaryMap = new Map();
  const sectionMap = new Map();

  for (const row of comparisonRows) {
    const team = reportTeam(row);
    const key = teamKey(team);
    const summary = summaryMap.get(key) || { ...team, cadastrados: 0, sections: new Set() };
    summary.cadastrados += Number(row.cadastrados) || 0;
    summary.sections.add(sectionKey(row));
    summaryMap.set(key, summary);

    const section = sectionMap.get(sectionKey(row)) || {
      zona: row.zona,
      secao: row.secao,
      cadastrados: 0,
      apurado: 0,
    };
    section.cadastrados += Number(row.cadastrados) || 0;
    // O apurado é o mesmo por zona/seção em todas as equipes: nunca somar duplicado.
    section.apurado = Math.max(section.apurado, Number(row.apurado) || 0);
    sectionMap.set(sectionKey(row), section);
  }

  const summary = [...summaryMap.values()]
    .map(({ sections, ...row }) => ({ ...row, secoes: sections.size }))
    .sort((a, b) => (
      compareNames(a.cabo, b.cabo)
      || (a.subcabo ? 0 : 1) - (b.subcabo ? 0 : 1)
      || compareNames(a.subcabo, b.subcabo)
    ));

  const missing = [...sectionMap.values()]
    .map((row) => ({ ...row, faltantes: Math.max(row.apurado - row.cadastrados, 0) }))
    .filter((row) => row.faltantes > 0)
    .sort((a, b) => Number(a.zona) - Number(b.zona) || Number(a.secao) - Number(b.secao));

  return {
    candidateName,
    summary,
    missing,
    totalCadastrados: summary.reduce((total, row) => total + row.cadastrados, 0),
    totalApurado: missing.reduce((total, row) => total + row.apurado, 0),
    totalFaltantes: missing.reduce((total, row) => total + row.faltantes, 0),
  };
}

module.exports = { buildElectionReport };
